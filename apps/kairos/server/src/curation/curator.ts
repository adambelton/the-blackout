import type { EnrichedPayload, EnrichmentAnnotation, CuratorFeedback } from "../enrichment/types.js";
import { FEEDBACK_OUTCOMES } from "../enrichment/types.js";
import type { ServiceRegistry } from "../registry.js";
import type { BroadcastStateTracker } from "./state-tracker.js";
import type { CurationContext, CuratedPayload, ConflictResolution, CurationDecision, CurationMode, CurationService } from "./types.js";
import type { FeedEntry } from "../types.js";
import type { NarrativeOutput } from "../narrative/types.js";
import type { TriggerReason } from "../db/enums.js";
import type { RecentCyclesBuffer } from "./recent-cycles.js";

/** Structural duck-type for the context_curator's recency-mark hook —
 * the curator calls this after `decideMode` lands on `context_led`. The
 * type isn't surfaced as a public interface because no other service
 * has equivalent state today; if more services need post-mode hooks
 * we'll formalise it. */
interface ContextCuratorLike extends CurationService {
  markThreadsUsed(threadIds: Iterable<string>): void;
}

const DEFAULT_PACING: CurationContext["pacing"] = {
  recommendedWordCount: 130,
  cadenceMs: 45_000,
};

export interface CurationResult {
  curated: CuratedPayload | null;
  /** What the handler produced (usually the engine's narrative output). */
  handlerResult: NarrativeOutput | null;
  /** Per-service wall-clock duration in ms, keyed by service name.
   * Populated whenever curate() runs. Surfaced to the pipeline so
   * cycle_timing telemetry can show which curation services dominate. */
  perServiceMs: Record<string, number>;
  /** Wall-clock duration of the onCurated handler (= narrative engine
   * driveGeneration — includes generation LLM + summary update + DB
   * insert). 0 if no handler is registered. */
  handlerMs: number;
}

export type CuratedHandler = (payload: CuratedPayload) => Promise<NarrativeOutput | null>;

/**
 * Default token ceiling for the curated payload. Tuned for the
 * Anthropic Starter plan's 30k input-tokens-per-minute cap on
 * claude-sonnet-4-6, with headroom for the system prompt + response +
 * occasional retries. Moved here from the retired assembly stage in
 * Phase 2 of the pipeline-fix plan.
 */
const DEFAULT_MAX_CONTEXT_TOKENS = 20_000;

export interface CuratorOptions {
  /** Hard ceiling on the tokens curation hands to the generator. */
  maxContextTokens?: number;
  /** Pipeline flush interval in ms. Threaded into the curation context
   * so PacingService can size word counts to the actual cycle window
   * (`words ≈ wpm × cycleMs / 60000 × phaseModifier`). */
  cycleIntervalMs: number;
}

export class Curator {
  private onCurated: CuratedHandler | null = null;

  constructor(
    private registry: ServiceRegistry,
    private stateTracker: BroadcastStateTracker,
    private recentCycles: RecentCyclesBuffer | undefined,
    private options: CuratorOptions,
  ) {}

  setOnCurated(handler: CuratedHandler): void {
    this.onCurated = handler;
  }

  async curate(
    enriched: EnrichedPayload,
    triggerReason: TriggerReason = "accumulation",
    consumerPrompt?: string,
  ): Promise<CurationResult> {
    // Silence is no longer a valid outcome (designed 2026-04-22). Even
    // when the cycle has no new entries or annotations, the curator
    // runs through to `decideMode`, which falls to context_led — the
    // narrator pulls from accumulated character/world context rather
    // than from this cycle's source material. The generator handles
    // empty selections by leaning on the narrative_context briefs.
    const serviceLastSurfacedAt = await this.registry.getLastSurfacedAtMap();

    const initial: CurationContext = {
      selectedEntries: [...enriched.entries],
      selectedAnnotations: [...enriched.annotations],
      decisions: buildBaselineDecisions(enriched.entries),
      conflicts: [],
      mode: "enrichment_led",
      triggerReason,
      pacing: { ...DEFAULT_PACING },
      maxContextTokens: this.options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      elapsedMs: this.stateTracker.getElapsedMs(),
      estimatedWpm: this.stateTracker.getEstimatedWpm(),
      cycleIntervalMs: this.options.cycleIntervalMs,
      serviceLastSurfacedAt,
      recentCycles: this.recentCycles?.list() ?? [],
    };

    // Tier-parallel execution. Each tier's services run concurrently
    // against the same input context (they don't read each other's
    // writes — guarantee enforced by the seed's tier definition). Their
    // outputs are merged into the next tier's input. Tiers themselves
    // run sequentially because each tier reads what the previous tier
    // wrote (e.g. priority needs arcPhase from tier 1; conflict_resolver
    // needs decisions.priority from tier 2).
    const tiers = this.registry.getCurationServiceTiers();
    let context = initial;
    const perServiceMs: Record<string, number> = {};
    const perTierMs: number[] = [];

    for (let tierIdx = 0; tierIdx < tiers.length; tierIdx++) {
      const ready = tiers[tierIdx].filter((s) => s.isReady());
      if (ready.length === 0) {
        perTierMs.push(0);
        continue;
      }

      const tierStarted = Date.now();
      const priorContext = context;
      const results = await Promise.all(
        ready.map(async (service) => {
          const started = Date.now();
          const next = await service.curate(enriched, priorContext);
          return { service, next, durationMs: Date.now() - started };
        }),
      );

      context = mergeTierResults(priorContext, results);
      perTierMs.push(Date.now() - tierStarted);

      for (const { service, durationMs } of results) {
        perServiceMs[service.name] = durationMs;
        console.log(
          `[curator] tier${tierIdx + 1}/${service.name}: ${context.decisions[service.name]?.action ?? "no decision"} (${durationMs}ms)`,
        );
      }
    }
    console.log(`[curator] tier wall-clock: ${perTierMs.map((ms, i) => `t${i + 1}=${ms}ms`).join(" ")}`);

    // Apply service-driven removals centrally. Services express
    // "this entry is noise" by adding ids to their `entriesRemoved`
    // decision; this pass unions them, drops canonical ids from the
    // removal set silently (canonical entries are state-changing facts,
    // never noise), then filters `selectedEntries` and dependent
    // annotations. Keeping the canonical guard here — not inside each
    // service — means a service can't bypass the contract.
    context = applyRemovals(context);

    // Budget reconciliation — curation's final authority on what the
    // generator sees. Runs after every ranking service so priority
    // emphasis, urgent subjects, and canonical events are known; then
    // evicts lowest-priority entries until the selection fits the
    // token ceiling. Replaces the oldest-first eviction the retired
    // assembly stage used to do (Phase 2 of the pipeline-fix plan).
    context = reconcileBudget(context);

    // Pendulum: decide the mode of this cycle's passage. Priority
    // emphasis (a canonical entry was surfaced) pulls the cycle to
    // action_led. SaturationResolver setting `forceContextLed` (every
    // annotation in the cycle is stale against the recent window)
    // pulls it to context_led — the cycle has nothing fresh to say
    // about the action, so the passage reaches into the pre-match
    // world. Total absence of annotations also leans context_led.
    // Everything else stays enrichment_led.
    //
    // Silence is not a valid outcome here. If a phase warrants no
    // narration at all, suppression happens upstream of curation;
    // once curation runs, it always produces.
    const mode = decideMode(context);
    context = { ...context, mode };

    // Mark surfaced threads as used when the cycle is going to actually
    // narrate from them. Action / enrichment cycles don't consume the
    // surfaced list, so leaving the recency tracker untouched there
    // keeps those threads "fresh" for the next context-led opportunity.
    if (mode === "context_led" && context.relevantThreads && context.relevantThreads.length > 0) {
      const contextCurator = this.registry.getCurationServices().find(
        (s): s is ContextCuratorLike => s.name === "context_curator" && typeof (s as ContextCuratorLike).markThreadsUsed === "function",
      );
      contextCurator?.markThreadsUsed(context.relevantThreads.map((t) => t.threadId));
    }

    const curated: CuratedPayload = {
      broadcastId: enriched.broadcastId,
      entries: context.selectedEntries,
      annotations: context.selectedAnnotations,
      originalAnnotations: [...enriched.annotations],
      context,
      triggerReason: context.triggerReason,
      consumerPrompt,
      drainBoundaryOrdinal: enriched.drainBoundaryOrdinal,
      generatedAt: Date.now(),
    };

    console.log(
      `[curator] curated: mode=${mode}, ${curated.entries.length} entries, ${curated.annotations.length}/${curated.originalAnnotations.length} annotations kept (trigger=${curated.triggerReason})`,
    );

    let handlerResult: NarrativeOutput | null = null;
    let handlerMs = 0;
    if (this.onCurated) {
      const handlerStarted = Date.now();
      try {
        handlerResult = await this.onCurated(curated);
      } catch (err) {
        console.error(`[curator] onCurated handler failed:`, (err as Error).message);
      }
      handlerMs = Date.now() - handlerStarted;
    }

    return { curated, handlerResult, perServiceMs, handlerMs };
  }

  /**
   * Per-subject feedback dispatch. Every annotation produced by the
   * enrichment pass gets one of four outcomes; subjects that never
   * appeared in an annotation receive no feedback and their state
   * holds unchanged.
   *
   * A service can receive multiple feedback messages in a single cycle
   * — one per subject it reported on.
   */
  async sendFeedback(curated: CuratedPayload): Promise<void> {
    const emphasizedEntryIds = new Set(
      Object.values(curated.context.decisions).flatMap((d) => d.entriesEmphasized),
    );
    const keptKeys = new Set(
      curated.annotations.map((a) => annotationKey(a.serviceName, a.subjectId)),
    );
    const enrichmentServices = this.registry.getEnrichmentServices();
    const serviceByName = new Map(enrichmentServices.map((s) => [s.name, s]));

    const touchedWithEmphasis = new Set<string>();

    for (const annotation of curated.originalAnnotations) {
      const service = serviceByName.get(annotation.serviceName);
      if (!service) continue;

      const outcome = determinePerAnnotationOutcome(annotation, {
        kept: keptKeys,
        conflicts: curated.context.conflicts,
        emphasizedEntryIds,
      });

      const feedback: CuratorFeedback = {
        serviceName: annotation.serviceName,
        subjectId: annotation.subjectId,
        outcome,
      };

      if (outcome === FEEDBACK_OUTCOMES.KILLED_WITH_REPLACEMENT) {
        const conflict = curated.context.conflicts.find(
          (c) => c.loser.serviceName === annotation.serviceName && c.loser.subjectId === annotation.subjectId,
        );
        if (conflict?.replacementReading) {
          feedback.replacementReading = conflict.replacementReading;
        }
      }

      service.confirmSurfaced(feedback);

      if (
        outcome === FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS ||
        outcome === FEEDBACK_OUTCOMES.ACKNOWLEDGED
      ) {
        touchedWithEmphasis.add(annotation.serviceName);
      }
    }

    for (const serviceName of touchedWithEmphasis) {
      await this.registry.touchSurfacedAt(serviceName);
    }

    console.log(
      `[curator] feedback dispatched for ${curated.originalAnnotations.length} annotations (${curated.context.conflicts.length} conflicts)`,
    );
  }
}

/**
 * Merge the results of services that ran concurrently within a tier.
 *
 * Each service in a parallel tier receives the same `prior` and returns
 * a `next` that spreads `...prior` and overrides only the fields it
 * writes. The tier definition (in the seed) guarantees disjoint
 * single-writer fields within a tier, so the merge is straightforward:
 *
 *   - `decisions`: union by key — each service writes its own entry
 *     under its own service name.
 *   - `conflicts`: each service may append; we concat all the deltas
 *     beyond `prior.conflicts`.
 *   - `forceContextLed`: true wins — only saturation sets it today,
 *     but the merge rule lets any future service force the pivot.
 *   - All other fields: take any value that diverged from `prior`. If
 *     two services both wrote the same field that's a tier-composition
 *     bug (the seed enforces correct grouping), and last-writer wins.
 */
export function mergeTierResults(
  prior: CurationContext,
  results: Array<{ next: CurationContext }>,
): CurationContext {
  const merged: CurationContext = { ...prior };

  for (const { next } of results) {
    merged.decisions = { ...merged.decisions, ...next.decisions };

    if (next.conflicts.length > prior.conflicts.length) {
      const delta = next.conflicts.slice(prior.conflicts.length);
      merged.conflicts = [...merged.conflicts, ...delta];
    }

    if (next.forceContextLed) merged.forceContextLed = true;

    if (next.arcPhase !== prior.arcPhase) merged.arcPhase = next.arcPhase;
    if (next.urgentSubjects !== prior.urgentSubjects) merged.urgentSubjects = next.urgentSubjects;
    if (next.summary !== prior.summary) merged.summary = next.summary;
    if (next.pacing !== prior.pacing) merged.pacing = next.pacing;
    if (next.selectedEntries !== prior.selectedEntries) merged.selectedEntries = next.selectedEntries;
    if (next.selectedAnnotations !== prior.selectedAnnotations) {
      merged.selectedAnnotations = next.selectedAnnotations;
    }
  }

  return merged;
}

function annotationKey(serviceName: string, subjectId: string): string {
  return `${serviceName}::${subjectId}`;
}

/**
 * The curator's baseline emphasis seed. Every entry from a
 * `canonical: true` source is auto-emphasised before any curation
 * service runs — the consumer's source-level flag is a fact-level
 * declaration of priority and the LLM-driven priority service
 * should not be asked to second-guess it.
 *
 * Domain-agnostic — uses only the source-level flag the consumer
 * already configures. Returns an empty decisions object when no
 * canonical entries are in the chunk so the cycle's mode falls
 * through to enrichment_led / context_led naturally.
 */
export function buildBaselineDecisions(
  entries: FeedEntry[],
): Record<string, CurationDecision> {
  const emphasised = entries.filter((e) => e.sourceCanonical).map((e) => e.id);
  if (emphasised.length === 0) return {};
  return {
    canonical_emphasis: {
      serviceName: "canonical_emphasis",
      action: `auto-emphasised ${emphasised.length} canonical entries`,
      entriesRemoved: [],
      entriesEmphasized: emphasised,
    },
  };
}

/**
 * Resolve the pendulum mode for a cycle. The three rules, in order:
 *
 *   1. ANY emphasis from any decision wins → action_led. Whether it
 *      came from the curator's canonical_emphasis baseline (canonical
 *      entries are auto-emphasised), from the priority service
 *      surfacing high-divergence annotations, or from any future
 *      emphasiser — if something is emphasised, the cycle is about
 *      what's happening in the feed.
 *   2. `forceContextLed` set by saturation_resolver → context_led.
 *      Every annotation was stale against the recent window, so the
 *      cycle has nothing fresh to say about the action or the
 *      enrichment. The passage reaches into the pre-match world.
 *   3. No annotations at all → context_led. Same outcome, different
 *      reason: nothing to enrich from in this cycle.
 *
 * Otherwise: enrichment_led — annotations exist and at least one
 * carries something worth saying.
 */
export function decideMode(ctx: CurationContext): CurationMode {
  const anyEmphasis = Object.values(ctx.decisions).some(
    (d) => (d.entriesEmphasized?.length ?? 0) > 0,
  );
  if (anyEmphasis) return "action_led";
  if (ctx.forceContextLed) return "context_led";
  if (ctx.selectedAnnotations.length === 0) return "context_led";
  return "enrichment_led";
}

/**
 * Per-annotation outcome resolution.
 *
 *   KILLED_WITH_REPLACEMENT   — this annotation lost a conflict
 *   IGNORED                   — curator dropped the annotation
 *   DELIVERED_WITH_EMPHASIS   — annotation is kept and informed an
 *                                emphasised entry
 *   ACKNOWLEDGED              — kept but not emphasised
 */
export function determinePerAnnotationOutcome(
  annotation: EnrichmentAnnotation,
  ctx: {
    kept: Set<string>;
    conflicts: ConflictResolution[];
    emphasizedEntryIds: Set<string>;
  },
): CuratorFeedback["outcome"] {
  const lostConflict = ctx.conflicts.some(
    (c) => c.loser.serviceName === annotation.serviceName && c.loser.subjectId === annotation.subjectId,
  );
  if (lostConflict) return FEEDBACK_OUTCOMES.KILLED_WITH_REPLACEMENT;

  const key = annotationKey(annotation.serviceName, annotation.subjectId);
  if (!ctx.kept.has(key)) return FEEDBACK_OUTCOMES.IGNORED;

  const wasEmphasised = annotation.informedBy.some((id) => ctx.emphasizedEntryIds.has(id));
  return wasEmphasised ? FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS : FEEDBACK_OUTCOMES.ACKNOWLEDGED;
}

/**
 * Consolidate every service's `entriesRemoved` decision into a single
 * filter pass, with a deterministic canonical guard.
 *
 * Services express "this entry is noise" by adding ids to their
 * `entriesRemoved` decision rather than mutating `selectedEntries`
 * themselves — that keeps the canonical-never-evict guarantee in one
 * place. A canonical entry id appearing in any decision is silently
 * dropped from the removal set; the entry survives. The canonical
 * guard here mirrors `reconcileBudget`'s — capacity and quality both
 * defer to the consumer's source-level `canonical: true` flag.
 *
 * Annotations whose `informedBy` ids all fell out are dropped to
 * mirror `reconcileBudget`'s annotation cascade.
 */
export function applyRemovals(ctx: CurationContext): CurationContext {
  const removed = new Set<string>();
  for (const decision of Object.values(ctx.decisions)) {
    for (const id of decision.entriesRemoved) removed.add(id);
  }
  if (removed.size === 0) return ctx;

  let canonicalProtected = 0;
  for (const entry of ctx.selectedEntries) {
    if (entry.sourceCanonical && removed.delete(entry.id)) canonicalProtected++;
  }
  if (canonicalProtected > 0) {
    console.log(
      `[curator] applyRemovals: protected ${canonicalProtected} canonical entr${canonicalProtected === 1 ? "y" : "ies"} from service-driven removal`,
    );
  }
  if (removed.size === 0) return ctx;

  const survivingEntries = ctx.selectedEntries.filter((e) => !removed.has(e.id));
  const survivingAnnotations = ctx.selectedAnnotations.filter(
    (a) => !(a.informedBy ?? []).every((id) => removed.has(id)),
  );

  return {
    ...ctx,
    selectedEntries: survivingEntries,
    selectedAnnotations: survivingAnnotations,
  };
}

/**
 * Final curation pass: trim `selectedEntries` to fit `maxContextTokens`.
 *
 * Priority ordering (highest kept first):
 *   1. Canonical entries are never evicted. They're the authoritative
 *      state-changing moments (goals, cards, subs in a sporting context)
 *      and losing one to a budget cap would silently break the
 *      narrator's ground-truth record.
 *   2. Entries the priority service marked as emphasis.
 *   3. Entries carrying annotations — enrichment found something worth
 *      saying about them.
 *   4. Everything else.
 *
 * Within a tier, newer-first (timestamp descending) — the narrator
 * generally cares about what just happened more than what happened
 * ten minutes ago, and older same-tier entries are more likely to have
 * been addressed by an earlier cycle's passage anyway.
 *
 * Evicted entries have their annotations dropped from
 * `selectedAnnotations` if *all* of an annotation's `informedBy` ids
 * fell out — an annotation informed by at least one surviving entry
 * can still be meaningful.
 */
export function reconcileBudget(ctx: CurationContext): CurationContext {
  const totalCost = ctx.selectedEntries.reduce(
    (sum, e) => sum + estimateEntryTokens(e),
    0,
  );
  if (totalCost <= ctx.maxContextTokens) return ctx;

  const emphasised = new Set(
    Object.values(ctx.decisions).flatMap((d) => d.entriesEmphasized),
  );
  const annotated = new Set(
    ctx.selectedAnnotations.flatMap((a) => a.informedBy ?? []),
  );

  const scored = ctx.selectedEntries.map((entry) => {
    let score: number;
    if (entry.sourceCanonical) score = 4;
    else if (emphasised.has(entry.id)) score = 3;
    else if (annotated.has(entry.id)) score = 2;
    else score = 1;
    return { entry, score };
  });

  scored.sort((a, b) =>
    a.score !== b.score ? b.score - a.score : b.entry.timestamp - a.entry.timestamp,
  );

  const kept: typeof scored = [];
  const evicted: typeof scored = [];
  let running = 0;
  for (const item of scored) {
    const cost = estimateEntryTokens(item.entry);
    if (item.score >= 4 || running + cost <= ctx.maxContextTokens) {
      kept.push(item);
      running += cost;
    } else {
      evicted.push(item);
    }
  }

  if (evicted.length === 0) return ctx;

  const keptEntries = kept.map((k) => k.entry);
  const keptIds = new Set(keptEntries.map((e) => e.id));
  const survivingAnnotations = ctx.selectedAnnotations.filter((a) =>
    (a.informedBy ?? []).some((id) => keptIds.has(id)),
  );

  const evictedIds = evicted.map((e) => e.entry.id);
  console.log(
    `[curator] budget_reconciler: evicted ${evicted.length}/${scored.length} entries ` +
      `(${running}/${ctx.maxContextTokens} tokens kept)`,
  );

  return {
    ...ctx,
    selectedEntries: keptEntries,
    selectedAnnotations: survivingAnnotations,
    decisions: {
      ...ctx.decisions,
      budget_reconciler: {
        serviceName: "budget_reconciler",
        action: `evicted ${evicted.length} entries for token budget`,
        entriesRemoved: evictedIds,
        entriesEmphasized: [],
        meta: {
          totalCostBefore: totalCost,
          totalCostAfter: running,
          maxContextTokens: ctx.maxContextTokens,
        },
      },
    },
  };
}

// Token-cost estimation — ~4 chars per token plus a small per-entry
// overhead for the prompt wrapper. Same approximation as the retired
// assembly stage used, so the ceiling has the same practical meaning.
const APPROX_CHARS_PER_TOKEN = 4;
const PER_ENTRY_OVERHEAD_CHARS = 20;

function estimateEntryTokens(entry: { data: { content?: unknown } }): number {
  const raw = entry.data.content;
  const content = typeof raw === "string" ? raw : JSON.stringify(entry.data);
  const chars = content.length + PER_ENTRY_OVERHEAD_CHARS;
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
}
