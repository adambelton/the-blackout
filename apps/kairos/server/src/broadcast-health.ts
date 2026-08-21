/**
 * Flow-health aggregator for the inspector's broadcast-level summary.
 *
 * Pure function over already-fetched cycle + generation rows. The
 * route handler does the I/O; this module decides the arithmetic.
 *
 * Four quantities the admin compares against each other:
 *
 *   - wallSeconds       wall-clock elapsed since the first cycle fired
 *                       (or the full live span if the broadcast is
 *                       complete — last cycle minus first cycle).
 *   - contentSeconds    sum of max(phaseSecond) per live phase, across
 *                       every entry in every cycle. The "how much
 *                       playing time has the engine tracked" signal.
 *                       Halftime / pre_match / full_time intervals
 *                       are excluded — they're not match content.
 *   - proseSeconds      sum of (wordCount × 60 / WPM) across every
 *                       generation. WPM derived per-cycle from the
 *                       cycle's pacing snapshot when present, with
 *                       DEFAULT_WPM as a backstop.
 *   - targetSeconds     sum of (recommendedWordCount × 60 / WPM)
 *                       across every cycle whose curation snapshot
 *                       has a pacing target. The "what was Kairos
 *                       asked for" signal. Compare against
 *                       proseSeconds to see how reliably the LLM is
 *                       hitting the curator's word budget.
 *
 * In a healthy 90-minute broadcast all four converge on ~5400 seconds.
 * Drift between any two surfaces a different failure mode — see
 * `docs/design-problem-content-time-batching.md` for the ratios admins
 * read from this view.
 */

import type { BroadcastStatus } from "./db/enums.js";

/** Generic literary reading rate. Used when a cycle has no pacing
 * snapshot to derive WPM from (cold-start cycles, error states). */
export const DEFAULT_WPM = 165;

/** Phases that represent live match play. Halftime / pre_match /
 * full_time are excluded from `contentSeconds` — they're real time
 * passing but they don't count as "match coverage" the engine should
 * be keeping pace with. */
const LIVE_PHASES: ReadonlySet<string> = new Set([
  "first_half",
  "live_first_half",
  "second_half",
  "live_second_half",
]);

interface CycleInput {
  triggeredAt: number;
  chunkEntries: unknown;
  curation: unknown;
  generationId: string | null;
}

interface GenerationInput {
  id: string;
  wordCount: number;
}

export interface BroadcastHealth {
  /** "live", "complete", or whatever lifecycle status the broadcast
   * is in. Drives whether wallSeconds is "live now" or "frozen at
   * last cycle". */
  broadcastStatus: BroadcastStatus;
  wallSeconds: number;
  contentSeconds: number;
  proseSeconds: number;
  targetSeconds: number;
  cycleCount: number;
  generationCount: number;
  /** Per-phase max content seconds the engine has observed. Useful
   * for the inspector header tooltip — shows where the content
   * accumulated. */
  contentByPhase: Record<string, number>;
}

export function computeBroadcastHealth(input: {
  broadcastStatus: BroadcastStatus;
  cycles: CycleInput[];
  generations: GenerationInput[];
  nowMs: number;
}): BroadcastHealth {
  const { broadcastStatus, cycles, generations, nowMs } = input;

  // Wall-clock — first cycle to either now (live) or last cycle
  // (complete). Returns 0 when no cycles have run yet.
  let wallSeconds = 0;
  if (cycles.length > 0) {
    const first = cycles[0].triggeredAt;
    const end =
      broadcastStatus === "complete"
        ? cycles[cycles.length - 1].triggeredAt
        : nowMs;
    wallSeconds = Math.max(0, (end - first) / 1000);
  }

  // Content — max phaseSecond per live phase, summed. Halftime gap
  // is excluded by construction.
  const phaseMaxSeconds: Record<string, number> = {};
  for (const cycle of cycles) {
    const entries = Array.isArray(cycle.chunkEntries) ? cycle.chunkEntries : [];
    for (const e of entries) {
      const data = (e as { data?: Record<string, unknown> })?.data;
      if (!data) continue;
      const phase = typeof data.phase === "string" ? data.phase : null;
      const phaseSecond =
        typeof data.phaseSecond === "number" ? data.phaseSecond : null;
      if (!phase || phaseSecond === null) continue;
      const current = phaseMaxSeconds[phase] ?? 0;
      if (phaseSecond > current) phaseMaxSeconds[phase] = phaseSecond;
    }
  }
  const contentSeconds = Array.from(LIVE_PHASES).reduce(
    (sum, p) => sum + (phaseMaxSeconds[p] ?? 0),
    0,
  );

  // Prose + target — accumulated per cycle. Generation lookup is by
  // id so cycles that skipped (generationId null) contribute 0 prose
  // but still contribute to target if the curator asked for words.
  const generationsById = new Map(generations.map((g) => [g.id, g]));
  let proseSeconds = 0;
  let targetSeconds = 0;
  for (const cycle of cycles) {
    const wpm = deriveWpm(cycle.curation);
    const recommendedWordCount = readRecommendedWordCount(cycle.curation);
    if (recommendedWordCount !== null) {
      targetSeconds += (recommendedWordCount * 60) / wpm;
    }
    if (cycle.generationId) {
      const gen = generationsById.get(cycle.generationId);
      if (gen) {
        proseSeconds += (gen.wordCount * 60) / wpm;
      }
    }
  }

  return {
    broadcastStatus,
    wallSeconds,
    contentSeconds,
    proseSeconds,
    targetSeconds,
    cycleCount: cycles.length,
    generationCount: generations.length,
    contentByPhase: phaseMaxSeconds,
  };
}

/** Per-cycle drift summary — the four quantities the inspector
 * compares to read whether a single cycle is "in step", and a
 * categorical band for visual encoding in the scrub strip. Pure
 * derivation from one cycle row + the prior cycle's triggeredAt
 * (for cadence) + the matching generation row (for prose). */
export interface CycleDrift {
  /** Wall-clock seconds between this cycle's flush and the prior
   * one. `null` for the very first cycle of a broadcast. */
  cadenceSeconds: number | null;
  /** Content-time seconds covered within this cycle's entries
   * (max − min phaseSecond, when entries share a phase). `null`
   * for cross-phase or unstamped cycles. */
  contentSeconds: number | null;
  /** Prose duration produced — wordCount × 60 / WPM. Always a
   * number; `0` when the cycle had no generation. Robust to TTS
   * failure since audio doesn't enter this calculation. */
  proseSeconds: number;
  /** Curator's word-budget target — recommendedWordCount × 60 /
   * WPM. `null` when the curation snapshot has no pacing target. */
  targetSeconds: number | null;
  /** Categorical drift band — visual encoding for the scrub strip.
   *   - `ok`    : all available signals within 10s of cadence
   *   - `warn`  : 10–30s gap somewhere
   *   - `bad`   : >30s gap somewhere
   *   - `unknown`: not enough signal to judge (e.g. first cycle,
   *               or cycle with no generation and no pacing target)
   */
  driftBand: "ok" | "warn" | "bad" | "unknown";
}

/** Pure helper — compute per-cycle drift for the scrub strip + the
 * inspector toolbar pills. Both surfaces consume the same shape so
 * the colour bands stay consistent. */
export function computeCycleDrift(input: {
  cycle: { chunkEntries: unknown; curation: unknown; generationId: string | null };
  generation: { wordCount: number } | null;
  prevTriggeredAtMs: number | null;
  thisTriggeredAtMs: number;
}): CycleDrift {
  const { cycle, generation, prevTriggeredAtMs, thisTriggeredAtMs } = input;

  const cadenceSeconds =
    prevTriggeredAtMs !== null
      ? Math.max(0, (thisTriggeredAtMs - prevTriggeredAtMs) / 1000)
      : null;

  const contentSeconds = withinPhaseContentSeconds(cycle.chunkEntries);

  const wpm = deriveWpm(cycle.curation);
  const proseSeconds = generation ? (generation.wordCount * 60) / wpm : 0;
  const recommendedWordCount = readRecommendedWordCount(cycle.curation);
  const targetSeconds =
    recommendedWordCount !== null ? (recommendedWordCount * 60) / wpm : null;

  // Drift band — pick the worst gap among the available pairs.
  // Cadence is the reference rhythm; content + prose are compared
  // to it. Skipped cycles (no generation, no pacing) yield
  // `unknown` rather than masquerading as healthy.
  const gaps: number[] = [];
  if (cadenceSeconds !== null && contentSeconds !== null) {
    gaps.push(Math.abs(contentSeconds - cadenceSeconds));
  }
  if (cadenceSeconds !== null && proseSeconds > 0) {
    gaps.push(Math.abs(proseSeconds - cadenceSeconds));
  }
  if (contentSeconds !== null && proseSeconds > 0) {
    gaps.push(Math.abs(proseSeconds - contentSeconds));
  }
  let driftBand: CycleDrift["driftBand"];
  if (gaps.length === 0) {
    driftBand = "unknown";
  } else {
    const worst = Math.max(...gaps);
    driftBand = worst >= 30 ? "bad" : worst >= 10 ? "warn" : "ok";
  }

  return { cadenceSeconds, contentSeconds, proseSeconds, targetSeconds, driftBand };
}

/** Within-phase content seconds for a single cycle. Returns `null`
 * when entries cross phases (span isn't meaningful) or are
 * unstamped. Used by both broadcast-level + per-cycle paths. */
function withinPhaseContentSeconds(chunkEntries: unknown): number | null {
  if (!Array.isArray(chunkEntries)) return null;
  let minSec = Infinity;
  let maxSec = -Infinity;
  let phase: string | null = null;
  for (const e of chunkEntries) {
    const data = (e as { data?: Record<string, unknown> })?.data;
    if (!data) continue;
    const ph = typeof data.phase === "string" ? data.phase : null;
    const sec = typeof data.phaseSecond === "number" ? data.phaseSecond : null;
    if (!ph || sec === null) continue;
    if (phase === null) phase = ph;
    else if (phase !== ph) return null;
    if (sec < minSec) minSec = sec;
    if (sec > maxSec) maxSec = sec;
  }
  if (minSec === Infinity || maxSec === -Infinity) return null;
  return Math.max(0, maxSec - minSec);
}

/** Derive the cycle's effective WPM from its pacing snapshot.
 * `recommendedWordCount / (cadenceMs / 60_000) → words per minute`.
 * Falls back to DEFAULT_WPM when pacing isn't present or the
 * derivation produces a non-finite value (curator skipped, fields
 * missing on legacy rows). */
function deriveWpm(curation: unknown): number {
  const pacing = readPacing(curation);
  if (!pacing) return DEFAULT_WPM;
  const wordCount = pacing.recommendedWordCount;
  const cadenceMs = pacing.cadenceMs;
  if (typeof wordCount !== "number" || typeof cadenceMs !== "number") {
    return DEFAULT_WPM;
  }
  if (cadenceMs <= 0 || wordCount <= 0) return DEFAULT_WPM;
  const wpm = (wordCount * 60_000) / cadenceMs;
  return Number.isFinite(wpm) && wpm > 0 ? wpm : DEFAULT_WPM;
}

function readRecommendedWordCount(curation: unknown): number | null {
  const pacing = readPacing(curation);
  if (!pacing) return null;
  return typeof pacing.recommendedWordCount === "number"
    ? pacing.recommendedWordCount
    : null;
}

function readPacing(
  curation: unknown,
): { recommendedWordCount?: unknown; cadenceMs?: unknown } | null {
  if (!curation || typeof curation !== "object") return null;
  const pacing = (curation as { pacing?: unknown }).pacing;
  if (!pacing || typeof pacing !== "object") return null;
  return pacing as { recommendedWordCount?: unknown; cadenceMs?: unknown };
}
