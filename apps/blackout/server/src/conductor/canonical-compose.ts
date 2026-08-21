/**
 * Conductor-side composition for the matchroom canonical-state
 * bundle (Design A — `docs/matchroom-reveal-architecture-scoping.md`).
 *
 * Two layers:
 *
 *   1. `toCanonicalEvent` — projects a Kairos `match_events` entry
 *      into the matchroom-shaped `CanonicalEvent`. Drops noise types
 *      (pressure / zone signals) and non-event sources. Mirrors
 *      `toViewerEntry` in matchroom-transform.ts but produces the
 *      narrower CanonicalEvent (no `content`, no `timestamp`, strict
 *      eventType union).
 *
 *   2. `composePassageBundle` — at narrative-compose time, builds
 *      this passage's `revealedCanonical` (snapshot of running state)
 *      and `revealingCanonical` (the deltas this passage will reveal
 *      during its audio). The conductor then folds the revealing
 *      forward into running state via `applyRevealingCanonical` so
 *      the next passage's revealedCanonical is correct (the chain
 *      invariant).
 *
 * Phase and illustration deltas land in later sub-pieces (2 + 3).
 * Until then, this composer emits only event deltas; phase + contentMinute
 * snapshot directly from the conductor's current state.
 */

import type {
  BroadcastPhase,
  CanonicalEvent,
  CanonicalEventType,
  CanonicalState,
  GameplayTransitionEventType,
  RevealingCanonical,
  RevealingMarker,
  TeamSide,
} from "@blackout/shared";
import { parseMatchTime, SOURCE } from "@blackout/shared";
import type { KairosFeedEntry } from "../lib/kairos.js";
import { PHASE_FOR_TRANSITION_EVENT } from "./phase-logic.js";

const NON_VIEWER_EVENT_TYPES = new Set([
  "PRESSURE_UPDATE",
  "ZONE_ENTRY",
  "ZONE_MIDDLE",
]);

/**
 * Project a Kairos match_events entry into a CanonicalEvent. Returns
 * null for non-match_events sources, missing eventType, or operator-
 * only signal types the matchroom shouldn't render.
 */
export function toCanonicalEvent(entry: KairosFeedEntry): CanonicalEvent | null {
  const sourceName =
    (entry as unknown as { sourceName?: string; source?: string }).sourceName ??
    entry.source;
  if (sourceName !== SOURCE.matchEvents) return null;

  const d = entry.data as Record<string, unknown>;
  const eventType = (d.eventType ?? d.timelineType) as string | undefined;
  if (!eventType) return null;
  if (NON_VIEWER_EVENT_TYPES.has(eventType)) return null;

  const minute = typeof d.minute === "number" ? d.minute : null;
  const extraMinute = typeof d.extraMinute === "number" ? d.extraMinute : null;
  // Read Kairos's `subjectTime` (input vocabulary) and write `contentTime`
  // on the outbound CanonicalEvent (consumer vocabulary). The transformation
  // happens at the seam — see `docs/vocabulary.md` § Time.
  const contentTime = typeof d.subjectTime === "string" ? d.subjectTime : undefined;

  const t = d.team as { side?: TeamSide; name?: string } | TeamSide | null | undefined;
  const team: TeamSide | null = typeof t === "string" ? t : t?.side ?? null;
  const teamName =
    typeof t === "object" && t ? t.name ?? null : (typeof d.teamName === "string" ? d.teamName : null);
  const player = typeof d.player === "string" ? d.player : null;
  const relatedPlayer = typeof d.relatedPlayer === "string" ? d.relatedPlayer : null;

  return {
    id: entry.id,
    eventType: eventType as CanonicalEventType,
    player,
    relatedPlayer,
    team,
    teamName,
    contentTime,
    minute,
    extraMinute,
    isGoal: eventType === "GOAL",
  };
}

/**
 * Pick the contentMinute string for this passage — the earliest
 * subject time among the cycle's batch entries (read from Kairos's
 * feed entries, where the field is `subjectTime`). The narrator is
 * beginning from this minute; the composer rebrands it as content
 * minute for the consumer. Returns null when no batch entry carries
 * a parseable subjectTime (pre-match, ambient-only cycles).
 *
 * `monotonicFloor` clamps the result so the matchroom clock can't go
 * backwards. A late-arriving entry from an earlier phase (delayed
 * distillation, moderator catch-up) would otherwise pull this passage's
 * contentMinute below the previous passage's, which the matchroom
 * faithfully renders as a regression. Mirror of Kairos's
 * `clampMonotonicMinute` (`apps/kairos/server/src/narrative/helpers.ts`) on
 * the server-side bundle composer — both must clamp because the legacy
 * `play.contentTime` (Kairos-clamped, numeric) and the bundle's
 * `revealedCanonical.contentMinute` (server-composed, string) are
 * separate paths emitting the same value.
 */
export function composeContentMinute(
  batchEntryIds: string[],
  entryCache: Map<string, KairosFeedEntry>,
  monotonicFloor: string | null = null,
): string | null {
  let earliest: { rank: number; contentTime: string } | null = null;
  for (const id of batchEntryIds) {
    const entry = entryCache.get(id);
    if (!entry) continue;
    const ct = (entry.data as Record<string, unknown> | null | undefined)?.subjectTime;
    if (typeof ct !== "string" || ct.length === 0) continue;
    const rank = parseMatchTime(ct);
    if (rank === -Infinity) continue;
    if (earliest === null || rank < earliest.rank) {
      earliest = { rank, contentTime: ct };
    }
  }
  if (earliest === null) return null;
  if (monotonicFloor === null) return earliest.contentTime;
  const floorRank = parseMatchTime(monotonicFloor);
  if (floorRank === -Infinity) return earliest.contentTime;
  return earliest.rank < floorRank ? monotonicFloor : earliest.contentTime;
}

/**
 * Build the per-passage revealing-canonical from a Kairos narrative's
 * covers + batch.
 *
 *   - Each cover with a `charOffset` becomes an event marker at that
 *     offset (early reveal — fires during audio playback when the
 *     marker is crossed).
 *   - Each cover WITHOUT a charOffset becomes an event marker with
 *     no offset (audio-end fallback).
 *   - Each batchEntryId NOT in covers becomes an event marker with
 *     no offset (audio-end fallback) — preserves today's "in batch
 *     but not cited" reveal contract.
 *
 * Entries not present in the cache, non-match_events sources, and
 * matchroom-noise types (pressure/zone) are silently dropped.
 */
export function composeRevealingCanonical(input: {
  covers: Array<{ entryId: string; charOffset?: number }>;
  batchEntryIds: string[];
  entryCache: Map<string, KairosFeedEntry>;
}): RevealingCanonical {
  const { covers, batchEntryIds, entryCache } = input;
  const markers: RevealingMarker<CanonicalEvent>[] = [];
  const seen = new Set<string>();

  for (const cover of covers) {
    if (seen.has(cover.entryId)) continue;
    const entry = entryCache.get(cover.entryId);
    if (!entry) continue;
    const ce = toCanonicalEvent(entry);
    if (!ce) continue;
    seen.add(cover.entryId);
    markers.push(
      cover.charOffset != null
        ? { value: ce, charOffset: cover.charOffset }
        : { value: ce },
    );
  }

  for (const id of batchEntryIds) {
    if (seen.has(id)) continue;
    const entry = entryCache.get(id);
    if (!entry) continue;
    const ce = toCanonicalEvent(entry);
    if (!ce) continue;
    seen.add(id);
    markers.push({ value: ce });
  }

  return markers.length > 0 ? { events: markers } : {};
}

/**
 * Find the phase-transition cover that anchors a phase reveal in
 * this passage's prose. Walks the cover list looking for a synthetic
 * `match_events` entry whose `eventType` maps via
 * `PHASE_FOR_TRANSITION_EVENT` to the target phase. Returns the
 * cover's charOffset if a match is found (with anchor — early
 * reveal); returns `null` if no match is found (the caller decides
 * whether to emit a no-charOffset audio-end fallback marker).
 */
function findPhaseTransitionCharOffset(
  targetPhase: BroadcastPhase,
  covers: Array<{ entryId: string; charOffset?: number }>,
  entryCache: Map<string, KairosFeedEntry>,
): number | null | undefined {
  for (const cover of covers) {
    const entry = entryCache.get(cover.entryId);
    if (!entry) continue;
    const data = entry.data as Record<string, unknown> | null | undefined;
    if (data?.synthetic !== true) continue;
    const eventType = data.eventType;
    if (typeof eventType !== "string") continue;
    const mappedPhase = PHASE_FOR_TRANSITION_EVENT[eventType as GameplayTransitionEventType];
    if (mappedPhase === targetPhase) {
      // Cover present. charOffset may itself be undefined (no anchor)
      // — return it as-is so the caller still emits a marker, just
      // without an audio-time anchor.
      return cover.charOffset ?? null;
    }
  }
  return undefined;
}

/**
 * Compose the full per-passage bundle: revealedCanonical
 * (snapshot of running state at audio-start) + revealingCanonical
 * (deltas this passage will reveal during audio).
 *
 * Phase handling:
 *
 *   - `revealedCanonical.phase` sources from `runningCanonical.phase`
 *     — the phase the listener is in at audio-start of THIS passage
 *     (not yet flipped by anything in this passage's prose).
 *   - `revealingCanonical.phase` is set when the conductor's FSM
 *     phase has advanced past `runningCanonical.phase`. The marker's
 *     charOffset comes from the cover for the synthetic phase-
 *     transition entry the prose cites (e.g. the FULL_TIME synthetic
 *     in the closing-cycle's covers); falls back to audio-end if
 *     the cover wasn't included.
 *
 * The conductor's `this.phase` advances on observation of the
 * synthetic entry (driving side-effects like the closing-cycle
 * trigger, decideClipEndAction, decideSourcePushAllowed).
 * `runningCanonical.phase` lags until the next bundle compose
 * applies the revealing forward — that's how the listener's view
 * stays anchored to audio playback rather than wall-clock.
 */
export function composePassageBundle(input: {
  runningCanonical: CanonicalState;
  /** Conductor FSM's current phase. Differs from
   * `runningCanonical.phase` immediately after a phase transition is
   * observed; the revealing marker is what bridges the gap during
   * the next passage's audio. */
  phase: BroadcastPhase;
  covers: Array<{ entryId: string; charOffset?: number }>;
  batchEntryIds: string[];
  entryCache: Map<string, KairosFeedEntry>;
  /** Last contentMinute emitted on a prior passage's bundle. Threaded
   * through to `composeContentMinute` as the monotonic floor so the
   * matchroom clock never displays a regression. Conductor maintains
   * this state across passages; null on the very first composed
   * bundle of a broadcast (or after a fresh recovery). */
  lastEmittedContentMinute?: string | null;
}): {
  revealedCanonical: CanonicalState;
  revealingCanonical: RevealingCanonical;
} {
  const eventsRevealing = composeRevealingCanonical({
    covers: input.covers,
    batchEntryIds: input.batchEntryIds,
    entryCache: input.entryCache,
  });

  let phaseMarker: RevealingMarker<BroadcastPhase> | undefined;
  if (input.runningCanonical.phase !== input.phase) {
    const charOffset = findPhaseTransitionCharOffset(
      input.phase,
      input.covers,
      input.entryCache,
    );
    if (charOffset === undefined) {
      // No cover for the synthetic phase entry — the LLM didn't cite
      // it. Emit an audio-end fallback so the listener's phase
      // advances when this passage finishes, rather than never.
      phaseMarker = { value: input.phase };
    } else if (charOffset === null) {
      // Cover present but no charOffset on it — audio-end fallback
      // (matches the `RevealingMarker` "no charOffset" semantic).
      phaseMarker = { value: input.phase };
    } else {
      phaseMarker = { value: input.phase, charOffset };
    }
  }

  const revealingCanonical: RevealingCanonical = {
    ...eventsRevealing,
    ...(phaseMarker ? { phase: phaseMarker } : {}),
  };

  const contentMinute = composeContentMinute(
    input.batchEntryIds,
    input.entryCache,
    input.lastEmittedContentMinute ?? null,
  );

  const revealedCanonical: CanonicalState = {
    ...input.runningCanonical,
    contentMinute,
  };

  return { revealedCanonical, revealingCanonical };
}
