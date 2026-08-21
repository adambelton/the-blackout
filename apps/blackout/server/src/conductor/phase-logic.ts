import { CLOSING_CYCLE_PROMPT } from "../lib/defaults.js";
import type {
  BroadcastPhase,
  GameplayTransitionEventType,
} from "./types.js";

/**
 * Pure phase-logic helpers for the RoomConductor. Extracted so the
 * decision surface can be tested without instantiating a real
 * conductor (which drags in Kairos clients, DB, storage, WS).
 *
 * Kept in lock-step with the maps/constants in RoomConductor.ts —
 * that file is the runtime call site; this file is the single
 * source of truth for the rules.
 */

/** Map of feed-entry `data.phase` strings to the BroadcastPhase
 * state. The conductor uses this to drive phase transitions when
 * the Sportmonks source callback path isn't live (replay, smoke
 * test). Monotonic: the decision helpers never transition
 * backwards. Entries with phases not in this map are ignored. */
export const DATA_PHASE_TO_BROADCAST_PHASE: Record<string, BroadcastPhase> = {
  first_half: "live_first_half",
  halftime: "halftime",
  second_half: "live_second_half",
  full_time: "full_time_winddown",
};

/** Phase progression used to reject backward transitions when
 * observing `data.phase` on entries. */
export const PHASE_ORDINAL: Record<BroadcastPhase, number> = {
  pre_ramp: 0,
  warming: 1,
  live_first_half: 2,
  halftime: 3,
  live_second_half: 4,
  full_time_winddown: 5,
  complete: 6,
};

export interface GameplayTransition {
  eventType: GameplayTransitionEventType;
  content: string;
  subjectTime: string;
  phase: string;
  /** Content seconds the consumer wants Kairos to extend the next
   * cycle's drain boundary by past this entry's ordinal. Set on
   * closure-shaped transitions (HALFTIME, FULL_TIME) where post-
   * whistle texture should land in the closing cycle rather than
   * the next one. Omitted for KICKOFF / SECOND_HALF_KICKOFF — those
   * are starting moments, not closure beats. */
  closingExtensionSeconds?: number;
  /** Optional prompt text Kairos splices into the closing cycle's
   * generator call. Frames the cycle's prose ("narrate the dying
   * moments chronologically; whistle as the final beat") so the
   * cadence cycle that captures the whistle reads like a closing
   * beat instead of a regular cadence cycle. Paired with
   * `closingExtensionSeconds`. */
  closingPrompt?: string;
}

/** Reverse mapping: a transition entry's `eventType` → the
 * BroadcastPhase that transition represents. Used at conductor startup
 * to recover the current phase from the broadcast's existing transition
 * entries instead of restarting at `warming` and re-pushing every
 * transition as the feed syncs on connect. */
export const PHASE_FOR_TRANSITION_EVENT: Record<
  "KICKOFF" | "HALFTIME" | "SECOND_HALF_KICKOFF" | "FULL_TIME",
  BroadcastPhase
> = {
  KICKOFF: "live_first_half",
  HALFTIME: "halftime",
  SECOND_HALF_KICKOFF: "live_second_half",
  FULL_TIME: "full_time_winddown",
};

/** Gameplay-state transitions get pushed to Kairos as synthetic
 * match_events entries by the runner on each Sportmonks lifecycle
 * callback. Maps the broadcast phase to the entry's `eventType` +
 * human-readable content + subjectTime marker. The conductor consumes
 * the entry on its way back through the Kairos feed (same path as
 * replay). Operational transitions (pre_ramp, warming, complete) are
 * broadcast lifecycle, not match state — they don't get an entry. */
export const TRANSITION_FOR_PHASE: Partial<Record<BroadcastPhase, GameplayTransition>> = {
  live_first_half: {
    eventType: "KICKOFF",
    content: "Kickoff — the match is underway.",
    subjectTime: "1",
    phase: "first_half",
  },
  halftime: {
    eventType: "HALFTIME",
    content: "Half-time whistle.",
    subjectTime: "45",
    phase: "halftime",
    closingExtensionSeconds: 15,
    closingPrompt: CLOSING_CYCLE_PROMPT,
  },
  live_second_half: {
    eventType: "SECOND_HALF_KICKOFF",
    content: "Second-half underway.",
    subjectTime: "46",
    phase: "second_half",
  },
  full_time_winddown: {
    eventType: "FULL_TIME",
    content: "Full-time whistle.",
    subjectTime: "90",
    phase: "full_time",
    closingExtensionSeconds: 15,
    closingPrompt: CLOSING_CYCLE_PROMPT,
  },
};

/**
 * Given an entry's `data.phase` and the conductor's current phase,
 * decide whether to transition and to what. Returns null when the
 * entry's phase is unknown, already passed, or same as current.
 */
export function nextPhaseFromEntryPhase(
  rawPhase: unknown,
  currentSubjectPhase: BroadcastPhase,
): BroadcastPhase | null {
  if (typeof rawPhase !== "string") return null;
  const mapped = DATA_PHASE_TO_BROADCAST_PHASE[rawPhase];
  if (!mapped) return null;
  if (PHASE_ORDINAL[mapped] <= PHASE_ORDINAL[currentSubjectPhase]) return null;
  return mapped;
}

/**
 * Minimum age in minutes a broadcast must be before a conductor-
 * initiated completion can fire. Guards against transient phase
 * glitches (seen during 2026-04-22 Burnley-City restart cascade)
 * that routed a live broadcast through winddown → complete within
 * minutes of kickoff. No real football match ends in under 60
 * minutes, so rejecting the auto-complete and leaving phase at
 * winddown is a safe default — a legitimate full-time winddown
 * past the 60-minute mark still completes normally.
 */
export const MIN_MATCH_AGE_MINUTES_FOR_COMPLETE = 60;

export function shouldSuppressWinddownComplete(
  matchDateMs: number,
  nowMs: number,
): boolean {
  const elapsedMinutes = (nowMs - matchDateMs) / 60_000;
  return elapsedMinutes < MIN_MATCH_AGE_MINUTES_FOR_COMPLETE;
}

/**
 * Outcome of evaluating what the conductor should do when a narration
 * clip finishes playing. The decision sits at the intersection of the
 * phase FSM (are we in winddown?), the playback queue (do we still
 * have clips to play?), the match-age guard, and the closing-passage
 * deadline.
 */
export type ClipEndAction =
  | { type: "advance_queue" }
  | { type: "wait_for_closing_passage"; deadlineMs: number }
  | { type: "complete_broadcast" }
  | { type: "suppress_winddown_complete"; elapsedMinutes: number };

/**
 * Wall-clock ceiling between FT observation and forced auto-complete
 * if no further narration lands. Sized for the worst-case roundtrip:
 * phase-flush wait (75s) + closing cadence cycle gen+synth+audio
 * (~150s) + reflection cycle gen+synth+audio (~150s) ≈ 375s. 300s
 * covers the typical case comfortably; it's the "give up" fallback
 * for when Kairos errors mid-roundtrip and never delivers.
 */
export const CLOSING_DEADLINE_MS = 300_000;

/**
 * Decide what to do after a narration clip finishes playing.
 *
 *   advance_queue              — normal case: pull the next clip (or
 *                                wait for one to arrive).
 *   wait_for_closing_passage   — winddown, queue empty, but the closing
 *                                roundtrip (Kairos's closing cadence
 *                                cycle + the consumer-prompt reflection
 *                                cycle) hasn't completed yet. Hold the
 *                                broadcast alive until the deadline
 *                                AND inFlight work clears. Without
 *                                this, the conductor auto-completes
 *                                during the closing's roundtrip and
 *                                kills the most narratively important
 *                                moment of the broadcast (Finding 7
 *                                in the 2026-05-03 debrief).
 *   complete_broadcast         — winddown, queue empty, deadline
 *                                reached, no in-flight work, sane
 *                                match age. Done.
 *   suppress_winddown_complete — same shape as complete_broadcast but
 *                                the match is too young to plausibly
 *                                be at full time (< 60min). Almost
 *                                always a transient phase glitch;
 *                                leave phase at winddown so the next
 *                                legitimate winddown clip can complete.
 *
 * Pure decision — no side effects. The conductor side translates the
 * outcome into telemetry, console warns, and the actual transition.
 */
export function decideClipEndAction(args: {
  phase: BroadcastPhase;
  readyQueueEmpty: boolean;
  matchStartMs: number;
  nowMs: number;
  /** Wall-clock at which the conductor will allow auto-complete from
   * winddown — set when the conductor enters winddown
   * (`fullTimeObservedAtMs + CLOSING_DEADLINE_MS`). Null when the
   * broadcast hasn't entered winddown via the closing-passage path
   * (legacy / replay scenarios), in which case auto-complete behaves
   * as it did before Finding 7's fix. */
  closingDeadlineMs: number | null;
  /** True when there's narrative-handling work the conductor expects
   * to produce more clips: a narrative pending synthesis, a synth in
   * flight, or both. While this is true, hold for a future clip-end
   * regardless of the deadline. */
  inFlightWork: boolean;
}): ClipEndAction {
  if (args.phase !== "full_time_winddown" || !args.readyQueueEmpty) {
    return { type: "advance_queue" };
  }
  if (shouldSuppressWinddownComplete(args.matchStartMs, args.nowMs)) {
    const elapsedMinutes = (args.nowMs - args.matchStartMs) / 60_000;
    return { type: "suppress_winddown_complete", elapsedMinutes };
  }

  // Closing-passage roundtrip protection. Defer auto-complete while
  // either (a) the deadline hasn't arrived yet, or (b) there's
  // synthesis / narrative-queue work that will produce more clips.
  // The deadline timer (set on conductor) wakes the conductor at
  // closingDeadlineMs to re-check; if the next clip-end fires past
  // the deadline with idle state, this branch falls through to
  // complete_broadcast.
  if (args.closingDeadlineMs !== null) {
    const deadlineReached = args.nowMs >= args.closingDeadlineMs;
    if (!deadlineReached || args.inFlightWork) {
      return { type: "wait_for_closing_passage", deadlineMs: args.closingDeadlineMs };
    }
  }

  return { type: "complete_broadcast" };
}

/** Source types whose entries are always allowed into Kairos
 * regardless of the entry's content-time phase. Activation seed
 * material — the writer's voice and brief — pushed once before the
 * broadcast goes live. */
const AMBIENT_SEED_SOURCES: ReadonlySet<string> = new Set([
  "narrative_voice",
  "narrative_context",
]);

/** Phases whose stamped entries describe live match content. The
 * clock is ticking; everything that lands belongs in a cycle. */
const LIVE_CONTENT_PHASES: ReadonlySet<string> = new Set([
  "first_half",
  "live_first_half",
  "second_half",
  "live_second_half",
  "extra_time_first",
  "extra_time_second",
]);

/** Phases whose stamped entries describe a post-whistle interlude.
 * The first POST_WHISTLE_TEXTURE_WINDOW_SECONDS of these belong in
 * the closing cycle (paired with `closingExtensionSeconds=15` on
 * the runner's synthetic phase entry); past that, entries are
 * post-match noise (ads, unrelated commentary, studio chatter)
 * that shouldn't trigger further generation. */
const POST_WHISTLE_PHASES: ReadonlySet<string> = new Set([
  "halftime",
  "full_time",
  "extra_time_halftime",
]);

export const POST_WHISTLE_TEXTURE_WINDOW_SECONDS = 15;

/**
 * Pure decision: should the runner forward this source-typed entry
 * to Kairos given its stamped content-time phase?
 *
 * Content-time-driven, not conductor-state-driven: a late-arriving
 * pre-whistle event whose data carries `phase=first_half` passes
 * even when the conductor's own phase has advanced to `halftime`.
 * Pairs with the closing-boundary mechanism in Kairos — post-whistle
 * texture inside the 15s extension window flows into the closing
 * cycle; past 15s, the gate closes and post-match noise stops
 * generating cycles.
 *
 * Phases recognised:
 *   - LIVE_CONTENT_PHASES — full open
 *   - POST_WHISTLE_PHASES, phaseSecond ≤ 15 — closing-window texture
 *   - pre_match + match_action — warming-window atmosphere (the
 *     "broadcast activated 5 min before kickoff sits in dead air"
 *     fix from the 2026-04-22 Burnley-City test). Other sources
 *     blocked pre-kickoff to keep phantom events out.
 *   - everything else (penalties, deep HT/FT, unknown phases) — closed
 *
 * Ambient seed sources (narrative_voice, narrative_context) are
 * always allowed — activation material with no content-time anchor.
 */
export function decideSourcePushAllowed(
  sourceType: string,
  data?: Record<string, unknown>,
): boolean {
  if (AMBIENT_SEED_SOURCES.has(sourceType)) return true;

  const phase = typeof data?.phase === "string" ? data.phase : null;
  const phaseSecond = typeof data?.phaseSecond === "number" ? data.phaseSecond : 0;

  if (phase !== null && LIVE_CONTENT_PHASES.has(phase)) return true;

  if (
    phase !== null &&
    POST_WHISTLE_PHASES.has(phase) &&
    phaseSecond <= POST_WHISTLE_TEXTURE_WINDOW_SECONDS
  ) {
    return true;
  }

  if (phase === "pre_match" && sourceType === "match_action") return true;

  return false;
}
