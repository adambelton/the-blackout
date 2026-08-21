/**
 * Sportmonks-event arrival orchestrator.
 *
 * Given a raw Sportmonks event payload, drives the canonical-↔-commentary
 * correlation pipeline:
 *
 *   1. Drain the distillation buffer so any commentary leading up to
 *      the event lands in the correlator BEFORE this canonical does.
 *      Without the pre-flush, a goal arrives before its build-up
 *      texture and the texture has no canonical to attach to.
 *   2. Build a CanonicalEventEntry from the payload (returns null when
 *      the event isn't correlatable — missing minute, etc).
 *   3. Append to the canonical ledger.
 *   4. Run resolveCanonical against the pending texture/claim ledgers.
 *   5. Push every matched texture release as match_action with the
 *      canonical's eventId set as `parentSourceId`. Pushed BEFORE the
 *      canonical itself so the consumer's UI can render the linkage.
 *   6. Drop matched textures + the matched claim from the pending
 *      ledgers (returned in the new state).
 *   7. Emit a calibration sample when a claim matched.
 *   8. Push the canonical itself as match_events, after passing the
 *      payload through the caller's name normaliser.
 *
 * Pure orchestrator — all I/O happens through injected dependencies.
 * Tests pin the order-and-shape contract by recording calls into the
 * dep stubs and asserting on the sequence.
 */

import { SOURCE } from "@blackout/shared";
import {
  isEventClass,
  resolveCanonical,
  type CanonicalEventEntry,
  type EventClass,
  type PendingClaim,
  type PendingTexture,
} from "./event-correlation.js";

export interface CanonicalIngestState {
  canonicalLedger: CanonicalEventEntry[];
  pendingClaims: PendingClaim[];
  pendingTextures: PendingTexture[];
}

export interface CalibrationSampleArgs {
  eventClass: EventClass;
  rawDeltaSeconds: number;
  canonicalEventId: string;
  canonicalSubjectTime: string;
  canonicalPlayer: string | null;
}

export interface CanonicalIngestDeps {
  /** Drain any buffered commentary into the correlator before the
   * canonical lands. Errors are swallowed with a warn — a flush
   * failure must not block ingestion. */
  flushDistiller: () => Promise<void>;
  /** Build a CanonicalEventEntry from the raw payload, or null when
   * the event isn't correlatable (e.g. no minute on the row). */
  buildCanonical: (
    data: Record<string, unknown>,
    eventClass: EventClass,
  ) => CanonicalEventEntry | null;
  /** Push a source entry to the consumer (Kairos). Records calls; the
   * runner's pushEntry handles phase gating + content-time stamping. */
  pushEntry: (
    source: string,
    data: Record<string, unknown>,
    atWallClockMs?: number,
  ) => void;
  /** Emit a calibration sample when a pending claim matched. */
  emitCalibrationSample: (args: CalibrationSampleArgs) => void;
  /** Normalise name-bearing fields on the canonical payload before
   * push (roster reconciliation). */
  normaliseEventNames: (data: Record<string, unknown>) => Record<string, unknown>;
  // `matchEventsSourceName` / `matchActionSourceName` were passed as
  // deps but always carried `SOURCE.matchEvents` / `SOURCE.matchAction`.
  // Removed in favour of importing SOURCE directly — the function
  // already lives in apps/blackout/server, the SOURCE constant is the canonical
  // accessor (audit 2026-05-10).
}

export function eventClassFromPayload(
  data: Record<string, unknown>,
): EventClass | null {
  const type = typeof data.eventType === "string" ? data.eventType : null;
  if (!type) return null;
  if (isEventClass(type)) return type;
  return null;
}

export async function ingestCanonicalEvent(
  data: Record<string, unknown>,
  state: CanonicalIngestState,
  deps: CanonicalIngestDeps,
): Promise<CanonicalIngestState> {
  try {
    await deps.flushDistiller();
  } catch (err) {
    console.warn(
      `[canonical-ingest] pre-event flush failed: ${(err as Error).message}`,
    );
  }

  let canonicalLedger = state.canonicalLedger;
  let pendingClaims = state.pendingClaims;
  let pendingTextures = state.pendingTextures;

  const eventClass = eventClassFromPayload(data);
  if (eventClass) {
    const canonical = deps.buildCanonical(data, eventClass);
    if (canonical) {
      canonicalLedger = [...canonicalLedger, canonical];

      const result = resolveCanonical(canonical, pendingClaims, pendingTextures);

      for (const release of result.textureReleases) {
        deps.pushEntry(
          SOURCE.matchAction,
          {
            kind: "event_texture",
            content: release.content,
            eventClass: release.eventClass,
            parentSourceId: release.parentSourceId,
          },
          release.observedAtMs,
        );
      }

      if (result.matchedTextureIds.length > 0) {
        const matched = new Set(result.matchedTextureIds);
        pendingTextures = pendingTextures.filter((t) => !matched.has(t.textureId));
      }
      if (result.matchedClaimId) {
        pendingClaims = pendingClaims.filter(
          (c) => c.claimId !== result.matchedClaimId,
        );
      }
      if (result.sample) {
        deps.emitCalibrationSample({
          eventClass: result.sample.eventClass,
          rawDeltaSeconds: result.sample.rawDeltaSeconds,
          canonicalEventId: result.sample.canonicalEventId,
          canonicalSubjectTime: canonical.subjectTime,
          canonicalPlayer: canonical.playerLastName,
        });
      }
    }
  }

  deps.pushEntry(SOURCE.matchEvents, deps.normaliseEventNames(data));

  return { canonicalLedger, pendingClaims, pendingTextures };
}
