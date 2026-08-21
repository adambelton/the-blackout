/**
 * Pure derivations for the matchroom view.
 *
 * Lifted out of `page.tsx` so the reveal contract can be unit-tested
 * directly without rendering the React component (which depends on
 * audio, RAF, WS, etc.). Anything purely "given inputs, return
 * outputs" — score derivation, label formatting, cover-anchor reveal
 * scheduling — lives here. The page is the orchestrator; this module
 * is the rules.
 *
 * Some of these retire in Sub-piece 4 of the matchroom reveal
 * architecture cluster (Design A — see
 * `docs/matchroom-reveal-architecture-scoping.md`):
 *
 *   - `deriveScore` and `latestContentMinute` retire when the canonical
 *     bundle becomes the source of truth (server-authored score,
 *     server-authored contentMinute string).
 *   - `computeContentMinuteLabel`'s rule is replaced with a simpler
 *     `(phase, contentMinute) → label` projection over visible state.
 *
 * Until that lands, these characterise today's behaviour and lock it
 * against accidental regression.
 */

export type EventType =
  | "GOAL"
  | "OWN_GOAL"
  | "YELLOW_CARD"
  | "RED_CARD"
  | "SUBSTITUTION"
  | "VAR"
  | "PENALTY"
  | "KICKOFF"
  | "HALFTIME"
  | "SECOND_HALF_KICKOFF"
  | "FULL_TIME"
  | string;

export type Phase =
  | "pre_ramp"
  | "warming"
  | "live_first_half"
  | "halftime"
  | "live_second_half"
  | "full_time_winddown"
  | "complete";

export interface ViewerEvent {
  id: string;
  eventType: EventType;
  content: string;
  minute: number | null;
  extraMinute: number | null;
  contentTime?: string;
  timestamp: number;
  player: string | null;
  relatedPlayer: string | null;
  team: TeamSide | null;
  teamName: string | null;
  isGoal: boolean;
}

import { parseMatchTime, type TeamSide } from "@blackout/shared";

/** Server-derived score is preferred when available (live, non-replay);
 * this fallback derives from revealed events client-side. Replay mode
 * always uses the fallback because the server's score reflects FINAL
 * state, not the listener's progress through replay playback. */
export function deriveScore(events: ViewerEvent[]): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const e of events) {
    if (!e.isGoal) continue;
    if (e.team === "home") home++;
    else if (e.team === "away") away++;
  }
  return { home, away };
}

/** Picks the event with the highest match-minute (parsed contentTime),
 * NOT the highest push timestamp — push timestamp would surface a
 * recently re-pushed early-minute event (e.g. a duplicate of the 3'
 * goal pushed during a runner restart) instead of the actual latest
 * moment of the match. */
export function latestContentMinute(events: ViewerEvent[]): string | null {
  if (events.length === 0) return null;
  let latest: ViewerEvent | null = null;
  let latestRank = -Infinity;
  for (const e of events) {
    const rank = parseMatchTime(e.contentTime);
    if (rank > latestRank) {
      latestRank = rank;
      latest = e;
    }
  }
  if (!latest) return null;
  return formatMinute(latest.minute, latest.extraMinute, latest.contentTime);
}

/** Format a minute/extra-minute pair (or contentTime string) into the
 * conventional match-minute display ("47'", "45+2'"). */
export function formatMinute(
  minute: number | null,
  extraMinute: number | null,
  contentTime?: string,
): string | null {
  if (contentTime && contentTime.length > 0) return `${contentTime.replace(/^\+?/, "")}'`;
  if (minute == null) return null;
  if (extraMinute != null && extraMinute > 0) return `${minute}+${extraMinute}'`;
  return `${minute}'`;
}

/** Keeps the viewer ribbon focused on events fans actually talk
 * about. Server pre-filters pressure/zone noise; this is the
 * client-side allow-list. */
export function isShowableEvent(e: ViewerEvent): boolean {
  const kind = e.eventType;
  if (!kind) return false;
  const keep = new Set<EventType>([
    "GOAL",
    "YELLOW_CARD",
    "RED_CARD",
    "SUBSTITUTION",
    "VAR",
    "PENALTY",
    "OWN_GOAL",
    "KICKOFF",
    "HALFTIME",
    "SECOND_HALF_KICKOFF",
    "FULL_TIME",
  ]);
  return keep.has(kind);
}

export function eventLabel(kind: EventType): string {
  switch (kind) {
    case "GOAL": return "Goal";
    case "OWN_GOAL": return "Own goal";
    case "YELLOW_CARD": return "Yellow";
    case "RED_CARD": return "Red card";
    case "SUBSTITUTION": return "Substitution";
    case "VAR": return "VAR";
    case "PENALTY": return "Penalty";
    case "KICKOFF": return "Kickoff";
    case "HALFTIME": return "Half-time";
    case "SECOND_HALF_KICKOFF": return "Second half";
    case "FULL_TIME": return "Full-time";
    default: return String(kind).replace(/_/g, " ").toLowerCase();
  }
}

export function eventText(e: ViewerEvent): string {
  const team = e.teamName ?? (e.team === "home" ? "home" : e.team === "away" ? "away" : null);
  const player = e.player;

  if (e.eventType === "SUBSTITUTION" && (player || e.relatedPlayer)) {
    if (e.relatedPlayer && player) {
      return team
        ? `${e.relatedPlayer} ↓ ${player} ↑ · ${team}`
        : `${e.relatedPlayer} ↓ ${player} ↑`;
    }
    if (player) return team ? `${player}, ${team}` : player;
  }

  if (e.isGoal) {
    if (player && team) return `${player}, ${team}`;
    if (player) return player;
    if (team) return `${team}`;
  }

  if (player && team) return `${player}, ${team}`;
  if (player) return player;
  if (e.content) return e.content.replace(/^\[[A-Z_]+\]\s*/, "");
  return "—";
}

/** Per-cover reveal scheduling — the cover-anchor timing that powers
 * "no-spoilers" event reveal during a passage's audio. Each cover
 * with a `charOffset` reveals at `(charOffset / text.length) *
 * durationMs` after audio start. Pure: returns the schedule; caller
 * wires `setTimeout`. Covers without a charOffset are reserved for
 * audio-end reveal (the caller filters them out by subtracting the
 * scheduled set from the audio-end batch). */
export interface CoverReveal {
  entryId: string;
  delayMs: number;
}

export function computeCoverRevealSchedule(
  covers: Array<{ entryId: string; charOffset?: number }>,
  text: string,
  durationMs: number,
): CoverReveal[] {
  if (!covers.length || !text || !durationMs) return [];
  const totalChars = text.length;
  if (totalChars === 0) return [];
  const scheduled: CoverReveal[] = [];
  for (const cover of covers) {
    if (cover.charOffset == null) continue;
    const ratio = Math.max(0, Math.min(1, cover.charOffset / totalChars));
    const delayMs = Math.round(ratio * durationMs);
    scheduled.push({ entryId: cover.entryId, delayMs });
  }
  return scheduled;
}

/** Compose the displayed match-minute label from the available
 * sources, in priority order:
 *
 *   1. Phase short-circuits at breaks: halftime → "HT",
 *      full-time/complete (live only) → "FT". Replay never short-
 *      circuits — the listener is mid-replay even on a complete
 *      broadcast, so the label should reflect their progress.
 *   2. Current passage's contentMinute — set when audio begins; the
 *      narrator is speaking from this minute onward. String form
 *      preserves stoppage suffixes ("45+2", "90+7") through to
 *      display.
 *   3. Fallback content minute from the broadcast view (live only) —
 *      bootstrap value before any passage has played, derived
 *      server-side from the latest revealed event.
 *   4. Local fallback — latestContentMinute over revealed events.
 *
 * Returns null when no minute is available (pre-match, no events). */
export function computeContentMinuteLabel({
  phase,
  isReplay,
  currentContentMinute,
  fallbackContentMinute,
  events,
}: {
  phase: Phase;
  isReplay: boolean;
  currentContentMinute: string | null;
  fallbackContentMinute: string | null;
  events: ViewerEvent[];
}): string | null {
  if (phase === "halftime") return "HT";
  if ((phase === "full_time_winddown" || phase === "complete") && !isReplay) return "FT";
  if (currentContentMinute != null) return `${currentContentMinute}'`;
  if (!isReplay && fallbackContentMinute) return fallbackContentMinute;
  return latestContentMinute(events);
}
