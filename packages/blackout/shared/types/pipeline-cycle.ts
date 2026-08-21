/**
 * Pipeline-cycle shapes exposed by Kairos and proxied by the Blackout
 * server for the inspector UI. Mirror Kairos's JSON payloads one-to-one
 * so the client can consume them directly.
 */

/** Mirror of Kairos's `trigger_reason` enum (`apps/kairos/server/src/db/enums.ts`).
 * Two values: `accumulation` for scheduled cycles (buffer empty or full —
 * curation handles selection by mode), `external` for consumer-driven
 * off-schedule cycles (e.g. halftime / closing-passage triggers carrying
 * an opaque `consumerPrompt` text). The earlier `significant_event` /
 * `gap` / `improv` values were never load-bearing — collapsed into
 * `accumulation` by Kairos migration `0006_trigger_reason_collapse.sql`. */
export type PipelineTriggerReason = "accumulation" | "external";

/** Sub-classification of the flush that produced a cycle. Distinct
 * from `PipelineTriggerReason` so the inspector can show admins which
 * trigger fired without widening the existing enum. Nullable on
 * cycles persisted before migration `0007`. */
export type PipelineFlushTrigger = "cadence" | "phase" | "consumer_prompt";

/** Per-stage wall-clock breakdown captured for every cycle. Shape
 * mirrors Kairos's `cycle_timing` PostHog event. Nullable on cycles
 * persisted before migration `0007`. */
export interface PipelineCycleTimingMs {
  totalMs: number;
  enrichmentMs: number;
  curationServicesMs: number;
  handlerMs: number;
  perServiceEnrichmentMs: Record<string, number>;
  perServiceCurationMs: Record<string, number>;
}

/** Per-cycle drift summary — the four quantities the inspector
 * compares to read whether a single cycle is "in step", and a
 * categorical band for visual encoding in the scrub strip. Computed
 * server-side so the strip can render 200 rows without per-cycle
 * round-trips. */
export interface PipelineCycleDrift {
  cadenceSeconds: number | null;
  contentSeconds: number | null;
  proseSeconds: number;
  targetSeconds: number | null;
  driftBand: "ok" | "warn" | "bad" | "unknown";
}

/** Summary shape returned by `GET /broadcasts/:id/cycles`. */
export interface PipelineCycleSummary {
  id: string;
  triggeredAt: number;
  triggerReason: PipelineTriggerReason;
  flushTrigger: PipelineFlushTrigger | null;
  generationId: string | null;
  entryCount: number;
  annotationCount: number;
  drift: PipelineCycleDrift;
}

/**
 * Full shape returned by `GET /broadcasts/:id/cycles/:cycleId`. The
 * nested fields are structurally typed loosely — the inspector renders
 * them opportunistically and accepts whatever Kairos decides to include.
 */
export interface PipelineCycleDetail {
  id: string;
  broadcastId: string;
  triggeredAt: number;
  triggerReason: PipelineTriggerReason;
  flushTrigger: PipelineFlushTrigger | null;
  chunkEntries: PipelineCycleEntry[];
  annotations: PipelineCycleAnnotation[];
  curation: PipelineCycleCuration;
  timingMs: PipelineCycleTimingMs | null;
  generationId: string | null;
}

export interface PipelineCycleEntry {
  id: string;
  sourceName?: string;
  sourceType?: string;
  timestamp?: number;
  data: Record<string, unknown>;
}

export interface PipelineCycleAnnotation {
  serviceName: string;
  subjectId?: string;
  subjectLabel?: string;
  meaning?: Record<string, unknown>;
  basis?: string;
  informedBy?: string[];
}

export interface PipelineCycleCuration {
  forceContextLed?: boolean;
  skipped?: boolean;
  decisions?: Record<string, PipelineCurationDecision>;
  conflicts?: PipelineCurationConflict[];
  summary?: string | null;
  pacing?: { recommendedWordCount?: number; cadenceMs?: number };
  selectedEntryIds?: string[];
  selectedAnnotations?: PipelineCycleAnnotation[];
  triggerReason?: PipelineTriggerReason;
}

export interface PipelineCurationDecision {
  serviceName: string;
  action: string;
  entriesRemoved: string[];
  entriesEmphasized: string[];
}

export interface PipelineCurationConflict {
  winner: { serviceName: string; subjectId: string };
  loser: { serviceName: string; subjectId: string };
  reason: string;
  replacementReading?: Record<string, unknown>;
}

/**
 * Imagery selection persisted under `generation.contextPackage.imagery`.
 * Mirrors `ImagerySelection` in `apps/kairos/server/src/narrative/imagery.ts`
 * with the fields the inspector needs to render. Optional fields are
 * present only on certain decision branches (or absent on legacy
 * generations persisted before the field landed).
 */
export interface PipelineImageryDecision {
  decision: "pool" | "generate" | "hold";
  /** The image brief Haiku articulated before deciding pool vs
   * generate — the standard the decision is measured against. */
  requirement?: string;
  /** Set when `decision === "generate"`. */
  prompt?: string;
  /** Set when `decision === "pool"`. */
  poolItemId?: string;
  /** Denormalised snapshot of the matched pool item — captured at
   * decision time so the inspector can show what was actually
   * matched even if the pool item has since been edited. */
  matchedPoolItem?: { id: string; prompt: string; tags: string[] };
  /** Haiku's editorial commentary on the pick. */
  rationale?: string;
}

/**
 * Flow-health summary returned by `GET /broadcasts/:id/health`. The
 * inspector header renders these four numbers side-by-side: in a
 * healthy broadcast they converge on the same value (~5400s for a
 * 90-minute match). Drift between any two surfaces a different
 * failure mode — see `docs/design-problem-content-time-batching.md`.
 */
export interface BroadcastHealth {
  broadcastStatus: string;
  /** Wall-clock seconds since the first cycle fired (or full live
   * span if the broadcast is complete). */
  wallSeconds: number;
  /** Sum of max phaseSecond across each live phase. Halftime gap is
   * excluded — only live match-play time counts. */
  contentSeconds: number;
  /** Sum of `wordCount × 60 / WPM` across every generation. WPM
   * derived per-cycle from the pacing snapshot. */
  proseSeconds: number;
  /** Sum of `recommendedWordCount × 60 / WPM` across every cycle
   * with a pacing target. The "what was Kairos asked for" signal. */
  targetSeconds: number;
  cycleCount: number;
  generationCount: number;
  /** Per-phase max content seconds — surfaced in the header tooltip
   * so admins can see where the content accumulated. */
  contentByPhase: Record<string, number>;
}

/**
 * Shape of a persisted generation returned by
 * `GET /broadcasts/:id/generations/:generationId`. Used by the inspector
 * to render the output panel.
 */
export interface PipelineGeneration {
  id: string;
  broadcastId: string;
  triggeredAt: string;
  triggerReason: PipelineTriggerReason;
  output: string;
  wordCount: number;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  durationMs?: number;
  covers?: Array<{ entryId: string; contentTime?: string }>;
  contextPackage?: Record<string, unknown>;
}
