import type { LLMClient } from "../llm/types.js";
import type {
  EnrichmentService,
  EnrichmentReading,
  EnrichmentAnnotation,
  FeedChunk,
  CuratorFeedback,
  ServiceSpec,
  SubjectState,
  SubjectStateMap,
} from "./types.js";
import { FEEDBACK_OUTCOMES } from "./types.js";
import { runBriefInitialization, runEnrichmentLLM } from "./llm-enrichment.js";
import {
  assembleBriefInitializationSystemPrompt,
  assemblePerCycleSystemPrompt,
} from "./prompt-assembly.js";
import {
  mergeBaselineWithSpec,
  readEnrichmentSpec,
  type EnrichmentBaselineSections,
} from "./baseline-loader.js";

/**
 * Per-service LLM scaffolding. Subclasses return one of these from
 * `config()`; the base class assembles every runtime + brief-init call
 * around it so subclass bodies stay focused on the per-concept content
 * (the constants and `isMaterialShift` judgement) rather than the
 * boilerplate.
 *
 * `briefInitializationGuidance` is optional — services that learn
 * purely from live evidence (patterns_echoes) leave it undefined and
 * skip brief-init.
 */
export interface EnrichmentServiceConfig {
  concept: string;
  subjectGuidance: string;
  readingGuidance: string;
  readingSchema: Record<string, unknown>;
  briefExtractionGuidance: string;
  briefInitializationGuidance?: string;
}

/**
 * Three-state per-subject enrichment service.
 *
 * A service tracks an unbounded set of subjects; each subject carries
 * three independent readings:
 *
 *   - `expressed`    — what the audience has been told (advances on
 *                      DELIVERED_WITH_EMPHASIS)
 *   - `unexpressed`  — the service's running truth, recomputed each
 *                      cycle from the new chunk and prior state
 *   - `acknowledged` — snapshot of the reading at the time of a light
 *                      surfacing (ACKNOWLEDGED). Used to suppress
 *                      repeat annotations when nothing has changed
 *                      since the last ack.
 *
 * Subclasses own their `TReading` shape and their `process()` logic.
 * They call `upsertUnexpressed` to register/update subjects and
 * `buildAnnotation` to emit one per subject whose reading diverged
 * from the last acknowledged reading (checked via `shouldEmitAnnotation`).
 */
export abstract class BaseEnrichmentService<TReading extends EnrichmentReading>
  implements EnrichmentService {
  abstract readonly name: string;

  protected expressed: SubjectStateMap<TReading> = {};
  protected unexpressed: SubjectStateMap<TReading> = {};
  protected acknowledged: SubjectStateMap<TReading> = {};

  private hasProcessed = false;

  /** Per-service prompt scaffolding, merged once at construction.
   * Baseline sections come from `<service>.baseline.md` (loaded at
   * subclass module init); per-profile elaboration comes from the
   * resolved spec row. Result is the section content the per-cycle
   * and brief-init prompts pick from. */
  private readonly mergedBaseline: EnrichmentBaselineSections;
  private readonly readingSchema: Record<string, unknown>;

  constructor(
    readonly spec: ServiceSpec,
    protected readonly llm: LLMClient,
    baseline: EnrichmentBaselineSections,
    readingSchema: Record<string, unknown>,
  ) {
    this.mergedBaseline = mergeBaselineWithSpec(baseline, readEnrichmentSpec(spec.spec));
    this.readingSchema = readingSchema;
  }

  /** Per-service prompt scaffolding + reading schema. Built from
   * the merged baseline; subclasses don't override this. */
  protected config(): EnrichmentServiceConfig {
    return {
      concept: this.mergedBaseline.concept,
      subjectGuidance: this.mergedBaseline.subjectGuidance,
      readingGuidance: this.mergedBaseline.readingGuidance,
      readingSchema: this.readingSchema,
      briefExtractionGuidance: this.mergedBaseline.briefExtractionGuidance,
      briefInitializationGuidance: this.mergedBaseline.briefInitializationGuidance,
    };
  }

  /**
   * Default cycle implementation: run the enrichment LLM with the
   * subclass's config, fold each report into `unexpressed`, emit an
   * annotation for every subject whose reading materially shifted.
   * Empty chunks short-circuit. Subclasses with a different shape
   * (none today) can override.
   */
  async process(chunk: FeedChunk): Promise<EnrichmentAnnotation[]> {
    this.markProcessed();
    if (chunk.entries.length === 0) return [];

    const cfg = this.config();
    const hasBrief = (chunk.narrativeContext?.length ?? 0) > 0;
    const reports = await runEnrichmentLLM({
      client: this.llm,
      systemPrompt: assemblePerCycleSystemPrompt(cfg, hasBrief),
      readingSchema: cfg.readingSchema,
      knownSubjects: this.getKnownSubjects(),
      states: {
        expressed: this.getExpressedStates(),
        unexpressed: this.getUnexpressedStates(),
        acknowledged: this.getAcknowledgedStates(),
      },
      chunk,
    });

    const annotations: EnrichmentAnnotation[] = [];
    for (const r of reports) {
      this.upsertUnexpressed(r.subjectId, r.label, r.reading as TReading);
      if (this.shouldEmitAnnotation(r.subjectId)) {
        const ann = this.buildAnnotation(r.subjectId, r.basis, r.informedBy);
        if (ann) annotations.push(ann);
      }
    }
    return annotations;
  }

  getExpressedStates(): SubjectStateMap {
    return structuredClone(this.expressed) as SubjectStateMap;
  }

  getUnexpressedStates(): SubjectStateMap {
    return structuredClone(this.unexpressed) as SubjectStateMap;
  }

  getAcknowledgedStates(): SubjectStateMap {
    return structuredClone(this.acknowledged) as SubjectStateMap;
  }

  hydrateStates(
    expressed: SubjectStateMap,
    unexpressed: SubjectStateMap,
    acknowledged: SubjectStateMap,
  ): void {
    this.expressed = structuredClone(expressed) as SubjectStateMap<TReading>;
    this.unexpressed = structuredClone(unexpressed) as SubjectStateMap<TReading>;
    this.acknowledged = structuredClone(acknowledged) as SubjectStateMap<TReading>;
    this.markProcessed();
  }

  /**
   * Default brief-initialisation implementation. Subclasses that want to
   * lift subject priors from the brief override `briefInitializationConfig`
   * to declare their LLM client + per-service prompt scaffolding; this
   * method then runs the one-shot Haiku call and seeds the resulting
   * subjects into `unexpressed`. Skipped (no-op) when the subclass
   * returns null (e.g. `patterns_echoes`, which is purely
   * live-evidence-driven), when state is already hydrated from
   * persistence, or when the brief is empty.
   */
  async initializeFromBrief(brief: string): Promise<void> {
    if (this.hasProcessed) return; // already hydrated from persistence
    if (!brief.trim()) return;

    const config = this.briefInitializationConfig();
    if (!config) return;

    const reports = await runBriefInitialization({
      client: config.client,
      systemPrompt: assembleBriefInitializationSystemPrompt(config),
      readingSchema: config.readingSchema,
      brief,
    });

    for (const r of reports) {
      this.upsertUnexpressed(r.subjectId, r.label, r.reading as TReading);
    }
    if (reports.length > 0) {
      console.log(
        `[${this.name}] brief-init: seeded ${reports.length} subject(s) — ${reports.map((r) => r.subjectId).join(", ")}`,
      );
      this.markProcessed();
    }
  }

  /**
   * Brief-init config derived from `config()` plus the optional
   * `briefInitializationGuidance`. Services that learn purely from
   * live evidence (patterns_echoes today) leave the guidance
   * undefined and are skipped here. Subclasses can override for
   * custom shapes (none do today).
   */
  protected briefInitializationConfig(): {
    client: LLMClient;
    concept: string;
    subjectGuidance: string;
    readingSchema: Record<string, unknown>;
    readingGuidance: string;
    initializationGuidance: string;
  } | null {
    const cfg = this.config();
    if (!cfg.briefInitializationGuidance) return null;
    return {
      client: this.llm,
      concept: cfg.concept,
      subjectGuidance: cfg.subjectGuidance,
      readingSchema: cfg.readingSchema,
      readingGuidance: cfg.readingGuidance,
      initializationGuidance: cfg.briefInitializationGuidance,
    };
  }

  /**
   * Apply per-subject feedback.
   *
   *   EMPHASIS  : expressed[id]    := unexpressed[id]; clear acknowledged
   *   ACK       : acknowledged[id] := unexpressed[id]
   *   IGNORED   : no-op (state holds; unexpressed continues to accumulate)
   *   KILLED    : with replacement → all three become the replacement
   *               without            → unexpressed reverts to expressed,
   *                                    acknowledged cleared
   */
  confirmSurfaced(feedback: CuratorFeedback): void {
    const { subjectId, outcome, replacementReading } = feedback;

    switch (outcome) {
      case FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS: {
        const unx = this.unexpressed[subjectId];
        if (!unx) return;
        this.expressed[subjectId] = structuredClone(unx);
        delete this.acknowledged[subjectId];
        return;
      }
      case FEEDBACK_OUTCOMES.ACKNOWLEDGED: {
        const unx = this.unexpressed[subjectId];
        if (!unx) return;
        this.acknowledged[subjectId] = structuredClone(unx);
        return;
      }
      case FEEDBACK_OUTCOMES.KILLED_WITH_REPLACEMENT: {
        if (replacementReading) {
          const label = this.unexpressed[subjectId]?.label
            ?? this.expressed[subjectId]?.label
            ?? this.acknowledged[subjectId]?.label
            ?? subjectId;
          const replaced: SubjectState<TReading> = {
            label,
            reading: structuredClone(replacementReading) as TReading,
          };
          this.expressed[subjectId] = replaced;
          this.unexpressed[subjectId] = structuredClone(replaced);
          delete this.acknowledged[subjectId];
          return;
        }
        const exp = this.expressed[subjectId];
        if (exp) {
          this.unexpressed[subjectId] = structuredClone(exp);
        } else {
          delete this.unexpressed[subjectId];
        }
        delete this.acknowledged[subjectId];
        return;
      }
      case FEEDBACK_OUTCOMES.IGNORED:
      default:
        return;
    }
  }

  isReady(): boolean {
    return this.hasProcessed;
  }

  protected markProcessed(): void {
    this.hasProcessed = true;
  }

  reset(): void {
    this.expressed = {};
    this.unexpressed = {};
    this.acknowledged = {};
    this.hasProcessed = false;
  }

  /** Create or update a subject's unexpressed reading. */
  protected upsertUnexpressed(subjectId: string, label: string, reading: TReading): void {
    this.unexpressed[subjectId] = { label, reading: structuredClone(reading) };
  }

  /**
   * True iff the subject has an unexpressed reading that the service
   * judges to have materially shifted from its prior state. The default
   * implementation preserves the historical behaviour — byte-equality
   * against the last acknowledged reading. Subclasses override
   * `isMaterialShift` to apply concept-specific judgement (e.g.
   * momentum's "direction changed OR intensity moved ≥ 2 levels").
   */
  protected shouldEmitAnnotation(subjectId: string): boolean {
    const unx = this.unexpressed[subjectId];
    if (!unx) return false;
    const ack = this.acknowledged[subjectId];
    const exp = this.expressed[subjectId];
    return this.isMaterialShift(
      { acknowledged: ack?.reading ?? null, expressed: exp?.reading ?? null },
      unx.reading,
    );
  }

  /**
   * Per-service judgement: is the candidate reading materially different
   * from what the subject has previously surfaced? Materiality is a
   * domain-specific question — each service knows what counts as a
   * shift in its own reading shape (per K14 + the repetition-fix round).
   *
   * Inputs:
   *   - `prior.acknowledged` — last reading lightly surfaced (or null).
   *   - `prior.expressed`    — last reading delivered with emphasis (or null).
   *   - `candidate`          — the reading the service has just produced.
   *
   * Default: byte-equality against `acknowledged`. When both prior
   * snapshots are null (first appearance), the candidate is always
   * treated as a material shift. Services override to apply
   * domain-shaped tests (see momentum, tension_conflict, etc.).
   */
  protected isMaterialShift(
    prior: { acknowledged: TReading | null; expressed: TReading | null },
    candidate: TReading,
  ): boolean {
    if (!prior.acknowledged) return true;
    return !readingsEqual(prior.acknowledged, candidate);
  }

  /** Assemble the annotation for a subject currently in `unexpressed`. */
  protected buildAnnotation(
    subjectId: string,
    basis: string,
    informedBy: string[],
  ): EnrichmentAnnotation | null {
    const unx = this.unexpressed[subjectId];
    if (!unx) return null;
    const exp = this.expressed[subjectId];
    const ack = this.acknowledged[subjectId];
    return {
      serviceName: this.name,
      subjectId,
      subjectLabel: unx.label,
      meaning: {
        expressed: exp ? structuredClone(exp.reading) : null,
        unexpressed: structuredClone(unx.reading),
        acknowledged: ack ? structuredClone(ack.reading) : null,
        basis,
      },
      informedBy: [...informedBy],
    };
  }

  /**
   * Union of known subjects across all three state maps, preferring
   * the freshest label available (unexpressed > expressed > acknowledged).
   * Used for the "known subjects" block the prompt shows to the LLM so
   * it reuses stable ids.
   */
  protected getKnownSubjects(): Array<{ id: string; label: string }> {
    const seen = new Map<string, string>();
    for (const [id, state] of Object.entries(this.unexpressed)) seen.set(id, state.label);
    for (const [id, state] of Object.entries(this.expressed)) if (!seen.has(id)) seen.set(id, state.label);
    for (const [id, state] of Object.entries(this.acknowledged)) if (!seen.has(id)) seen.set(id, state.label);
    return Array.from(seen, ([id, label]) => ({ id, label }));
  }
}

/** Deterministic equality for jsonb-friendly reading shapes. */
function readingsEqual(a: EnrichmentReading, b: EnrichmentReading): boolean {
  return JSON.stringify(canonicalise(a)) === JSON.stringify(canonicalise(b));
}

function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonicalise((value as Record<string, unknown>)[k])] as const);
    return Object.fromEntries(entries);
  }
  return value;
}
