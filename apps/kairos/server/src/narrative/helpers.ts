/**
 * Per-entry accessors + transforms used by the generator context.
 *
 * These were originally in `context.ts` alongside the deprecated
 * `assembleContext` stage. Relocated 2026-04-24 (Phase 1 of the
 * pipeline-fix plan) so the generator can build its `GenerationContext`
 * from curation's selected entries directly, without any intermediate
 * "assembly" step.
 *
 * Pure functions on a single `FeedEntry`'s `data`. No feed-level logic
 * belongs here.
 */

import type { FeedEntry } from "../types.js";
import type { AssembledEntry } from "./types.js";

export function getContent(entry: FeedEntry): string {
  const value = entry.data.content;
  return typeof value === "string" ? value : JSON.stringify(entry.data);
}

export function getMinute(entry: FeedEntry): number | null {
  const value = entry.data.minute;
  return typeof value === "number" ? value : null;
}

export function getExtraMinute(entry: FeedEntry): number | null {
  const value = entry.data.extraMinute;
  return typeof value === "number" ? value : null;
}

export function getSubjectTime(entry: FeedEntry): string | undefined {
  const value = entry.data.subjectTime;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getSubjectPhase(entry: FeedEntry): string | undefined {
  const value = entry.data.phase;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function getSubjectPhaseSecond(entry: FeedEntry): number | undefined {
  const value = entry.data.phaseSecond;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Fallback match-minute extraction for entries whose `minute` field is
 * missing. Live football sources consistently carry `subjectTime` as a
 * string like `"3"`, `"45+2"`, `"pre_match"` — the numeric prefix is
 * the match-minute. Without this fallback, `deriveCurrentSubjectMinute`
 * computes null on any cycle where no entry carries a typed numeric
 * `minute`, and the narrator has no time anchor — confirmed
 * 2026-04-22 as the cause of the "twenty minutes in" hallucination at
 * match minute 3.
 */
export function getSubjectMinute(entry: FeedEntry): number | null {
  const m = getMinute(entry);
  if (m != null) return m;
  const ct = getSubjectTime(entry);
  if (!ct) return null;
  const match = ct.match(/^(\d+)/);
  if (!match) return null;
  const parsed = parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatMinute(entry: FeedEntry): string {
  const minute = getMinute(entry);
  if (minute == null) return "--";
  const extra = getExtraMinute(entry);
  return `${minute}${extra ? `+${extra}` : ""}'`;
}

/**
 * Derive the broadcast's current match minute from a set of entries.
 * Uses the maximum across entries (not the latest entry's) so a late-
 * arriving pre-match entry can't pull the anchor backwards once live
 * play has started. Returns null when no entry carries a numeric
 * minute or a numeric-prefixed subjectTime.
 */
export function deriveCurrentSubjectMinute(entries: FeedEntry[]): number | null {
  let max: number | null = null;
  for (const entry of entries) {
    const m = getSubjectMinute(entry);
    if (m == null) continue;
    if (max == null || m > max) max = m;
  }
  return max;
}

/**
 * Earliest `subjectTime` across a set of entries, parsed-leading-int.
 * `"45+2"` parses to 45; `"pre_match"` and other non-numeric strings
 * are ignored. Returns null when no entry carries a numeric
 * subjectTime. Used by the engine to stamp `NarrativeOutput.batch
 * ContentTime` — consumers drive the match clock from it (snaps on
 * audio-start to the minute the narrator is beginning from).
 */
export function earliestSubjectMinute(entries: FeedEntry[]): number | null {
  let min: number | null = null;
  for (const entry of entries) {
    const raw = (entry.data as { subjectTime?: unknown }).subjectTime;
    if (typeof raw !== "string") continue;
    const match = raw.match(/^\+?(\d+)/);
    if (!match) continue;
    const parsed = parseInt(match[1], 10);
    if (Number.isNaN(parsed)) continue;
    if (min == null || parsed < min) min = parsed;
  }
  return min;
}

/**
 * Clamp a computed minute value upward to a monotonic floor. Used by
 * the engine so a late-arriving entry from an earlier phase (delayed
 * transcription, moderator catch-up) can't pull the consumer-side
 * match clock backwards on the next cycle's audio-start snap.
 *
 * `null` floor passes `next` through unchanged — first cycle has no
 * floor yet. `null` next also passes through — the consumer already
 * knows to fall back on its own minute source when we can't provide
 * one.
 */
export function clampMonotonicMinute(
  next: number | null,
  floor: number | null,
): number | null {
  if (next == null) return null;
  if (floor == null) return next;
  return next < floor ? floor : next;
}

/**
 * The cycle's "batch" — every entry observed since the prior cycle's
 * trigger, excluding ambient sources (`narrative_voice`,
 * `narrative_context`). Distinct from what curation surfaced to the
 * generator: the batch is everything the cycle observed, regardless
 * of what curation chose to drop. Carries the consumer's UI reveal
 * contract — the matchroom reveals every batch entry at audio-end
 * that the narrator didn't explicitly cite, so nothing the cycle
 * observed is invisible to the UI.
 *
 * `sinceTimestamp` is the previous generation's `triggeredAt` (ms);
 * pass `null` on the first cycle to include everything.
 */
export function computeBatchEntries(
  allEntries: FeedEntry[],
  sinceTimestamp: number | null,
): FeedEntry[] {
  const cutoff = sinceTimestamp ?? -Infinity;
  return allEntries.filter((e) => {
    if (e.sourceType === "narrative_voice" || e.sourceType === "narrative_context") return false;
    if (e.timestamp <= cutoff) return false;
    return true;
  });
}

/**
 * Shape a raw `FeedEntry` into the `AssembledEntry` the generator's
 * prompt renders. Carries source name, timestamp, minute/phase
 * markers, and content — the narrator's view of a single event.
 */
export function toAssembled(entry: FeedEntry): AssembledEntry {
  const subjectTime = getSubjectTime(entry);
  const phase = getSubjectPhase(entry);
  const phaseSecond = getSubjectPhaseSecond(entry);
  const parentSourceId = typeof entry.data?.parentSourceId === "string"
    ? entry.data.parentSourceId as string
    : undefined;
  // Source-side stable id, kept as a string regardless of whether the
  // consumer used a number (Sportmonks) or string. Surfaced so child
  // entries can be matched to their parent at render time.
  const rawSourceId = entry.data?.sourceId;
  const canonicalSourceId =
    typeof rawSourceId === "number"
      ? String(rawSourceId)
      : typeof rawSourceId === "string"
        ? rawSourceId
        : undefined;
  return {
    entryId: entry.id,
    source: entry.sourceName,
    timestamp: entry.timestamp,
    minute: formatMinute(entry),
    ...(subjectTime ? { subjectTime } : {}),
    ...(phase ? { phase } : {}),
    ...(phaseSecond != null ? { phaseSecond } : {}),
    ...(parentSourceId ? { parentSourceId } : {}),
    ...(canonicalSourceId ? { canonicalSourceId } : {}),
    content: getContent(entry),
  };
}
