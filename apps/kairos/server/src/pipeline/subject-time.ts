import type { FeedEntry } from "../types.js";

/**
 * Content-time ordinal — the universal ordering key the pipeline uses
 * to bucket entries into content-time-coherent windows.
 *
 * Wall-clock batching produces incoherent windows when sources have
 * heterogeneous arrival latencies (Sportmonks events ~30s late, HLS+ASR
 * commentary ~30s late, etc.). Content-time batching keys the dispatch
 * decision on WHEN the underlying event happened in match time, not
 * WHEN it landed in Kairos.
 *
 * Each entry carries `phase` + `phaseSecond` from the consumer's
 * stamping path (the Blackout's broadcast-runner sets these at push
 * time using its calibrated radio-offset estimate). This module
 * collapses (phase, phaseSecond) into a single ordinal that orders
 * cleanly across phase boundaries.
 *
 * Stride = 1_000_000 between phases — large enough that any realistic
 * `phaseSecond` (first half stoppage rarely exceeds 7×60=420s; even
 * extra time in cup ties stays well under 100k seconds) sorts within
 * its phase before crossing into the next.
 */

export const PHASE_ORDINAL_STRIDE = 1_000_000;

const PHASE_BASE: Record<string, number> = {
  pre_match: 0,
  warming: 0,
  live_first_half: 1 * PHASE_ORDINAL_STRIDE,
  first_half: 1 * PHASE_ORDINAL_STRIDE,
  halftime: 2 * PHASE_ORDINAL_STRIDE,
  live_second_half: 3 * PHASE_ORDINAL_STRIDE,
  second_half: 3 * PHASE_ORDINAL_STRIDE,
  full_time: 4 * PHASE_ORDINAL_STRIDE,
  full_time_winddown: 4 * PHASE_ORDINAL_STRIDE,
  complete: 4 * PHASE_ORDINAL_STRIDE,
};

/**
 * Compute the content ordinal for a (phase, phaseSecond) pair.
 *
 * Returns null when the inputs don't yield a confident ordinal —
 * unknown phase, or phase missing entirely. Callers treat null as
 * "no content-time anchor" (these entries pass through any cadence
 * flush rather than being held in the waiting room indefinitely).
 */
export function subjectOrdinal(
  phase: unknown,
  phaseSecond: unknown,
): number | null {
  if (typeof phase !== "string") return null;
  const base = PHASE_BASE[phase];
  if (base === undefined) return null;
  const sec = typeof phaseSecond === "number" && Number.isFinite(phaseSecond) ? phaseSecond : 0;
  return base + sec;
}

/**
 * Extract the content ordinal from a feed entry's data payload.
 * Returns null for entries without phase information (ambient
 * sources, unstamped legacy entries, test fixtures).
 */
export function subjectOrdinalForEntry(entry: FeedEntry): number | null {
  const data = entry.data as Record<string, unknown> | undefined;
  if (!data) return null;
  return subjectOrdinal(data.phase, data.phaseSecond);
}

/**
 * Read the closing-extension marker from an entry's `data` payload.
 *
 * The consumer stamps `closingExtensionSeconds: number` on entries
 * that mark a phase boundary worth pinning the next cycle's drain
 * end at — e.g. a whistle moment whose post-boundary texture should
 * land in the closing cycle rather than the next one. Kairos doesn't
 * decide which entries qualify; the consumer decides per-entry.
 *
 * Returns the extension as a non-negative finite number, or null
 * when the marker is absent or malformed (the common case — most
 * entries are not phase boundaries).
 */
export function readClosingExtension(entry: FeedEntry): number | null {
  const data = entry.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const value = data.closingExtensionSeconds;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Read the optional closing-cycle prompt from an entry's `data`
 * payload. Paired with `closingExtensionSeconds` — when both are
 * present, Kairos splices this text into the closing cycle's
 * generator call as a consumer-prompt. Domain-agnostic: Kairos
 * doesn't interpret the contents.
 *
 * Returns null when the field is absent or empty.
 */
export function readClosingPrompt(entry: FeedEntry): string | null {
  const data = entry.data as Record<string, unknown> | undefined;
  if (!data) return null;
  const value = data.closingPrompt;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
