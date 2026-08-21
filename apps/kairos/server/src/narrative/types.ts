/** A single feed entry as it appears in the generator's prompt. */
export interface AssembledEntry {
  entryId: string;
  /** Source name — rendered inline now that entries share one timeline. */
  source: string;
  /** Wall-clock ms when the entry entered the feed; drives chronological sort. */
  timestamp: number;
  /** Match-minute marker (legacy) — retained for backwards compatibility. */
  minute: string;
  /** Consumer-supplied content-time marker, when present on `data`. */
  subjectTime?: string;
  /** Consumer-supplied phase tag. */
  phase?: string;
  /** Consumer-supplied seconds into the current phase. */
  phaseSecond?: number;
  /** Optional consumer-supplied parent linkage. When set, this entry is
   * subordinate to the entry whose data carries `sourceId === parentSourceId`
   * — the generator's prompt groups parent + children to make the
   * structural moment clear. Currently used by `match_action` event_texture
   * entries pointing at their canonical Sportmonks event. Domain-agnostic
   * field; any consumer that wants entry hierarchy can populate it. */
  parentSourceId?: string;
  /** Consumer-supplied stable id from the upstream source (e.g. the
   * Sportmonks event id). Surfaced so children referencing the same
   * id via `parentSourceId` can be grouped at prompt-render time. */
  canonicalSourceId?: string;
  content: string;
}

/** The structured context passed to the narrative generator. */
export interface GenerationContext {
  /** Unified chronological timeline across all sources. */
  entries: AssembledEntry[];
  currentSubjectMinute: number | null;
  /** Phase at the moment the cycle assembled, if any entry carried one. */
  currentSubjectPhase?: string;
  /** Seconds into the current phase at cycle-assembly time. */
  currentSubjectPhaseSecond?: number;
}

/** A feed entry reference that the narrator reports materially covering. */
export interface NarrativeCover {
  entryId: string;
  subjectTime?: string;
  /**
   * Char offset in the prose where the generator anchored a reference
   * to this entry (derived from the stripped `{{ref:...}}` marker).
   * Consumers map `(charOffset / prose.length) * audioDurationMs` to
   * schedule per-entry reveals in sync with the narrator's speech.
   * Absent when the LLM listed a cover without placing an anchor —
   * consumer falls back to audio-end reveal.
   */
  charOffset?: number;
}

/**
 * Imagery decision paired with the narrative. Produced by a parallel
 * Haiku call (not the narrative Sonnet call). Emitted as an
 * `imagery_decision` WS message the moment Haiku returns, so the
 * consumer's image pipeline can start immediately in parallel with
 * the still-in-progress Sonnet narrative — and also ships attached to
 * the later `narrative` message for consumers that only watch that
 * channel. Consumers treat it as advisory: if image work fails, the
 * previous image stays and audio playback never waits.
 *
 * Three decision variants:
 * - `pool`: pick a pre-prepared item the consumer pushed via
 *   `/broadcasts/:id/pool`. Carries `poolItemId` and opaque
 *   `consumerMetadata` threaded back from that item.
 * - `generate`: write a fresh prompt. Consumer runs its image
 *   provider with that prompt.
 * - `hold`: keep whatever's currently displayed. Emitted on tool-call
 *   failure, malformed LLM output, or when `pool` was requested with
 *   an invalid id.
 */
export interface NarrativeImagery {
  decision: "pool" | "generate" | "hold";
  /** Present when decision is `generate`. A short art-directed prompt
   * the consumer passes to its image provider (Replicate / etc). */
  prompt?: string;
  /** Present when decision is `pool`. Id of the chosen content pool
   * item; the consumer already knows what bytes this resolves to. */
  poolItemId?: string;
  /** Present when decision is `pool`. Opaque JSON the consumer
   * stashed onto the pool item when pushing it — typically a pointer
   * (e.g. a local record id) so the consumer can look up bytes
   * without a Kairos round-trip. */
  consumerMetadata?: Record<string, unknown> | null;
  /** Optional one-line Haiku rationale — persisted for editorial
   * review, never shown to listeners. */
  rationale?: string;
}

/** What the narrative engine produces. */
export interface NarrativeOutput {
  id: string;
  broadcastId: string;
  text: string;
  generatedAt: number;
  feedWindow: { from: string; to: string };
  usage?: { inputTokens: number; outputTokens: number };
  /**
   * Entries the narrator explicitly reported as covered in this prose.
   * A strict subset — the generator's own citations, filtered against
   * the included context so phantoms don't leak through.
   */
  covers: NarrativeCover[];
  /**
   * The full set of feed entries this cycle observed — i.e. everything
   * new since the prior cycle's trigger, excluding ambient sources.
   * Consumers use this for UI reveal-gating: audio-end reveals every
   * entry in the batch the narrator didn't explicitly cite, so nothing
   * the cycle saw is invisible to the UI. Superset of
   * `covers.map(c => c.entryId)`. May include entries curation dropped
   * from the generator's view — the reveal contract is about what the
   * cycle observed, not what the prose drew on.
   */
  batchEntryIds: string[];
  /**
   * Earliest match-clock marker (`subjectTime`) among the cycle's
   * batch, parsed-leading-int semantics (so `"45+2"` → 45). Null when
   * no batch entry carries a numeric subjectTime. Consumers drive the
   * match clock from this field — it snaps to the minute the narrator
   * is beginning from as each passage's audio starts, decoupling the
   * clock from specific event coverage.
   */
  contentTime: number | null;
  /** Imagery decision — paired with the passage. May be absent on
   * failure (consumer should then hold whatever's currently displayed). */
  imagery?: NarrativeImagery;
}
