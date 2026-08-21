import type { KairosFeedEntry, KairosNarrativeOutput } from "../lib/kairos.js";
import { captureInvariant } from "../lib/telemetry.js";

/**
 * Domain-aware runtime postconditions for Blackout broadcasts. Each
 * check looks at a narrative arriving from Kairos against the feed
 * entries that fed the generation (captured by the conductor's
 * entry cache) and emits an invariant event when a known football-
 * specific failure pattern shows up.
 *
 * These invariants encode lessons from live tests — symptoms we've
 * seen and fixed, plus symptoms we'd want to catch if they regress.
 * Run on every narrative, log to stderr, send to PostHog.
 */

/** Sportmonks event types that must be cited by the narrator if they
 * appeared in the generator's context. Missing them leaves the
 * matchroom unable to reveal the matching event and — worse — means
 * the narrator has silently skipped a dramatic beat. */
const MUST_COVER_EVENT_TYPES = new Set([
  "GOAL",
  "OWN_GOAL",
  "PENALTY",
  "RED_CARD",
  "SECOND_YELLOW",
  "VAR",
  "VAR_CARD",
]);

/** Score-describing patterns the narrator might use. If the prose
 * invokes any of these and no GOAL event is in `covers`, the
 * narrator has either hallucinated a score change or is recapping
 * one that the curator didn't cite — both worth logging.
 *
 * Broadened 2026-04-22 after the Delap hallucination, then narrowed
 * 2026-04-26 after the FA Cup SF retro: the broader `\bgoal(s)?\b`
 * and bare scoring-verb patterns fired six times on legitimate prose
 * referencing past goals or describing scoring droughts (Chelsea's
 * "haven't scored in six matches", "the goal that won the first leg"
 * etc.). Reverted to assertion-strength patterns only — score
 * changes, named scoring moments, and constructions that explicitly
 * put a team ahead/level. The Delap class of oblique hallucination
 * is now caught by the `event_uncovered` invariant for goal entries
 * in the batch instead. */
const SCORE_PATTERNS: RegExp[] = [
  /\b\d+\s?[–-]\s?\d+\b/, // "1-0", "1 – 0"
  /\b(one|two|three|four|five)[- ](nil|zero|one|two|three)\b/i,
  /\b(opener|equaliser|equalizer|leveller|leveler|winner)\b/i,
  /\bput\s+(?:them|us|the\s+\w+)\s+(ahead|in\s+front|level)\b/i,
];

interface InvariantInput {
  broadcastId: string;
  narrative: KairosNarrativeOutput;
  batchEntries: KairosFeedEntry[];
}

export function checkNarrativeInvariants(input: InvariantInput): void {
  const { broadcastId, narrative, batchEntries } = input;
  const coveredIds = new Set((narrative.covers ?? []).map((c) => c.entryId));

  // Invariant: MUST_COVER event in batch not cited. Classic smoking
  // gun for the 2026-04-21 "full time, a draw at 3-0" family of bugs.
  for (const entry of batchEntries) {
    const eventType = getEventType(entry);
    if (!eventType) continue;
    if (!MUST_COVER_EVENT_TYPES.has(eventType)) continue;
    if (coveredIds.has(entry.id)) continue;
    captureInvariant({
      name: "event_uncovered",
      severity: "warn",
      broadcastId,
      narrativeId: narrative.id,
      message: `${eventType} entry ${entry.id} was in the generator's context but wasn't cited`,
      details: {
        entryId: entry.id,
        eventType,
        player: getPlayer(entry),
        team: getTeam(entry),
        subjectTime: getSubjectTime(entry),
        coverCount: coveredIds.size,
      },
    });
  }

  // Invariant: score phrase in prose but no GOAL-family entry in
  // covers. Either hallucinated or a miscited prior goal.
  const hasGoalInCovers = batchEntries.some(
    (e) =>
      coveredIds.has(e.id) &&
      (getEventType(e) === "GOAL" || getEventType(e) === "OWN_GOAL"),
  );
  const scoreMatch = findScorePattern(narrative.text);
  if (scoreMatch && !hasGoalInCovers) {
    captureInvariant({
      name: "score_phrase_without_goal",
      severity: "warn",
      broadcastId,
      narrativeId: narrative.id,
      message: `prose contains score-like phrase "${scoreMatch}" but no GOAL in covers`,
      details: {
        match: scoreMatch,
        prosePreview: narrative.text.slice(0, 160),
      },
    });
  }
}

function findScorePattern(text: string): string | null {
  for (const re of SCORE_PATTERNS) {
    const match = text.match(re);
    if (match) return match[0];
  }
  return null;
}

function getEventType(entry: KairosFeedEntry): string | null {
  const d = entry.data as Record<string, unknown> | null | undefined;
  const raw = d?.eventType;
  return typeof raw === "string" ? raw : null;
}

function getPlayer(entry: KairosFeedEntry): string | null {
  const d = entry.data as Record<string, unknown> | null | undefined;
  const raw = d?.player;
  return typeof raw === "string" ? raw : null;
}

function getTeam(entry: KairosFeedEntry): string | null {
  const d = entry.data as Record<string, unknown> | null | undefined;
  const raw = d?.team;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "name" in raw) {
    const name = (raw as { name?: unknown }).name;
    return typeof name === "string" ? name : null;
  }
  return null;
}

function getSubjectTime(entry: KairosFeedEntry): string | null {
  const d = entry.data as Record<string, unknown> | null | undefined;
  const raw = d?.subjectTime;
  return typeof raw === "string" ? raw : null;
}
