import type { FeedEntry } from "../types.js";
import type { ServiceType, SpecStatus } from "../db/enums.js";

/**
 * A single subject's domain-specific reading. Services define their
 * own shape (e.g. momentum: `{ direction, intensity }`). The reading
 * carries meaning; identity (label) is tracked alongside it on
 * `SubjectState`.
 */
export type EnrichmentReading = Record<string, unknown>;

/**
 * A subject's reading plus its human-readable label. The label is
 * identity metadata — changes to it don't trigger annotations, only
 * changes to `reading` do.
 */
export interface SubjectState<TReading extends EnrichmentReading = EnrichmentReading> {
  label: string;
  reading: TReading;
}

/**
 * Subject-keyed map of states. Each enrichment service holds three
 * such maps concurrently: expressed (audience baseline), unexpressed
 * (running current reading), and acknowledged (last lightly-surfaced
 * snapshot). A subject can exist in any subset of the three.
 */
export type SubjectStateMap<TReading extends EnrichmentReading = EnrichmentReading> =
  Record<string, SubjectState<TReading>>;

export interface ServiceSpec {
  serviceName: string;
  serviceType: ServiceType;
  eventProfileName: string;
  version: string;
  status: SpecStatus;
  spec: Record<string, unknown>;
}

export interface FeedChunk {
  broadcastId: string;
  entries: FeedEntry[];
  fromTimestamp: number;
  toTimestamp: number;
  /**
   * Standing narrative_context entries for the broadcast. Immutable
   * during the broadcast lifetime; passed through every cycle so
   * services have the writer's brief in scope when interpreting
   * the new chunk. Subject to K17 (lens not gate) and K18 (action
   * and meaning meet at enrichment) — see docs/product-decisions.md.
   */
  narrativeContext: FeedEntry[];
}

/**
 * One annotation per changed subject per cycle. A service that tracks
 * five subjects may emit zero to five annotations; subjects whose
 * unexpressed reading matches their last acknowledged reading are
 * suppressed at the service, not the curator.
 *
 * `meaning` carries the three-level view so the curator can see both
 * the delta from the audience baseline and whether the reading was
 * recently acknowledged-without-emphasis.
 */
export interface EnrichmentAnnotation {
  serviceName: string;
  subjectId: string;
  subjectLabel: string;
  meaning: {
    expressed: EnrichmentReading | null;
    unexpressed: EnrichmentReading;
    acknowledged: EnrichmentReading | null;
    basis: string;
  };
  informedBy: string[];
}

export interface EnrichedPayload {
  broadcastId: string;
  entries: FeedEntry[];
  annotations: EnrichmentAnnotation[];
  fromTimestamp: number;
  toTimestamp: number;
  /** Standing narrative_context for the broadcast — same shape as on FeedChunk. */
  narrativeContext: FeedEntry[];
  /** Content ordinal up to which this cycle has authority. The cycle
   * drained entries with ordinal ≤ this value; the generator can use
   * it to scope cross-cycle reads (e.g. canonicalEvents preamble) so
   * future content doesn't leak into prose that's narrating the past. */
  drainBoundaryOrdinal?: number;
}

export const FEEDBACK_OUTCOMES = {
  IGNORED: "ignored",
  ACKNOWLEDGED: "acknowledged",
  DELIVERED_WITH_EMPHASIS: "delivered_with_emphasis",
  KILLED_WITH_REPLACEMENT: "killed_with_replacement",
} as const;

export type FeedbackOutcome = typeof FEEDBACK_OUTCOMES[keyof typeof FEEDBACK_OUTCOMES];

/**
 * Feedback is always targeted at a specific subject within a service.
 * The curator produces one of these per annotation it saw in the cycle;
 * subjects that received no annotation receive no feedback and their
 * state holds.
 */
export interface CuratorFeedback {
  serviceName: string;
  subjectId: string;
  outcome: FeedbackOutcome;
  replacementReading?: EnrichmentReading;
}

export interface EnrichmentService {
  readonly name: string;
  readonly spec: ServiceSpec;

  process(chunk: FeedChunk): Promise<EnrichmentAnnotation[]>;
  getExpressedStates(): SubjectStateMap;
  getUnexpressedStates(): SubjectStateMap;
  getAcknowledgedStates(): SubjectStateMap;
  hydrateStates(
    expressed: SubjectStateMap,
    unexpressed: SubjectStateMap,
    acknowledged: SubjectStateMap,
  ): void;
  /**
   * Lift subject seeds from the writer's brief and hydrate them into
   * `unexpressed` state at activation, before any live evidence has
   * arrived. Services that don't have a meaningful brief-prior shape
   * (e.g. `patterns_echoes`, which is purely live-evidence-driven)
   * implement this as a no-op.
   *
   * Called once per broadcast in the activation pass; no-op on
   * subsequent calls if state is already hydrated from persistence.
   */
  initializeFromBrief(brief: string): Promise<void>;
  confirmSurfaced(feedback: CuratorFeedback): void;
  isReady(): boolean;
  reset(): void;
}

export interface ServiceSnapshot {
  name: string;
  serviceType: "enrichment" | "curation";
  specVersion: string;
  ready: boolean;
  expressed?: SubjectStateMap;
  unexpressed?: SubjectStateMap;
  acknowledged?: SubjectStateMap;
}
