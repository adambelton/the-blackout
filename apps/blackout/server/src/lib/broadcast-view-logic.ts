import type { Broadcast, BroadcastPhase } from "@blackout/shared";

/**
 * Pure-logic slices of buildBroadcastView — extracted so they can be
 * unit-tested without pulling the DB or Kairos client into the import
 * chain. Kept intentionally small: if something needs I/O, it stays
 * in broadcast-view.ts alongside the orchestration.
 *
 * Match-time parsing + ordering moved to `@blackout/shared/types/match-time`
 * — the matchroom client uses the same functions to render the event
 * ribbon, and the two MUST agree.
 */

export { parseMatchTime, compareEventsByMatchTime } from "@blackout/shared";

export function inferPhaseFromStatus(b: Broadcast): BroadcastPhase {
  if (b.status === "complete") return "complete";
  if (b.status === "live") return "warming";
  return "pre_ramp";
}

/**
 * Reveal-gate computation — the pure core of buildBroadcastView's
 * state reconstruction. Returns the set of feed entry ids that
 * should be HIDDEN from the matchroom right now: those listed in
 * `covers` of any narration whose audio is still playing at
 * `nowMs`.
 *
 * Contract: events are visible by default. The only reason to hide
 * a canonical event card is that a narration currently mid-flight
 * is about to (or just did) speak that event — revealing the card
 * before the narrator says the words spoils the moment. Once the
 * narration ends (or if no in-flight narration covers the event),
 * the card is shown.
 *
 * This is the inverse of the earlier opt-in approach (revealing
 * only events in `batchEntryIds` of FINISHED narrations), which
 * left late-joiners with a sparse matchroom — events that
 * happened but were never narrated about stayed permanently hidden,
 * which contradicts the audio-is-canonical reveal principle for
 * any audience joining late.
 */
export function computeGuardedEntryIds(
  narrations: Array<{
    playbackStartedAt: Date | null;
    durationMs: number;
    covers: { entryId: string }[];
  }>,
  nowMs: number,
): Set<string> {
  const ids = new Set<string>();
  for (const n of narrations) {
    if (!n.playbackStartedAt) continue;
    const endedMs = n.playbackStartedAt.getTime() + n.durationMs;
    if (endedMs <= nowMs) continue; // narration finished — its covers are no longer guarded
    for (const c of n.covers) ids.add(c.entryId);
  }
  return ids;
}
