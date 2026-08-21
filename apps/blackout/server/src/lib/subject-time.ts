import type { SportmonksPeriod } from "./sportmonks.js";

/**
 * Structured phase enum. Finer-grained than the content-time label —
 * drives the narrator's mode hint ("we're in halftime, explore context
 * rather than play-by-play") and provides sub-minute chronological
 * anchoring for cross-source ordering.
 */
export type SubjectPhase =
  | "pre_match"
  | "first_half"
  | "halftime"
  | "second_half"
  | "full_time"
  | "extra_time_first"
  | "extra_time_halftime"
  | "extra_time_second"
  | "penalties";

export interface SubjectPhaseAnchor {
  phase: SubjectPhase;
  /** Wall-clock ms when this phase started. Null if indeterminate. */
  broadcastPhaseStartMs: number | null;
  /** Seconds since the phase started at the anchor's reference wall-clock. */
  phaseSecond: number | null;
}

/**
 * Content-time is a Blackout-owned label that every temporal entry carries
 * onto Kairos. Kairos treats it as an opaque string and uses it for
 * timeline interleaving and prompt labelling — the vocabulary is ours.
 *
 * Vocabulary:
 *   "67"         — in-play minute (first or second half, normalised from period counts_from)
 *   "90+3"       — in-play stoppage (past the period's natural end)
 *   "pre_match"  — fixture not yet kicked off (or postponed/cancelled)
 *   "HT"         — between halves; no period is ticking but the match has started
 *   "FT"         — all in-play periods have ended
 *
 * Anchors are the Sportmonks `periods[]` snapshot — specifically the
 * ticking period's actual `started` timestamp. This means a delayed
 * kickoff produces correct minutes, second-half minutes are normalised
 * via `counts_from` (45), and half-time is phase-labelled rather than
 * fake-minute-labelled.
 */

export function formatSubjectTime(
  minute: number | null | undefined,
  extraMinute?: number | null,
): string | undefined {
  if (minute == null) return undefined;
  return extraMinute ? `${minute}+${extraMinute}` : String(minute);
}

/**
 * Compute a content-time label from a live fixture snapshot.
 *
 * Scans `periods` for the window that contains `atWallClockMs` and uses
 * that period's `started` epoch + `counts_from` to derive the minute. This
 * is anchored on the actual whistle, not the scheduled kickoff, and
 * normalises second-half minutes via `counts_from: 45`.
 *
 * Defaults `atWallClockMs` to `Date.now()` — callers stamping entries based
 * on a Deepgram utterance end-time should pass their own anchor so the
 * label reflects when the words were spoken, not when we're stamping.
 *
 * Falls back to phase labels (`HT`, `FT`, `pre_match`) when no period
 * window contains the target time — either the match hasn't started, we're
 * mid-break, or all periods have ended.
 */
export function computeLiveSubjectTime(
  periods: SportmonksPeriod[] | null | undefined,
  state?: { short_name?: string | null; name?: string | null } | null,
  atWallClockMs: number = Date.now(),
): string {
  const containing = periods?.find((p) => {
    if (!isTimingPeriod(p) || p.started == null) return false;
    const startedMs = toMs(p.started);
    const endedMs = p.ended != null ? toMs(p.ended) : Infinity;
    return startedMs <= atWallClockMs && atWallClockMs < endedMs;
  });
  if (containing) {
    const startedMs = toMs(containing.started!);
    // Football minute counting is 1-indexed: the first second after
    // kickoff is "1'", not "0'". Floor the elapsed seconds to whole
    // minutes then add 1 — elapsed 0–59s → 1', elapsed 60–119s → 2',
    // etc. For 2H (counts_from=45), kickoff is the 46th minute.
    // Pre-fix this returned "0" for the first minute of any period,
    // which was visible to viewers as a stuck minute display during
    // the 2026-04-26 FA Cup SF (combined with Sportmonks period-data
    // lag, the broadcast clock read 0' for ~8 match-minutes).
    const elapsedMin = Math.max(0, Math.floor((atWallClockMs - startedMs) / 60_000));
    const currentSubjectMinute = containing.counts_from + elapsedMin + 1;
    const normalEnd = containing.counts_from + containing.period_length;
    if (currentSubjectMinute > normalEnd) {
      return `${normalEnd}+${currentSubjectMinute - normalEnd}`;
    }
    return String(currentSubjectMinute);
  }

  // Not inside any period window — use fixture state as the authoritative
  // phase, falling through to period-shape inference if state is absent.
  const phaseFromStateLabel = phaseFromState(state);
  if (phaseFromStateLabel) return phaseFromStateLabel;

  if (!periods || periods.length === 0) return "pre_match";
  const timerPeriods = periods.filter(isTimingPeriod);
  if (timerPeriods.length === 0) return "pre_match";
  if (timerPeriods.every((p) => p.ended != null)) return "FT";
  if (timerPeriods.some((p) => p.started != null)) return "HT";
  return "pre_match";
}

/**
 * Invert the content-time mapping: given a match minute (and optional
 * stoppage extraMinute), return the real-world wall-clock ms at which it
 * occurred. Anchored on the period that contains the minute — so minute 67
 * resolves against 2H's `started` + 22 min, not 1H's.
 *
 * Returns null if no period containing the minute is available. Used by
 * the radio-latency evaluation loop to compare a Sportmonks GOAL event
 * against the wall-clock time its commentary appeared in the transcript.
 */
export function broadcastTimeForSubjectMinute(
  periods: SportmonksPeriod[] | null | undefined,
  minute: number,
  extraMinute: number = 0,
): number | null {
  if (!periods || periods.length === 0) return null;

  // In-period match: minute falls inside [counts_from, counts_from + period_length].
  // `isTimingPeriod` (not `has_timer`) so an ended period still resolves —
  // the radio-latency loop queries past minutes after FT.
  const period =
    periods.find(
      (p) =>
        isTimingPeriod(p) &&
        p.started != null &&
        minute >= p.counts_from &&
        minute <= p.counts_from + p.period_length,
    ) ?? null;

  if (!period) return null;

  const startedMs = toMs(period.started!);
  return startedMs + (minute - period.counts_from) * 60_000 + extraMinute * 60_000;
}

/**
 * Sportmonks sometimes ships `started` as seconds-since-epoch and sometimes
 * as milliseconds. Disambiguate by magnitude — anything under ~2286 in
 * seconds is sub-second precision, so a value below 10^10 is seconds.
 */
function toMs(started: number): number {
  return started > 10_000_000_000 ? started : started * 1000;
}

/**
 * Map a period's `counts_from` back to the enum phase. Sportmonks
 * encodes periods by their match-minute offset:
 *   0   → first half
 *   45  → second half
 *   90  → extra-time first half
 *   105 → extra-time second half
 */
function periodToSubjectPhase(counts_from: number): SubjectPhase {
  if (counts_from === 0) return "first_half";
  if (counts_from === 45) return "second_half";
  if (counts_from === 90) return "extra_time_first";
  if (counts_from === 105) return "extra_time_second";
  return "first_half";
}

/**
 * Is this period one of the four timing windows (1H / 2H / ET1 / ET2)?
 * Penalty shootouts and other non-clock periods don't have a meaningful
 * `[started, ended]` containment answer for a given wall-clock instant.
 *
 * Replaces an earlier `has_timer` filter that was excluding ENDED 1H /
 * 2H periods at HT / FT — Sportmonks flips `has_timer` to `false` once
 * a period ends, which dropped them from historical-containment lookups
 * and routed offset-corrected pre-whistle queries through the state-
 * label fallback (which always returns the CURRENT state, not the
 * historical one). Surfaced as Finding 4 in the 2026-05-03 live test:
 * post-whistle distillation entries describing pre-whistle action got
 * stamped `phase=halftime, phaseSecond=0` instead of first_half.
 */
function isTimingPeriod(p: SportmonksPeriod): boolean {
  return (
    p.counts_from === 0 ||
    p.counts_from === 45 ||
    p.counts_from === 90 ||
    p.counts_from === 105
  );
}

/**
 * Compute a structured phase anchor from a live fixture snapshot. Returns
 * the current phase, the wall-clock at which the phase started, and the
 * elapsed seconds into it. Drives both the narrator mode hint and the
 * unified chronological rendering in Kairos.
 *
 * Falls back sensibly when no period window matches:
 *   - `HT` state → halftime anchored on 1H's ended time if known
 *   - `FT`/`AET`/`PEN`/`AP` state → full_time anchored on the last ended period
 *   - otherwise → pre_match (no anchor)
 */
export function computeSubjectPhaseAnchor(
  periods: SportmonksPeriod[] | null | undefined,
  state?: { short_name?: string | null; name?: string | null } | null,
  atWallClockMs: number = Date.now(),
): SubjectPhaseAnchor {
  // Period whose [started, ended] window contains the reference time —
  // the common in-play case AND the historical-query case (e.g. an
  // offset-corrected distillation anchor that lands inside a now-ended
  // first half). Filtering only on `isTimingPeriod` + `started != null`
  // means an ENDED period still matches — see Finding 4.
  const containing = periods?.find((p) => {
    if (!isTimingPeriod(p) || p.started == null) return false;
    const startedMs = toMs(p.started);
    const endedMs = p.ended != null ? toMs(p.ended) : Infinity;
    return startedMs <= atWallClockMs && atWallClockMs < endedMs;
  });
  if (containing) {
    const broadcastPhaseStartMs = toMs(containing.started!);
    return {
      phase: periodToSubjectPhase(containing.counts_from),
      broadcastPhaseStartMs,
      phaseSecond: Math.max(0, Math.floor((atWallClockMs - broadcastPhaseStartMs) / 1000)),
    };
  }

  const label = (state?.short_name || state?.name || "").toUpperCase();

  // Halftime — between 1H and 2H.
  if (label === "HT" || (label.includes("HALF") && label.includes("TIME"))) {
    const firstHalf = periods?.find((p) => p.counts_from === 0 && p.ended != null);
    const broadcastPhaseStartMs = firstHalf?.ended != null ? toMs(firstHalf.ended) : null;
    return {
      phase: "halftime",
      broadcastPhaseStartMs,
      phaseSecond: broadcastPhaseStartMs != null ? Math.max(0, Math.floor((atWallClockMs - broadcastPhaseStartMs) / 1000)) : null,
    };
  }

  // Extra-time halftime — between ET1 and ET2.
  if (label === "ETB" || label === "BREAK") {
    const et1 = periods?.find((p) => p.counts_from === 90 && p.ended != null);
    const broadcastPhaseStartMs = et1?.ended != null ? toMs(et1.ended) : null;
    return {
      phase: "extra_time_halftime",
      broadcastPhaseStartMs,
      phaseSecond: broadcastPhaseStartMs != null ? Math.max(0, Math.floor((atWallClockMs - broadcastPhaseStartMs) / 1000)) : null,
    };
  }

  // Penalties — Sportmonks flags these as PEN or AP (after penalties).
  if (label === "PEN" || label === "AP") {
    const last = periods?.filter((p) => p.ended != null).sort((a, b) => toMs(b.ended!) - toMs(a.ended!))[0];
    const broadcastPhaseStartMs = last?.ended != null ? toMs(last.ended) : null;
    return {
      phase: "penalties",
      broadcastPhaseStartMs,
      phaseSecond: broadcastPhaseStartMs != null ? Math.max(0, Math.floor((atWallClockMs - broadcastPhaseStartMs) / 1000)) : null,
    };
  }

  // Full-time / end of regulation.
  if (label === "FT" || label === "AET" || (label.includes("FULL") && label.includes("TIME"))) {
    const last = periods?.filter((p) => p.ended != null).sort((a, b) => toMs(b.ended!) - toMs(a.ended!))[0];
    const broadcastPhaseStartMs = last?.ended != null ? toMs(last.ended) : null;
    return {
      phase: "full_time",
      broadcastPhaseStartMs,
      phaseSecond: broadcastPhaseStartMs != null ? Math.max(0, Math.floor((atWallClockMs - broadcastPhaseStartMs) / 1000)) : null,
    };
  }

  // Default: pre-match. No anchor — we don't know when "the broadcast
  // started" at this layer, and counting since activation is a
  // broadcast-lifecycle concern not a match-clock one.
  return { phase: "pre_match", broadcastPhaseStartMs: null, phaseSecond: null };
}

function phaseFromState(
  state?: { short_name?: string | null; name?: string | null } | null,
): string | null {
  if (!state) return null;
  const label = (state.short_name || state.name || "").toUpperCase();
  if (!label) return null;
  if (label === "NS" || label.includes("NOT STARTED")) return "pre_match";
  if (label.includes("POSTPONE") || label.includes("CANCEL")) return "pre_match";
  if (label === "HT" || (label.includes("HALF") && label.includes("TIME"))) return "HT";
  if (label === "FT" || label === "AET" || label === "PEN" || label === "AP") return "FT";
  if (label.includes("FULL") && label.includes("TIME")) return "FT";
  return null;
}
