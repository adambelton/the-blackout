import type { FeedEntry } from "../types.js";
import type { EnrichmentAnnotation, EnrichedPayload, EnrichmentReading, ServiceSpec } from "../enrichment/types.js";
import type { TriggerReason } from "../db/enums.js";
import type { RecentCycleSnapshot } from "./recent-cycles.js";
export type { TriggerReason } from "../db/enums.js";

export const PACING_SIGNALS = ["slow_down", "speed_up", "on_track"] as const;
export type PacingSignal = typeof PACING_SIGNALS[number];

export function isPacingSignal(value: unknown): value is PacingSignal {
  return typeof value === "string" && (PACING_SIGNALS as readonly string[]).includes(value);
}

export interface CurationService {
  readonly name: string;
  readonly spec: ServiceSpec;

  curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext>;
  isReady(): boolean;
  reset(): void;
}

/**
 * A conflict between two per-subject annotations. Winner/loser are
 * (serviceName, subjectId) pairs so conflict resolution targets exactly
 * the subject whose reading was killed — not the whole service.
 */
export interface ConflictResolution {
  winner: { serviceName: string; subjectId: string };
  loser: { serviceName: string; subjectId: string };
  reason: string;
  replacementReading?: EnrichmentReading;
}

/**
 * The pendulum of generation modes. Every passage lives at one of three
 * points; voice + time-grounding + no-invention rules apply across all
 * three. Only the material source shifts.
 *
 *   action_led     — reportable events are present this cycle. The
 *                    passage leads with them; context + enrichment
 *                    support. Designed 2026-04-22.
 *   enrichment_led — no events but the cycle carries meaningful
 *                    signals (pressure, momentum, emerging themes).
 *                    The passage explores what the game is becoming.
 *   context_led    — no events, no new enrichment signal. The passage
 *                    reaches into the world established before kickoff:
 *                    a character arc, a statistical thread, a detail
 *                    of the occasion. Do not manufacture action.
 */
export type CurationMode = "action_led" | "enrichment_led" | "context_led";

export interface CurationContext {
  selectedEntries: FeedEntry[];
  selectedAnnotations: EnrichmentAnnotation[];
  decisions: Record<string, CurationDecision>;
  conflicts: ConflictResolution[];
  /**
   * Set by services that need to pivot the cycle into context_led mode
   * regardless of other signals. Currently only saturation_resolver
   * sets it — when every annotation is saturated against the recent
   * window, the cycle pivots from action/enrichment-led to context_led
   * (the narrator leans on the pre-match world rather than restating
   * stale signals). True wins in tier-merge.
   *
   * Curation never produces silence — that's a phase-driven concern
   * upstream of the pipeline. Inside curation, every cycle resolves
   * to one of the three modes; only the material source shifts.
   */
  forceContextLed?: boolean;
  mode: CurationMode;
  triggerReason: TriggerReason;
  pacing: {
    recommendedWordCount: number;
    cadenceMs: number;
  };
  /**
   * Token ceiling the final curated payload must fit under. Enforced
   * by the curator itself after the service chain runs — canonical
   * entries are never evicted; within the rest, lowest-priority is
   * dropped first. Phase 2 of the pipeline-fix plan moved this concern
   * from the now-retired assembly stage into curation, so priority is
   * respected instead of age.
   */
  maxContextTokens: number;
  summary?: string;
  // --- runtime state injected by the curator before services run ---
  /** Broadcast elapsed time in ms since activation. Populated by the curator. */
  elapsedMs: number;
  /** Smoothed consumer TTS wpm if any signal has been reported, else null. */
  estimatedWpm: number | null;
  /** Pipeline flush interval in ms — the cadence the curator runs at.
   * Pacing reads this to size the recommended word count to fill the
   * cycle (`words ≈ wpm × cycleMs / 60000 × phaseModifier`). Threaded
   * through from `CyclePipeline.flushIntervalMs` via the
   * Curator's constructor option. */
  cycleIntervalMs: number;
  /**
   * Per-service lastSurfacedAt timestamps (ms epoch) at cycle start.
   * Keyed by enrichment service name. `null` means the service has never
   * been surfaced yet. Used by NarrativeGapService to identify overdue
   * threads.
   */
  serviceLastSurfacedAt: Record<string, number | null>;
  /**
   * Snapshot of recent cycles' annotations + generated prose, oldest
   * first. Used by SaturationResolver and ContextCurator to
   * judge per-(service, subject) and per-context-fragment recurrence
   * across the rolling window. Populated by the curator from the
   * runtime's RecentCyclesBuffer; empty when no buffer is wired
   * (early cycles, tests).
   */
  recentCycles: RecentCycleSnapshot[];
  // --- decisions services fill as they run ---
  /** Arc phase written by NarrativeArcService (opening / rising / climax / falling / resolution). */
  arcPhase?: string;
  /** Subjects flagged as overdue by NarrativeGapService. */
  urgentSubjects?: Array<{ serviceName: string; subjectId: string; reason: string }>;
  /**
   * Narrative threads from the writer's brief that ContextCurator
   * judges most relevant for the current moment. Always emitted (when
   * a thread inventory exists for the broadcast); the generator only
   * acts on it when the cycle's mode resolves to `context_led`. Threads
   * not consumed in a non-context_led cycle stay "fresh" for next time
   * — recency only updates when a thread is actually narrated.
   */
  relevantThreads?: RelevantThread[];
}

/** A thread surfaced for this cycle, with a short justification. */
export interface RelevantThread {
  threadId: string;
  label: string;
  /** Short snippets from the brief that anchor the thread. The
   * generator uses these as the source material when context_led;
   * downstream recency-tracking does heuristic substring matching
   * against the played prose to decide whether the thread was used. */
  anchors: string[];
  /** One-line justification from the LLM ranker. */
  whyNow: string;
}

/** A thread extracted from the broadcast's brief at activation time.
 * Stable for the broadcast's lifetime (or until ContextCurator is
 * rebuilt). The boot-time extraction is a one-shot Haiku call. */
export interface NarrativeThread {
  threadId: string;
  label: string;
  anchors: string[];
  briefRationale: string;
}

export interface CurationDecision {
  serviceName: string;
  action: string;
  entriesRemoved: string[];
  entriesEmphasized: string[];
  /** Service-specific payload (arc phase, urgent-subject list, etc.). */
  meta?: Record<string, unknown>;
}

/**
 * `annotations` is what curation kept; `originalAnnotations` is the full
 * unfiltered list the enrichment pass produced. Feedback uses the
 * difference to mark subjects whose annotations were dropped as IGNORED.
 */
export interface CuratedPayload {
  broadcastId: string;
  entries: FeedEntry[];
  annotations: EnrichmentAnnotation[];
  originalAnnotations: EnrichmentAnnotation[];
  context: CurationContext;
  triggerReason: TriggerReason;
  /**
   * Opaque preamble text the consumer (Blackout, etc.) wants spliced
   * into the generator's user message for *this* cycle. Set only on
   * `external`-triggered cycles; the consumer owns the wording.
   *
   * Lives on the payload, not the context, because curation never reads
   * it — it's a generation-time concern that travels through curation
   * but isn't part of the curation conversation. Keeping it here also
   * prevents any future tier-merge in `mergeTierResults` from
   * accidentally dropping the field by rebuilding context from scratch.
   *
   * Kairos doesn't interpret the contents — it's a domain-bound
   * channel for the consumer to shape the prompt for moments only
   * the consumer's domain knows about. Keeps Kairos's enum +
   * prompt-shaping logic domain-agnostic and means new consumer
   * phase moments don't require a Kairos change.
   */
  consumerPrompt?: string;
  /** Mirrors `EnrichedPayload.drainBoundaryOrdinal`. Curation doesn't
   * read it; passes through to the generator so it can scope cross-cycle
   * reads (canonicalEvents preamble) to the cycle's authority horizon. */
  drainBoundaryOrdinal?: number;
  generatedAt: number;
}
