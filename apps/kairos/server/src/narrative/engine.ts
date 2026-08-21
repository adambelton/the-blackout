import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Feed } from "../feed.js";
import type { WebSocket } from "ws";
import type { GenerationContext, NarrativeCover, NarrativeImagery, NarrativeOutput } from "./types.js";
import { selectImagery } from "./imagery.js";
import type { GeneratorTense } from "./generator.js";
import type {
  GenerationSpecContent,
  ImagerySpecContent,
  SummarySpecContent,
} from "./spec-types.js";
import { listPoolItems } from "../db/content-pool.js";
import type { LLMClient } from "../llm/types.js";
import { LLMRateLimitError } from "../llm/types.js";
import type { CuratedPayload } from "../curation/types.js";
import type { BroadcastStateTracker } from "../curation/state-tracker.js";
import {
  collectContextText,
  collectModeratorDirectives,
  collectVoiceText,
  generate,
  type RawCover,
} from "./generator.js";
import {
  clampMonotonicMinute,
  computeBatchEntries,
  deriveCurrentSubjectMinute,
  earliestSubjectMinute,
  getSubjectPhase,
  getSubjectPhaseSecond,
  toAssembled,
} from "./helpers.js";
import {
  assembleRunningSummary,
  extractNarrativeBlock,
  formatStateBlock,
  updateNarrativeBlock,
} from "./summary.js";
import { formatRefrainStatus, type RefrainBudget } from "./refrain.js";
import { subjectOrdinalForEntry } from "../pipeline/subject-time.js";
import { db } from "../db/client.js";
import { generations, sources as sourcesTable } from "../db/schema.js";
import type { FeedEntry } from "../types.js";
import { checkGenerationInvariants } from "../invariants.js";
import { captureEvent } from "../telemetry.js";

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Defaults for the cycle-duration word target. 150 wpm is a natural
// narrator pace; 0.8 utilization leaves a small gap between cycles so
// the narrator doesn't bleed audio into the next flush window.
const DEFAULT_NARRATION_WPM = 150;
const DEFAULT_UTILIZATION = 0.8;

export interface NarrativeEngineOptions {
  /** Wall-clock duration of a pipeline cycle; drives the target-words calculation. */
  cycleDurationMs?: number;
  /** Assumed TTS words-per-minute for the configured narrator voice. */
  narrationWpm?: number;
  /** Fraction of the cycle window the narrator should fill. Leaves breathing room before the next cycle. */
  utilization?: number;
  /** Designated refrain phrases with per-phase / total budgets. Passed through from broadcast config. */
  refrains?: RefrainBudget[];
  /** Resolved `generation` / `imagery` / `summary` service specs for
   * the broadcast's event profile. Each null when no row exists for
   * the profile — the engine falls back to baseline-only assembly
   * for that surface. Resolved by `ServiceRegistry` at activation. */
  generationSpec?: GenerationSpecContent | null;
  imagerySpec?: ImagerySpecContent | null;
  summarySpec?: SummarySpecContent | null;
  /** `BroadcastConfig.generator.tense` (`past` | `present` | `dynamic`).
   * When set, appended to the system prompt as a config-derived
   * tense directive. */
  tense?: GeneratorTense;
  /** `BroadcastConfig.imagery.enabled` (default true). When false,
   * the imagery selector short-circuits to `hold` without a Haiku
   * call — saves cost when the consumer doesn't want imagery. */
  imageryEnabled?: boolean;
}

interface RunInputs {
  /**
   * The entries the generator should describe. Always
   * `curated.entries` — curation's selection. The earlier
   * `generateNow` escape hatch that built its own raw set from the
   * feed was retired 2026-04-26 (the closing-passage regression
   * traced to it).
   */
  entries: import("../types.js").FeedEntry[];
  triggerReason: CuratedPayload["triggerReason"];
  mode: CuratedPayload["context"]["mode"];
  summary?: string;
  /** Threads ContextCurator picked for this cycle. The generator only
   * acts on them when mode is context_led; non-context cycles ignore
   * the list. */
  relevantThreads?: CuratedPayload["context"]["relevantThreads"];
  /** Curated pacing (recommendedWordCount + cadenceMs). When present,
   * its `recommendedWordCount` is the authority — the engine prefers
   * this over its own derivation because PacingService has already
   * computed `wpm × cycleMs × phaseModifier` against the measured
   * consumer wpm. */
  pacing?: CuratedPayload["context"]["pacing"];
  /** Opaque preamble text supplied by the consumer for an off-
   * schedule (`external`) cycle. Lives on the curated payload (not on
   * context) because curation never reads it; threaded straight from
   * `curated.consumerPrompt` to the generator. Undefined on normal
   * cycles. */
  consumerPrompt?: string;
  /** Content ordinal up to which this cycle has authority. The
   * generator filters cross-cycle reads (e.g. canonicalEvents
   * preamble) to entries with ordinal ≤ this value so it doesn't
   * narrate ahead of the prose's own content-time horizon. Undefined
   * when the cycle was assembled outside the cadence path (legacy
   * test fixtures), in which case no filter is applied. */
  drainBoundaryOrdinal?: number;
  extraSnapshot: Record<string, unknown>;
}

/**
 * Thin lifecycle wrapper around generation. The engine:
 *
 *   1. Pulls `narrative_voice` and `narrative_context` entries from the
 *      feed cache and hands them to the generator, which assembles the
 *      system prompt. If either source has no content the generator
 *      falls back to an internal default.
 *   2. Calls the generator with the curation-trimmed batch; the
 *      bounded-context concern lives in curation's `reconcileBudget`
 *      so a single high-volume source can't blow past the LLM's
 *      token-per-minute cap.
 *   3. Persists each generation with the prose, the tool-reported
 *      `covers` list, usage and assembly metadata.
 *   4. Emits `narrative` (with covers) or `generation_skipped` (on rate
 *      limit) to WS subscribers.
 */
export class NarrativeEngine {
  // Monotonic floor for the emitted `contentTime`. Prevents a late-
  // arriving entry from an earlier phase pulling the consumer-side
  // content clock backwards on the next cycle's audio-start snap.
  // Resets to null on rehydrate — first post-rehydrate cycle is
  // unclamped by design. See `docs/vocabulary.md` § Time.
  private lastEmittedContentTime: number | null = null;

  // In-flight background work fired off the cycle return path —
  // primarily the Haiku summary refinement. Tests await `drainPendingWork`
  // before asserting on LLM call counts; production code can ignore it.
  private pendingWork = new Set<Promise<unknown>>();

  constructor(
    private broadcastId: string,
    private feed: Feed,
    private subscribers: Set<WebSocket>,
    private llm: LLMClient,
    private stateTracker: BroadcastStateTracker,
    private options: NarrativeEngineOptions = {},
  ) {}

  /**
   * Wait for any in-flight background work (summary refinement) to
   * settle. Test-facing — production code never needs this; the
   * background work is bounded by the next cycle's tick.
   */
  async drainPendingWork(): Promise<void> {
    if (this.pendingWork.size === 0) return;
    await Promise.allSettled(Array.from(this.pendingWork));
  }

  async driveGeneration(curated: CuratedPayload): Promise<NarrativeOutput | null> {
    return this.run({
      entries: curated.entries,
      triggerReason: curated.triggerReason,
      mode: curated.context.mode,
      summary: curated.context.summary,
      relevantThreads: curated.context.relevantThreads,
      pacing: curated.context.pacing,
      consumerPrompt: curated.consumerPrompt,
      drainBoundaryOrdinal: curated.drainBoundaryOrdinal,
      extraSnapshot: {
        curatedEntryIds: curated.entries.map((e) => e.id),
        curatedAnnotations: curated.annotations.length,
        curationMode: curated.context.mode,
        relevantThreads: curated.context.relevantThreads?.map((t) => t.threadId) ?? [],
      },
    });
  }

  // `generateNow` was retired in the 2026-04-26 retro pass. It used
  // to bypass the curator entirely — pulled the raw feed, ambient-
  // filtered, and ran straight to generation. That path was the
  // source of the post-FT regression passage during the FA Cup SF
  // (the closing-passage trigger flowed through it and the narrator
  // mined uncovered earlier-half texture). The canonical path —
  // `CyclePipeline.flush({consumerPrompt?})` — covers every use
  // case the bypass did, including off-schedule triggers and empty
  // buffers, while keeping curation as the sole authority on
  // selection. Removing the method locks the principle in.

  destroy(): void {
    // No timers to clean up. Kept for lifecycle symmetry with the runtime.
  }

  /**
   * Haiku narrative-block refresh, fired off the critical path after
   * the cycle returns. Updates only the in-memory state tracker; the
   * persisted generation row carries the pre-refinement templated
   * summary (so rehydrate always has current state + the previous
   * cycle's narrative block, even if the process dies before this
   * completes). On failure the templated fallback stays in place.
   */
  private async refineSummaryInBackground(args: {
    narrativeId: string;
    previousNarrative: string;
    justNarrated: string;
    newEntries: FeedEntry[];
    stateBlock: string;
  }): Promise<void> {
    const startMs = Date.now();
    try {
      const refined = await updateNarrativeBlock({
        client: this.llm,
        previousNarrative: args.previousNarrative,
        justNarrated: args.justNarrated,
        newEntries: args.newEntries,
        summarySpec: this.options.summarySpec,
      });
      const refinedSummary = assembleRunningSummary(args.stateBlock, refined);
      this.stateTracker.setRunningSummary(refinedSummary);
      captureEvent({
        name: "summary_refined",
        broadcastId: this.broadcastId,
        properties: {
          "narrative.id": args.narrativeId,
          "summary.durationMs": Date.now() - startMs,
          "summary.outcome": "refined",
        },
      });
    } catch (err) {
      console.warn(
        `[narrative] background summary refinement failed, templated summary stays: ${(err as Error).message}`,
      );
      captureEvent({
        name: "summary_refined",
        broadcastId: this.broadcastId,
        properties: {
          "narrative.id": args.narrativeId,
          "summary.durationMs": Date.now() - startMs,
          "summary.outcome": "failed",
        },
      });
    }
  }

  /**
   * Pull the previous generation's prose, summary, and flush boundary
   * in a single query. These three drive the delta-prompt architecture:
   *
   *   - `previousPassage` feeds the tone-carry preamble
   *   - `runningSummary` is the narrator's compressed memory
   *   - `sinceTimestamp` marks the feed boundary — entries strictly
   *     newer than this are the "delta" the generator actually sees
   *
   * On the first cycle of a broadcast all three come back undefined
   * and the engine degrades gracefully (no summary, no previous
   * passage, full-feed context mode).
   */
  private async getPriorState(): Promise<{
    previousPassage?: string;
    runningSummary?: string;
    sinceTimestamp?: number;
    priorGenerations: Array<{ output: string; phase: string | null }>;
    /** Rationale from the previous cycle's imagery selector — feeds
     * into this cycle's decision so Haiku can judge whether to hold
     * or change based on what's currently on screen. */
    previousImageryRationale?: string;
  }> {
    const rows = await db
      .select({
        output: generations.output,
        context: generations.contextPackage,
        triggeredAt: generations.triggeredAt,
      })
      .from(generations)
      .where(eq(generations.broadcastId, this.broadcastId))
      .orderBy(desc(generations.triggeredAt));

    if (rows.length === 0) return { priorGenerations: [] };

    const latest = rows[0];
    const latestCtx = (latest.context ?? {}) as {
      runningSummary?: string;
      imagery?: { rationale?: string };
    };
    const priorGenerations = rows.map((r) => {
      const ctx = (r.context ?? {}) as { currentSubjectPhase?: string | null };
      return { output: r.output, phase: ctx.currentSubjectPhase ?? null };
    });

    return {
      previousPassage: latest.output,
      runningSummary: (latestCtx.runningSummary ?? this.stateTracker.getRunningSummary()) || undefined,
      sinceTimestamp: latest.triggeredAt.getTime(),
      priorGenerations,
      previousImageryRationale: latestCtx.imagery?.rationale,
    };
  }

  private computeTargetWords(
    pacing?: { recommendedWordCount: number; cadenceMs: number },
  ): { targetWords: number; cycleDurationSeconds: number; wpmSource: "measured" | "config" | "pacing" } | null {
    const cycleMs = this.options.cycleDurationMs;
    if (!cycleMs || cycleMs <= 0) return null;
    const measured = this.stateTracker.getEstimatedWpm();
    const cycleDurationSeconds = Math.round(cycleMs / 1000);

    // Curated pacing has authority. PacingService computes
    // `wpm × cycleMs × phaseModifier` against the measured consumer
    // wpm and the actual cycle interval — exactly the calculation the
    // engine used to derive itself, but with the correct cycle
    // duration and a phase-aware modifier. When present, prefer it.
    if (pacing && pacing.recommendedWordCount > 0) {
      return {
        targetWords: pacing.recommendedWordCount,
        cycleDurationSeconds,
        wpmSource: "pacing",
      };
    }

    // Fallback: engine's own derivation. Reached on pre-curation
    // cold-start paths where no pacing decision has been written into
    // the curation context yet.
    const configWpm = this.options.narrationWpm ?? DEFAULT_NARRATION_WPM;
    const wpm = measured ?? configWpm;
    const utilization = this.options.utilization ?? DEFAULT_UTILIZATION;
    const targetWords = Math.max(1, Math.round((cycleDurationSeconds * wpm * utilization) / 60));
    return { targetWords, cycleDurationSeconds, wpmSource: measured != null ? "measured" : "config" };
  }

  private broadcastToSubscribers(message: Record<string, unknown>): void {
    const payload = JSON.stringify(message);
    for (const ws of this.subscribers) ws.send(payload);
  }

  private async run({ entries, triggerReason, mode, summary, relevantThreads, pacing, consumerPrompt, drainBoundaryOrdinal, extraSnapshot }: RunInputs): Promise<NarrativeOutput | null> {
    const allEntries = this.feed.getAll();
    const prior = await this.getPriorState();
    // Summary precedence: curator's per-cycle summary (rare today) →
    // the running summary carried forward on the state tracker → the
    // one stored on the previous generation. Empty on the opening cycle.
    const runningSummary = summary?.trim() || prior.runningSummary || "";
    const deltaMode = prior.sinceTimestamp != null;

    // Generator context comes from the caller-provided entries — in the
    // canonical path, that's curation's selection. No parallel "assembly"
    // scan of the whole feed here: curation is the only authority on
    // drops, and the generator reads exactly what the caller passed.
    if (entries.length === 0) return null;
    const lastEntry = entries[entries.length - 1];
    const currentSubjectPhase = lastEntry ? getSubjectPhase(lastEntry) : undefined;
    const currentSubjectPhaseSecond = lastEntry ? getSubjectPhaseSecond(lastEntry) : undefined;
    const ctx: GenerationContext = {
      entries: entries.map(toAssembled),
      currentSubjectMinute: deriveCurrentSubjectMinute(entries),
      ...(currentSubjectPhase ? { currentSubjectPhase } : {}),
      ...(currentSubjectPhaseSecond != null ? { currentSubjectPhaseSecond } : {}),
    };

    const voice = collectVoiceText(allEntries);
    const context = collectContextText(allEntries);
    const moderatorDirectives = collectModeratorDirectives(allEntries);
    const target = this.computeTargetWords(pacing);
    const refrainStatus = formatRefrainStatus(
      this.options.refrains,
      prior.priorGenerations,
      ctx.currentSubjectPhase ?? null,
    );
    const startedAt = Date.now();

    try {
      // Canonical events — the authoritative record of state-changing
      // moments (whatever the consumer marks `canonical: true`). These
      // are the running summary's antidote: Haiku sometimes drops facts
      // from its compressed summary, so the raw canonical entries pass
      // into the generator as ground truth alongside the (now-advisory)
      // running summary.
      //
      // Filtered by the cycle's drain boundary so the preamble doesn't
      // leak forward — an event whose entry has just arrived in the
      // waiting room but hasn't yet been drained into a cycle's chunk
      // shouldn't appear as ground truth for prose that's narrating
      // earlier content. Without this filter, a goal that lands at
      // cycle N is "reported" in N's prose (because it's in the
      // global feed) before its entry drains into cycle N+1's chunk
      // — listeners hear the consequence before the cause.
      const canonicalEvents = allEntries.filter((e) => {
        if (!e.sourceCanonical || e.sourceType !== "event") return false;
        if (drainBoundaryOrdinal === undefined) return true;
        const ord = subjectOrdinalForEntry(e);
        return ord === null || ord <= drainBoundaryOrdinal;
      });

      // Pre-generate the narrative id so the imagery_decision WS
      // message can reference the narrative the consumer is about to
      // receive — without waiting for the DB insert. The insert below
      // will set this id explicitly rather than letting Postgres
      // assign one.
      const narrativeId = randomUUID();

      // Fetch the current pool. Kept cheap — 30s cadence × O(50)
      // items means a trivial DB hit per cycle. Hot-path caching is
      // easy to add later if the pool grows much larger.
      const poolItems = await listPoolItems(this.broadcastId).catch((err) => {
        console.warn(
          `[narrative] pool fetch failed, proceeding without pool: ${(err as Error).message}`,
        );
        return [];
      });

      // Narrative generation (Sonnet) and imagery selection (Haiku)
      // run in parallel against the same curated context. Imagery
      // finishes first (much cheaper); we fire an early
      // `imagery_decision` WS message the moment it resolves so the
      // consumer's image pipeline (Blackout's Replicate call, when
      // the decision is `generate`) starts in parallel with Sonnet
      // rather than sequentially after it. `pool` hits skip
      // generation entirely — the consumer already has the bytes.
      const imageryPromise = selectImagery({
        client: this.llm,
        ctx,
        mode: mode ?? "enrichment_led",
        summary: runningSummary,
        previousImageryRationale: prior.previousImageryRationale ?? "",
        poolItems,
        imagerySpec: this.options.imagerySpec,
        imageryEnabled: this.options.imageryEnabled,
      })
        .catch((err) => {
          console.warn(
            `[narrative] imagery selection failed, holding previous: ${(err as Error).message}`,
          );
          const fallback: NarrativeImagery = {
            decision: "hold",
            rationale: `imagery call failed: ${(err as Error).message.slice(0, 80)}`,
          };
          return fallback;
        })
        .then((imagery) => {
          // Fire the early-decision WS message as soon as Haiku
          // finishes. Consumer can kick downstream image work now;
          // the full `narrative` message still ships on Sonnet
          // completion with the same imagery payload attached.
          this.broadcastToSubscribers({
            type: "imagery_decision",
            narrativeId,
            broadcastId: this.broadcastId,
            imagery,
          });
          return imagery;
        });

      const [result, imagery] = await Promise.all([
        generate(this.llm, ctx, {
          voice,
          context,
          mode,
          summary: runningSummary,
          canonicalEvents,
          previousPassage: prior.previousPassage,
          targetWords: target?.targetWords,
          cycleDurationSeconds: target?.cycleDurationSeconds,
          deltaMode,
          refrainStatus: refrainStatus || undefined,
          relevantThreads,
          consumerPrompt,
          moderatorDirectives,
          generationSpec: this.options.generationSpec,
          tense: this.options.tense,
        }),
        imageryPromise,
      ]);
      const durationMs = Date.now() - startedAt;

      const curatedEntryIds = entries.map((e) => e.id);
      const { accepted: validCovers, phantomCount } = filterPhantomCovers(
        result.covers,
        curatedEntryIds,
      );
      const from = allEntries[0]?.id ?? "";
      const to = allEntries[allEntries.length - 1]?.id ?? "";

      // The cycle's batch — see `computeBatchEntries` for the contract.
      // Distinct from what the generator saw (`entries`, which is
      // curation's subset): the batch is everything the cycle observed,
      // regardless of what curation chose to surface.
      const batchEntries = computeBatchEntries(allEntries, prior.sinceTimestamp ?? null);
      const batchEntryIds = batchEntries.map((e) => e.id);

      // Earliest subject time across the batch — parsed-leading-int
      // (so `"45+2"` → 45, `"pre_match"` → null). The cycle's
      // **content-time anchor**: consumers drive the content clock
      // from this, snapping to the subject minute the narrator is
      // beginning from as each passage's audio starts. Clamped to the
      // monotonic floor (the last emitted value) so a late-arriving
      // entry from an earlier phase can't pull the clock backwards.
      // See `docs/vocabulary.md` § Time.
      const rawContentTime = earliestSubjectMinute(batchEntries);
      const contentTime = clampMonotonicMinute(
        rawContentTime,
        this.lastEmittedContentTime,
      );
      if (
        rawContentTime != null &&
        contentTime != null &&
        rawContentTime < contentTime
      ) {
        console.warn(
          `[narrative] contentTime clamped to monotonic floor: raw=${rawContentTime} floor=${this.lastEmittedContentTime}`,
        );
      }
      if (contentTime != null) this.lastEmittedContentTime = contentTime;

      // Running summary — two glued blocks:
      //  - Canonical state: regenerated from the live canonical events
      //    list every cycle. Templated (no Haiku). Cannot drift.
      //  - Narrative arc: Haiku produces a short note about arc /
      //    motifs / tone, constrained by prompt to never touch state.
      //
      // The state block is refreshed synchronously (cheap, templated)
      // and glued to the previous cycle's narrative block to produce
      // `templatedSummary`. That's what we persist on this generation
      // row and set on the state tracker immediately — so the next
      // cycle (and any rehydrate) has current state + carried-over
      // narrative even before the Haiku refinement lands.
      //
      // The Haiku narrative-block refresh runs in the background after
      // this cycle returns — see `refineSummaryInBackground` below. On
      // success it replaces the in-memory summary with the refined
      // narrative block. On failure (or if the next cycle ticks first)
      // the templated fallback stays — same degrade-gracefully path as
      // the previous synchronous try/catch.
      const deltaEntries = entries;
      const previousNarrative = extractNarrativeBlock(runningSummary);
      const stateBlock = formatStateBlock(canonicalEvents);
      const templatedSummary = assembleRunningSummary(stateBlock, previousNarrative);
      this.stateTracker.setRunningSummary(templatedSummary);

      const [row] = await db
        .insert(generations)
        .values({
          id: narrativeId,
          broadcastId: this.broadcastId,
          triggerReason,
          contextPackage: {
            entries: ctx.entries,
            currentSubjectMinute: ctx.currentSubjectMinute,
            currentSubjectPhase: ctx.currentSubjectPhase ?? null,
            currentSubjectPhaseSecond: ctx.currentSubjectPhaseSecond ?? null,
            feedWindow: { from, to },
            includedEntryIds: curatedEntryIds,
            toolCallFailed: result.toolCallFailed,
            summaryPresent: Boolean(runningSummary.trim()),
            previousPassagePresent: Boolean(prior.previousPassage?.trim()),
            targetWords: target?.targetWords ?? null,
            cycleDurationSeconds: target?.cycleDurationSeconds ?? null,
            wpmSource: target?.wpmSource ?? null,
            deltaMode,
            runningSummary: templatedSummary,
            imagery,
            ...extraSnapshot,
          },
          output: result.text,
          wordCount: wordCount(result.text),
          tokenUsage: result.usage,
          durationMs,
          covers: validCovers,
        })
        .returning();

      const output: NarrativeOutput = {
        id: row.id,
        broadcastId: this.broadcastId,
        text: result.text,
        generatedAt: row.triggeredAt.getTime(),
        feedWindow: { from, to },
        usage: result.usage,
        covers: validCovers,
        batchEntryIds,
        contentTime,
        imagery,
      };

      this.stateTracker.recordGeneration({
        id: row.id,
        triggeredAt: row.triggeredAt.getTime(),
        wordCount: row.wordCount,
        triggerReason,
      });

      this.broadcastToSubscribers({ type: "narrative", narrative: output });

      // Domain-agnostic postcondition checks — log + PostHog capture
      // any known-bad pattern the generation exhibits.
      checkGenerationInvariants({
        broadcastId: this.broadcastId,
        narrativeId: output.id,
        covers: validCovers,
        includedEntryIds: curatedEntryIds,
        phantomCoverCount: phantomCount,
        toolCallFailed: result.toolCallFailed,
      });

      // Routine telemetry — every generation lands an event so we can
      // build dashboards of word-count distribution, latency, trigger
      // mix etc. without forensics.
      captureEvent({
        name: "narration_generated",
        broadcastId: this.broadcastId,
        properties: {
          "narrative.id": output.id,
          "narrative.wordCount": row.wordCount,
          "narrative.triggerReason": triggerReason,
          "narrative.coversCount": validCovers.length,
          "narrative.durationMs": durationMs,
          "narrative.inputTokens": result.usage?.inputTokens ?? 0,
          "narrative.outputTokens": result.usage?.outputTokens ?? 0,
          "narrative.cacheReadTokens": result.usage?.cacheReadInputTokens ?? 0,
          "narrative.cacheCreateTokens": result.usage?.cacheCreationInputTokens ?? 0,
          "narrative.deltaMode": deltaMode,
          "narrative.targetWords": target?.targetWords ?? null,
          "narrative.contextSize": curatedEntryIds.length,
          "narrative.batchSize": batchEntryIds.length,
        },
      });

      const targetSuffix = target ? ` target=${target.targetWords}w(${target.wpmSource})` : "";
      const cacheRead = result.usage?.cacheReadInputTokens ?? 0;
      const cacheCreate = result.usage?.cacheCreationInputTokens ?? 0;
      const cacheSuffix = (cacheRead || cacheCreate)
        ? ` [cache: ${cacheRead} read / ${cacheCreate} write]`
        : "";
      const modeSuffix = deltaMode ? ` delta(${deltaEntries.length})` : "";
      console.log(
        `[narrative] generated ${output.id} (${result.usage?.inputTokens}in/${result.usage?.outputTokens}out${cacheSuffix}, ${row.wordCount}w${targetSuffix}${modeSuffix}, ${validCovers.length} covers, trigger=${triggerReason}): ${result.text.slice(0, 80)}...`,
      );

      // Kick off the Haiku narrative-block refresh off the critical
      // path. The cycle returns now; the refinement updates the
      // in-memory summary when it lands (typically within 1–2s, well
      // before the next tick). Tracked in `pendingWork` so tests can
      // drain it before asserting on LLM call counts.
      const summaryPromise = this.refineSummaryInBackground({
        narrativeId: output.id,
        previousNarrative,
        justNarrated: result.text,
        newEntries: deltaEntries,
        stateBlock,
      });
      this.pendingWork.add(summaryPromise);
      summaryPromise.finally(() => this.pendingWork.delete(summaryPromise));

      return output;
    } catch (err) {
      if (err instanceof LLMRateLimitError) {
        console.warn(
          `[narrative] rate limited (retry-after ${err.retryAfterMs ?? "unknown"}ms) — generation skipped`,
        );
        this.broadcastToSubscribers({
          type: "generation_skipped",
          reason: "rate_limited",
          retryAfterMs: err.retryAfterMs,
          triggerReason,
        });
        captureEvent({
          name: "generation_skipped",
          broadcastId: this.broadcastId,
          properties: {
            reason: "rate_limited",
            retryAfterMs: err.retryAfterMs ?? null,
            triggerReason,
          },
        });
        return null;
      }
      console.error(`[narrative] generation failed:`, (err as Error).message);
      return null;
    }
  }
}

/**
 * Strip covers the LLM reported that aren't in the cycle's curated
 * entry set. Phantom covers are a real failure mode — the model
 * occasionally cites entry ids that were never in its context — and
 * leaving them in the persisted record breaks the consumer's reveal
 * contract (the UI maps cover ids back to entries; an unknown id is
 * silently ignored, but it also signals invariant breakage that the
 * `phantom_covers_present` postcondition catches).
 *
 * Pure function — exported for unit testing the contract.
 */
export function filterPhantomCovers(
  covers: RawCover[],
  allowed: string[],
): { accepted: NarrativeCover[]; phantomCount: number } {
  const allowedSet = new Set(allowed);
  const accepted: NarrativeCover[] = [];
  const phantoms: string[] = [];

  for (const cover of covers) {
    if (allowedSet.has(cover.entryId)) {
      const accepted_: NarrativeCover = { entryId: cover.entryId };
      if (cover.subjectTime) accepted_.subjectTime = cover.subjectTime;
      if (cover.charOffset != null) accepted_.charOffset = cover.charOffset;
      accepted.push(accepted_);
    } else {
      phantoms.push(cover.entryId);
    }
  }

  if (phantoms.length > 0) {
    console.warn(`[narrative] dropped ${phantoms.length} phantom cover id(s): ${phantoms.join(", ")}`);
  }

  return { accepted, phantomCount: phantoms.length };
}

