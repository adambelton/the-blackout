import type { FeedEntry } from "../types.js";
import type { EnrichmentService, FeedChunk, EnrichmentAnnotation, EnrichedPayload, ServiceSnapshot } from "../enrichment/types.js";
import type { Curator } from "../curation/curator.js";
import type { RecentCyclesBuffer } from "../curation/recent-cycles.js";
import type { NarrativeOutput } from "../narrative/types.js";
import type { TriggerReason } from "../db/enums.js";
import { captureEvent } from "../telemetry.js";
import { subjectOrdinalForEntry, readClosingExtension, readClosingPrompt } from "./subject-time.js";

// Widened from 30_000 to 45_000 after 2026-04-21 Brighton-Chelsea: the
// live LLM took longer than 30s per cycle ~35% of the time, producing
// a "flush skipped — still in flight" log every ~third tick. The
// effective cadence was already ~45s; matching the timer to that
// reduces skips to near-zero without changing functional behaviour.
// The narrator still gets a meaningful source window; word-count
// targets stay calibrated by the pacing service independently.
export const DEFAULT_FLUSH_INTERVAL_MS = 45_000;
const DEFAULT_MAX_CONSECUTIVE_EMPTY_CYCLES = 2;

/**
 * Wall-clock seconds the cadence trigger waits past the highest
 * observed content ordinal before declaring a slice complete. Picked
 * from the calibration sample distribution: covers the long tail of
 * Sportmonks event arrival latency (~30s typical, occasional 60s)
 * plus HLS+ASR commentary latency (similar profile after the radio
 * offset estimate), with margin. Configurable per pipeline so live
 * tests can tune the value once the late-discard counter has data.
 *
 * Trade-off: every additional second of DELAY adds a second of
 * narrative lag. 60s is comfortable; under 30s starts dropping
 * legitimate late entries; over 90s the audience hears the broadcast
 * audibly behind the action.
 */
export const DEFAULT_DELAY_MS = 60_000;

/** Sub-classification of the flush that produced this cycle.
 * Distinct from `TriggerReason` (`accumulation` | `external`):
 *   - `cadence` — scheduled wall-clock tick (triggerReason: accumulation)
 *   - `closing` — phase-boundary closing-cycle (triggerReason: accumulation)
 *   - `consumer_prompt` — external `flush({consumerPrompt})` (triggerReason: external)
 */
export type FlushTrigger = "cadence" | "closing" | "consumer_prompt";

/** Per-stage wall-clock timing breakdown captured for every cycle.
 * Persisted alongside the cycle so the inspector can show admins
 * which stage dominated. Excludes the persist itself — it's a small
 * INSERT and not a meaningful signal. */
export interface CycleTimingMs {
  totalMs: number;
  enrichmentMs: number;
  curationServicesMs: number;
  handlerMs: number;
  perServiceEnrichmentMs: Record<string, number>;
  perServiceCurationMs: Record<string, number>;
}

export interface PipelineCycleRecord {
  broadcastId: string;
  triggerReason: TriggerReason;
  flushTrigger: FlushTrigger;
  entries: FeedEntry[];
  annotations: EnrichmentAnnotation[];
  curation: Record<string, unknown>;
  generationId: string | null;
  timingMs: CycleTimingMs;
}

/** Default persister used in production — tests inject a noop or spy. */
export async function defaultPersistCycle(row: PipelineCycleRecord): Promise<string | null> {
  const { db } = await import("../db/client.js");
  const { pipelineCycles } = await import("../db/schema.js");
  try {
    const [inserted] = await db
      .insert(pipelineCycles)
      .values({
        broadcastId: row.broadcastId,
        triggerReason: row.triggerReason,
        flushTrigger: row.flushTrigger,
        chunkEntries: row.entries as unknown as Array<Record<string, unknown>>,
        annotations: row.annotations as unknown as Array<Record<string, unknown>>,
        curation: row.curation,
        timingMs: row.timingMs,
        generationId: row.generationId,
      })
      .returning({ id: pipelineCycles.id });
    return inserted?.id ?? null;
  } catch (err) {
    console.error(`[enrichment] failed to persist cycle:`, (err as Error).message);
    return null;
  }
}

/**
 * Narrow surface the pipeline needs from a registry. `ServiceRegistry`
 * satisfies this by having the required methods; tests can supply a
 * minimal double without forcing the full registry shape.
 */
export interface PipelineRegistry {
  getEnrichmentServices(): EnrichmentService[];
  persistEnrichmentStates(): Promise<void>;
  getSnapshots(): ServiceSnapshot[];
}

export interface CyclePipelineOptions {
  flushIntervalMs?: number;
  /**
   * Wall-clock delay between content-time boundary and dispatch.
   * Entries with content ordinal ≤ (highest observed - delaySeconds)
   * are eligible for the next cadence flush. Late arrivals (entries
   * landing after their window has flushed) are discarded with
   * telemetry. Default 60_000ms.
   */
  delayMs?: number;
  maxConsecutiveEmptyCycles?: number;
  /** Called after each cycle is persisted — used by the runtime to broadcast `cycle_complete` WS events. */
  onCyclePersisted?: (cycleId: string) => void;
  /** Injectable persister so unit tests can run without a DB. */
  persistCycle?: (row: PipelineCycleRecord) => Promise<string | null>;
  /**
   * Returns the broadcast's standing narrative_context entries. Called
   * once per cycle and passed through the FeedChunk so enrichment
   * services have the writer's brief in scope when reading new entries.
   * Returns `[]` if the runtime hasn't supplied one (tests, harness
   * scenarios) — services tolerate an empty brief.
   */
  getNarrativeContext?: () => FeedEntry[];
  /**
   * Bounded ring of recent cycle snapshots. The pipeline appends one
   * snapshot per completed cycle (annotations + generated prose);
   * curation services that judge across cycles read it via the
   * curator. When omitted (tests), no snapshots are recorded.
   */
  recentCycles?: RecentCyclesBuffer;
}

interface WaitingEntry {
  /** Content ordinal — null for entries without phase information.
   * Null-ordinal entries are dispatched on any cadence flush
   * (treated as "right now" content-time-wise) since we have no
   * anchor to defer them against. */
  ordinal: number | null;
  entry: FeedEntry;
}

export class CyclePipeline {
  /**
   * Waiting room — entries arrive here from `feed.subscribe`, sit
   * keyed by content ordinal, and leave once a flush trigger catches
   * them. Single-dispatch: entries are removed when drained, never
   * re-read from the DB (the DB write is for replay/recovery only).
   */
  private waitingRoom: WaitingEntry[] = [];
  /** Highest content ordinal we've observed across any entry. Drives
   * the cadence flush boundary: drain anything ≤ highest - DELAY. */
  private highestObservedOrdinal = -Infinity;
  /** The last boundary the cadence dispatcher flushed up to. Late
   * arrivals (ordinal ≤ this) are discarded with telemetry. */
  private lastFlushedOrdinal = -Infinity;
  /** Telemetry counter — entries discarded as late since pipeline start.
   * Exposed via `getLateDiscardedCount()` for instrumentation. */
  private lateDiscardedCount = 0;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFlushTimestamp = 0;
  /** Counter capping consecutive empty-cycle flushes. Bumped on each
   * empty cycle, reset whenever a cycle has entries. When it hits
   * `maxConsecutiveEmptyCycles`, the pipeline stops generating into pure
   * silence — an inactive broadcast doesn't burn LLM tokens generating
   * over nothing indefinitely. The cap is a stopping rule, not a cycle
   * type; `triggerReason` stays `accumulation` regardless. */
  private consecutiveEmptyCycles = 0;
  private flushIntervalMs: number;
  private delayMs: number;
  private maxConsecutiveEmptyCycles: number;
  private onCyclePersisted?: (cycleId: string) => void;
  private persistCycleFn: (row: PipelineCycleRecord) => Promise<string | null>;
  private getNarrativeContext: () => FeedEntry[];
  private recentCycles?: RecentCyclesBuffer;
  // Tracks every in-flight `flush()`. `stop()` clears the timer but can't
  // abort a flush that's already running — callers tearing down the
  // runtime (replay harness, test cleanup) need to await this before
  // ending the DB pool, or late LLM calls land on a closed connection.
  private inFlightFlushes = new Set<Promise<unknown>>();
  // Timer ticks that landed while a prior flush was still running.
  // Instead of dropping (which caused the 90s cadence we saw in the
  // 2026-04-22 Burnley-City live test when the LLM chain ran long),
  // we queue a single pending tick and dispatch it the moment the
  // in-flight flush completes. Cadence becomes max(flushIntervalMs,
  // flushDuration) rather than 2 × flushIntervalMs.
  private pendingFlushQueued = false;

  constructor(
    private broadcastId: string,
    private registry: PipelineRegistry,
    private curator?: Curator,
    options: CyclePipelineOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    this.maxConsecutiveEmptyCycles = options.maxConsecutiveEmptyCycles ?? DEFAULT_MAX_CONSECUTIVE_EMPTY_CYCLES;
    this.onCyclePersisted = options.onCyclePersisted;
    this.persistCycleFn = options.persistCycle ?? defaultPersistCycle;
    this.getNarrativeContext = options.getNarrativeContext ?? (() => []);
    this.recentCycles = options.recentCycles;
  }

  /** Telemetry — entries discarded as late since pipeline start. */
  getLateDiscardedCount(): number {
    return this.lateDiscardedCount;
  }

  /** Pending closing-cycle state. Set when an entry carrying a
   * `closingExtensionSeconds` marker lands; cleared when the closing
   * cycle dispatches (or overridden by a later marker). The closing
   * cycle's drain end-boundary is pinned to `triggerOrdinal +
   * extensionSeconds` regardless of the natural cadence boundary at
   * dispatch time. The cadence dispatcher consults this to know:
   *   - while the natural boundary is comfortably below the trigger
   *     entry's ordinal: dispatch ordinary cadence cycles, holding
   *     the marker entry
   *   - while the natural boundary would cross the trigger but the
   *     wall-clock dispatch target hasn't arrived: skip the tick
   *   - once the wall-clock target arrives (or the force timer fires):
   *     dispatch the closing cycle with the pinned boundary
   *
   * `pendingClosingPrompt` carries the consumer's optional framing
   * text for the closing cycle (paired with `closingExtensionSeconds`
   * on the trigger entry). When present, the closing cycle dispatches
   * with this text as its consumer-prompt.
   */
  private pendingClosingBoundary: number | null = null;
  private pendingClosingTriggerOrdinal: number | null = null;
  private pendingClosingTriggerEntryId: string | null = null;
  private pendingClosingDispatchAtMs: number | null = null;
  private pendingClosingPrompt: string | null = null;
  private pendingClosingForceTimer: ReturnType<typeof setTimeout> | null = null;

  /** Consumer-prompt cycle deferred until a pending closing dispatches.
   * Without this, a consumer prompt that arrives synchronously with
   * the closing marker (the conductor's reflection-prompt fires when
   * the conductor sees the phase transition) would `drainAll()` the
   * waiting room before the closing cycle had a chance to dispatch
   * its pinned-boundary drain. Holding the consumer prompt ensures
   * the closing cycle and the reflective beat land in order: closing
   * first, reflection second. */
  private pendingConsumerPrompt: {
    prompt: string;
    resolve: (v: EnrichedPayload | null) => void;
    reject: (e: unknown) => void;
  } | null = null;

  getFlushIntervalMs(): number {
    return this.flushIntervalMs;
  }

  onEntry(entry: FeedEntry): void {
    // Ambient sources (narrative_voice, narrative_context) are reference
    // material the consumer pushes during activation — the writer's
    // voice and brief. They're INPUT to enrichment, not subjects of it:
    // services fetch the standing brief via `getNarrativeContext()` to
    // know what subjects to be alert for as real entries arrive. Letting
    // them into the buffer treats the brief as if it were a source event,
    // which fires every service over every name/team/theme mentioned in
    // it. Confirmed 2026-04-22 Burnley-City: cycle 1 produced 40
    // annotations from a single narrative_context entry.
    if (
      entry.sourceType === "narrative_voice" ||
      entry.sourceType === "narrative_context"
    ) {
      return;
    }

    const ordinal = subjectOrdinalForEntry(entry);

    // Late arrival — entry's content ordinal is at or before the last
    // boundary the cadence dispatcher already drained up to. The entry
    // belongs to a window that has already shipped. Discarding with
    // telemetry preserves the content-time-coherent guarantee for the
    // cycles already in flight; the alternative (append to current
    // window) would re-introduce the window-incoherence the design
    // exists to eliminate. Null-ordinal entries can't be late-checked.
    if (ordinal !== null && ordinal <= this.lastFlushedOrdinal) {
      this.lateDiscardedCount++;
      console.log(
        `[enrichment] late entry discarded: ordinal=${ordinal}, lastFlushed=${this.lastFlushedOrdinal}, source=${entry.sourceName}, total=${this.lateDiscardedCount}`,
      );
      return;
    }

    if (ordinal !== null && ordinal > this.highestObservedOrdinal) {
      this.highestObservedOrdinal = ordinal;
    }
    this.waitingRoom.push({ ordinal, entry });

    // Closing-cycle trigger: an entry with a `closingExtensionSeconds`
    // marker on its data payload signals "the next cycle whose
    // content-time window contains this entry should pin its drain
    // end at this entry's ordinal + the extension." Cadence cycles
    // before that point continue to dispatch normally with their
    // natural boundary. Optional `closingPrompt` field carries the
    // consumer's framing text for that cycle's generation.
    // Domain-agnostic — the consumer decides which entries qualify,
    // how far past them to extend, and what framing to apply.
    const closingExtension = readClosingExtension(entry);
    if (closingExtension !== null && ordinal !== null) {
      const closingPrompt = readClosingPrompt(entry);
      this.markPendingClosing(ordinal, closingExtension, entry.id, closingPrompt);
    }
  }

  /**
   * Pin the next closing cycle's drain end at `triggerOrdinal +
   * extensionSeconds`. Wall-clock dispatch target is `delayMs +
   * extensionSeconds * 1000` from now — when the boundary becomes
   * ripe by the cadence's content-time delay rule. A force timer
   * ensures dispatch even if no further cadence ticks land in time.
   *
   * A second closing marker that arrives during the wait overrides —
   * most recent wins.
   */
  private markPendingClosing(
    triggerOrdinal: number,
    extensionSeconds: number,
    triggerEntryId: string,
    closingPrompt: string | null,
  ): void {
    if (this.pendingClosingForceTimer) {
      clearTimeout(this.pendingClosingForceTimer);
      this.pendingClosingForceTimer = null;
    }
    this.pendingClosingTriggerOrdinal = triggerOrdinal;
    this.pendingClosingBoundary = triggerOrdinal + extensionSeconds;
    this.pendingClosingTriggerEntryId = triggerEntryId;
    this.pendingClosingPrompt = closingPrompt;
    const dispatchAtMs = Date.now() + this.delayMs + extensionSeconds * 1000;
    this.pendingClosingDispatchAtMs = dispatchAtMs;
    // +100ms grace so the timer fires after the dispatch wall-clock
    // rather than coincident with it (setTimeout precision).
    const safetyDelayMs = Math.max(0, dispatchAtMs - Date.now()) + 100;
    this.pendingClosingForceTimer = setTimeout(() => {
      this.pendingClosingForceTimer = null;
      this.dispatchClosingIfReady();
    }, safetyDelayMs);
    console.log(
      `[enrichment] closing pinned: trigger=${triggerEntryId} triggerOrdinal=${triggerOrdinal} boundary=${this.pendingClosingBoundary} extension=${extensionSeconds}s waitMs=${safetyDelayMs}`,
    );
  }

  /** Force-fire the closing cycle when the wall-clock target arrives.
   * No-op if already dispatched. Re-arms tightly if a flush is in
   * flight (the in-flight flush's `.finally` also re-checks via
   * `dispatchTick`, but this fallback covers cases where no cadence
   * is running). */
  private dispatchClosingIfReady(): void {
    if (this.pendingClosingBoundary === null) return;
    if (this.inFlightFlushes.size > 0) {
      this.pendingClosingForceTimer = setTimeout(() => {
        this.pendingClosingForceTimer = null;
        this.dispatchClosingIfReady();
      }, 100);
      console.log(`[enrichment] closing dispatch deferred — flush in flight`);
      return;
    }
    this.dispatchClosingCycle();
  }

  private dispatchClosingCycle(): void {
    const boundary = this.pendingClosingBoundary;
    const triggerEntryId = this.pendingClosingTriggerEntryId;
    const closingPrompt = this.pendingClosingPrompt;
    if (boundary === null) return;
    // Clear pending state before dispatch so concurrent re-entries
    // through the cadence path don't re-fire the closing cycle.
    this.pendingClosingBoundary = null;
    this.pendingClosingTriggerOrdinal = null;
    this.pendingClosingTriggerEntryId = null;
    this.pendingClosingDispatchAtMs = null;
    this.pendingClosingPrompt = null;
    if (this.pendingClosingForceTimer) {
      clearTimeout(this.pendingClosingForceTimer);
      this.pendingClosingForceTimer = null;
    }

    const drained = this.drainUpToBoundary(boundary);
    console.log(
      `[enrichment] closing dispatched: trigger=${triggerEntryId} boundary=${boundary} entries=${drained.entries.length}${closingPrompt ? " (prompted)" : ""}`,
    );
    // Closing cycle is always meaningful — the phase moment IS the news.
    // Reset the empty-cycle counter so a quiet boundary still produces
    // a closing beat.
    this.consecutiveEmptyCycles = 0;

    // Pass the consumer's optional closing prompt as the cycle's
    // consumer-prompt. triggerReason stays "accumulation" — this is a
    // cadence-style closing, not an external trigger; the prompt is
    // pure framing.
    const work = this.runCycle(
      drained.entries,
      "accumulation",
      "closing",
      closingPrompt ?? undefined,
      boundary,
    )
      .catch((err) => {
        console.error(`[enrichment] closing cycle error:`, (err as Error).message);
        return null;
      })
      .finally(() => this.drainPendingConsumerPrompt());
    this.inFlightFlushes.add(work);
    work.finally(() => this.inFlightFlushes.delete(work)).catch(() => {});
  }

  /** Dispatch any consumer-prompt cycle that was deferred while the
   * closing was pending. Runs through the public `flush()` path so it
   * gets the standard in-flight tracking. */
  private drainPendingConsumerPrompt(): void {
    if (!this.pendingConsumerPrompt) return;
    const pending = this.pendingConsumerPrompt;
    this.pendingConsumerPrompt = null;
    console.log(
      `[enrichment] dispatching deferred consumer-prompt cycle after closing`,
    );
    this.flush({ consumerPrompt: pending.prompt })
      .then((result) => pending.resolve(result))
      .catch((err) => pending.reject(err));
  }

  start(): void {
    this.timer = setInterval(() => {
      this.dispatchTick();
    }, this.flushIntervalMs);
    console.log(`[enrichment] pipeline started (${this.flushIntervalMs}ms interval, max consecutive empty cycles ${this.maxConsecutiveEmptyCycles})`);
  }

  /**
   * Decide what a cadence tick should do.
   *
   * Sequential flushes: concurrent cycles race on service state and
   * the recentCycles buffer, so only one flush runs at a time. When a
   * tick arrives while a flush is already running, mark a tick as
   * queued — the in-flight flush's completion re-dispatches.
   *
   * When a closing is pending, the closing cycle's drain is wall-
   * clock-pinned via the force timer. The cadence tick's job during
   * the wait is to dispatch ordinary content whose natural boundary
   * sits below the trigger entry's ordinal, and to skip ticks whose
   * natural boundary would cross the trigger but the wall-clock
   * dispatch target isn't yet ripe.
   */
  private dispatchTick(): void {
    if (this.inFlightFlushes.size > 0) {
      if (!this.pendingFlushQueued) {
        this.pendingFlushQueued = true;
        console.log(`[enrichment] flush queued — ${this.inFlightFlushes.size} in flight, will run on completion`);
      }
      return;
    }

    if (this.pendingClosingBoundary !== null) {
      // Closing dispatch target arrived (possibly while we were in
      // flight earlier) — fire the closing cycle now.
      if (
        this.pendingClosingDispatchAtMs !== null &&
        Date.now() >= this.pendingClosingDispatchAtMs
      ) {
        this.dispatchClosingCycle();
        return;
      }
      const naturalBoundary = this.computeNaturalBoundary();
      const triggerOrdinal = this.pendingClosingTriggerOrdinal ?? Infinity;
      if (naturalBoundary >= triggerOrdinal) {
        // Natural drain would cross the trigger entry but the wall-
        // clock target hasn't arrived. Skip — closing dispatches on
        // its target.
        return;
      }
      // Comfortably below the trigger ordinal. Cadence dispatches as
      // normal; the marker entry stays held in the waiting room
      // until the closing dispatch.
    }

    this.dispatchCadenceFlush();
  }

  /** Boundary the natural cadence would drain to right now. */
  private computeNaturalBoundary(): number {
    const delaySeconds = this.delayMs / 1000;
    return Number.isFinite(this.highestObservedOrdinal)
      ? this.highestObservedOrdinal - delaySeconds
      : -Infinity;
  }

  /** Fire a cadence flush and, on completion, re-evaluate via
   * `dispatchTick` if a queued tick is waiting OR a pending closing
   * has become ripe while we were busy. Long-running flushes don't
   * cost us the next cycle, and the closing dispatch doesn't have to
   * wait the full safety-timer interval. */
  private dispatchCadenceFlush(): void {
    const p = this.flush().catch((err) => {
      console.error("[enrichment] flush error:", (err as Error).message);
    });
    p.finally(() => {
      if (!this.timer) return;
      const closingReady =
        this.pendingClosingBoundary !== null &&
        this.pendingClosingDispatchAtMs !== null &&
        Date.now() >= this.pendingClosingDispatchAtMs;
      if (this.pendingFlushQueued || closingReady) {
        this.pendingFlushQueued = false;
        // Run on the next microtask so the finally handler unwinds
        // cleanly before the next flush starts its own tracking.
        queueMicrotask(() => this.dispatchTick());
      }
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.pendingClosingForceTimer) {
      clearTimeout(this.pendingClosingForceTimer);
      this.pendingClosingForceTimer = null;
    }
    this.pendingClosingBoundary = null;
    this.pendingClosingTriggerOrdinal = null;
    this.pendingClosingTriggerEntryId = null;
    this.pendingClosingDispatchAtMs = null;
    this.pendingClosingPrompt = null;
    if (this.pendingConsumerPrompt) {
      this.pendingConsumerPrompt.resolve(null);
      this.pendingConsumerPrompt = null;
    }
    this.waitingRoom = [];
    this.consecutiveEmptyCycles = 0;
    this.highestObservedOrdinal = -Infinity;
    this.lastFlushedOrdinal = -Infinity;
    console.log("[enrichment] pipeline stopped");
  }

  /**
   * Run a cycle. Two paths:
   *
   *   - Default (no opts): scheduled cycle. `triggerReason` is always
   *     `accumulation`. The buffer may be empty — empty cycles still
   *     run through enrichment + curation (context_curator surfaces
   *     brief threads on otherwise-quiet windows) but the
   *     `consecutiveEmptyCycles` counter caps consecutive empties at
   *     `maxConsecutiveEmptyCycles` so the engine doesn't keep generating into
   *     pure silence forever.
   *   - With `consumerPrompt`: a consumer-driven off-schedule cycle.
   *     `triggerReason` is `external`. Empty-buffer cap doesn't apply
   *     — the consumer asked for this cycle, run it. Opaque preamble
   *     text propagates through curation context to the generator.
   */
  async flush(opts: { consumerPrompt?: string } = {}): Promise<EnrichedPayload | null> {
    // Closing pending: defer the consumer-prompt cycle so it doesn't
    // drain the closing-of-prior-phase content out from under the
    // pinned closing dispatch. The conductor's reflection prompt fires
    // synchronously when the conductor observes the phase transition;
    // without this guard, that prompt's drainAll() would race the
    // pinned closing. Most-recent-prompt-wins if multiple arrive
    // during the wait.
    if (opts.consumerPrompt !== undefined && this.pendingClosingBoundary !== null) {
      if (this.pendingConsumerPrompt) {
        this.pendingConsumerPrompt.resolve(null);
      }
      console.log(
        `[enrichment] consumer-prompt cycle deferred until pending closing dispatches`,
      );
      return new Promise<EnrichedPayload | null>((resolve, reject) => {
        this.pendingConsumerPrompt = {
          prompt: opts.consumerPrompt!,
          resolve,
          reject,
        };
      });
    }
    const work = this.doFlush(opts);
    this.inFlightFlushes.add(work);
    work.finally(() => this.inFlightFlushes.delete(work)).catch(() => {});
    return work;
  }

  private async doFlush(opts: { consumerPrompt?: string }): Promise<EnrichedPayload | null> {
    const isExternal = opts.consumerPrompt !== undefined;

    // External cycles drain the entire waiting room — the consumer
    // explicitly asked for this cycle and has its own context (the
    // prompt). The consumer-prompt path is the conductor's halftime/
    // closing-passage triggers; both want everything currently
    // accumulated, regardless of content-time boundary.
    //
    // Cadence cycles drain only entries whose content ordinal is
    // ≤ (highest observed - DELAY). Anything more recent is held for
    // a future cycle; anything that arrives later with an ordinal
    // ≤ this flush's boundary is late-discarded by `onEntry`.
    const drained = isExternal
      ? this.drainAll()
      : this.drainUpToCadenceBoundary();

    const flushTrigger: FlushTrigger = isExternal ? "consumer_prompt" : "cadence";
    if (drained.entries.length === 0) {
      if (!isExternal && this.consecutiveEmptyCycles >= this.maxConsecutiveEmptyCycles) return null;
      this.consecutiveEmptyCycles++;
      return this.runCycle(
        [],
        isExternal ? "external" : "accumulation",
        flushTrigger,
        opts.consumerPrompt,
        drained.boundary,
      );
    }

    this.consecutiveEmptyCycles = 0;
    return this.runCycle(
      drained.entries,
      isExternal ? "external" : "accumulation",
      flushTrigger,
      opts.consumerPrompt,
      drained.boundary,
    );
  }

  /** Drain every entry currently in the waiting room. Used by
   * external (consumer-prompt) cycles. Advances `lastFlushedOrdinal`
   * to the highest ordinal drained so subsequent late arrivals for
   * the same window get caught. */
  private drainAll(): { entries: FeedEntry[]; boundary: number } {
    const entries = this.waitingRoom.map((w) => w.entry);
    const drainedOrdinals = this.waitingRoom
      .map((w) => w.ordinal)
      .filter((o): o is number => o !== null);
    const boundary = drainedOrdinals.length > 0
      ? Math.max(this.lastFlushedOrdinal, ...drainedOrdinals)
      : this.lastFlushedOrdinal;
    this.waitingRoom = [];
    this.lastFlushedOrdinal = boundary;
    return { entries, boundary };
  }

  /** Drain entries with content ordinal ≤ (highest observed - DELAY).
   * Null-ordinal entries pass through (they have no content-time
   * anchor to defer against — typically test fixtures or legacy
   * unstamped entries). */
  private drainUpToCadenceBoundary(): { entries: FeedEntry[]; boundary: number } {
    return this.drainUpToBoundary(this.computeNaturalBoundary());
  }

  /** Drain entries with content ordinal ≤ `boundary`. Used by both
   * the natural cadence and the closing dispatch — the only difference
   * is which boundary the caller supplies. Null-ordinal entries always
   * drain (no anchor to defer against). */
  private drainUpToBoundary(boundary: number): { entries: FeedEntry[]; boundary: number } {
    const ready: FeedEntry[] = [];
    const remaining: WaitingEntry[] = [];
    for (const w of this.waitingRoom) {
      if (w.ordinal === null || w.ordinal <= boundary) {
        ready.push(w.entry);
      } else {
        remaining.push(w);
      }
    }
    this.waitingRoom = remaining;
    if (boundary > this.lastFlushedOrdinal) {
      this.lastFlushedOrdinal = boundary;
    }
    return { entries: ready, boundary };
  }

  /**
   * Resolve when every in-flight flush has settled. `stop()` only
   * clears the scheduled timer — it does not cancel a flush mid-run.
   * Call this before tearing down the DB pool.
   */
  async waitForIdle(): Promise<void> {
    while (this.inFlightFlushes.size > 0) {
      await Promise.allSettled(Array.from(this.inFlightFlushes));
    }
  }

  private async runCycle(
    entries: FeedEntry[],
    triggerReason: TriggerReason,
    flushTrigger: FlushTrigger,
    consumerPrompt?: string,
    drainBoundaryOrdinal?: number,
  ): Promise<EnrichedPayload | null> {
    const cycleStartMs = Date.now();
    const now = cycleStartMs;
    const narrativeContext = this.getNarrativeContext();
    const chunk: FeedChunk = {
      broadcastId: this.broadcastId,
      entries,
      fromTimestamp: this.lastFlushTimestamp || (entries[0]?.timestamp ?? now),
      toTimestamp: now,
      narrativeContext,
    };
    this.lastFlushTimestamp = now;

    const services = this.registry.getEnrichmentServices();

    // Time each enrichment service individually so we can see which
    // ones dominate under load. Services run in parallel so the
    // enrichment-stage duration is max(service durations), not sum.
    const enrichmentStartMs = Date.now();
    const perServiceEnrichment: Record<string, number> = {};
    const results = await Promise.all(
      services.map(async (service) => {
        const started = Date.now();
        try {
          const out = await service.process(chunk);
          perServiceEnrichment[service.name] = Date.now() - started;
          return out;
        } catch (err) {
          perServiceEnrichment[service.name] = Date.now() - started;
          console.error(`[enrichment] ${service.name} failed:`, (err as Error).message);
          return [] as EnrichmentAnnotation[];
        }
      }),
    );
    const enrichmentDurationMs = Date.now() - enrichmentStartMs;

    // Per-service annotation cap. A single service occasionally emits
    // dozens of annotations on an eventful cycle (observed 40 from
    // one entry during 2026-04-22 Burnley-City), which overwhelms the
    // curator's context and inflates the LLM prompt. 5 per service is
    // a strong budget — curation rarely keeps more than 2-3 per
    // service anyway. Overflow is dropped from the tail; services
    // should return their most material annotations first.
    const MAX_PER_SERVICE = 5;
    const annotations = results.flatMap((serviceAnnotations, idx) => {
      if (serviceAnnotations.length <= MAX_PER_SERVICE) return serviceAnnotations;
      const overflow = serviceAnnotations.length - MAX_PER_SERVICE;
      console.warn(
        `[enrichment] ${services[idx]?.name ?? "unknown"} emitted ${serviceAnnotations.length} annotations; capped to ${MAX_PER_SERVICE} (dropped ${overflow})`,
      );
      return serviceAnnotations.slice(0, MAX_PER_SERVICE);
    });

    const enriched: EnrichedPayload = {
      broadcastId: this.broadcastId,
      entries,
      annotations,
      fromTimestamp: chunk.fromTimestamp,
      toTimestamp: chunk.toTimestamp,
      narrativeContext,
      ...(drainBoundaryOrdinal !== undefined && Number.isFinite(drainBoundaryOrdinal)
        ? { drainBoundaryOrdinal }
        : {}),
    };

    const label = triggerReason === "external"
      ? "external cycle"
      : entries.length === 0
        ? "empty cycle"
        : "flushed";
    console.log(`[enrichment] ${label}: ${entries.length} entries → ${annotations.length} annotations from ${services.length} services`);

    let narrative: NarrativeOutput | null = null;
    let curationSnapshot: Record<string, unknown> = buildCurationSnapshot(null);
    let curationTotalMs = 0;
    let handlerMs = 0;
    let perServiceCuration: Record<string, number> = {};

    if (this.curator) {
      const curationStartMs = Date.now();
      const result = await this.curator.curate(enriched, triggerReason, consumerPrompt);
      curationTotalMs = Date.now() - curationStartMs;
      perServiceCuration = result.perServiceMs ?? {};
      handlerMs = result.handlerMs ?? 0;
      narrative = result.handlerResult;
      curationSnapshot = buildCurationSnapshot(result.curated);
    }

    // Snapshot per-stage timings BEFORE persist so the row carries
    // the same numbers we emit to PostHog. The persist itself is a
    // small INSERT and excluded from `totalMs` — DB write latency
    // isn't the signal admins care about.
    const totalMsAtPersist = Date.now() - cycleStartMs;
    const curationServicesMs = curationTotalMs - handlerMs;
    const timingMs: CycleTimingMs = {
      totalMs: totalMsAtPersist,
      enrichmentMs: enrichmentDurationMs,
      curationServicesMs,
      handlerMs,
      perServiceEnrichmentMs: perServiceEnrichment,
      perServiceCurationMs: perServiceCuration,
    };

    const cycleId = await this.persistCycleFn({
      broadcastId: this.broadcastId,
      triggerReason,
      flushTrigger,
      entries,
      annotations,
      curation: curationSnapshot,
      generationId: narrative?.id ?? null,
      timingMs,
    });
    if (cycleId && this.onCyclePersisted) this.onCyclePersisted(cycleId);

    if (this.recentCycles) {
      this.recentCycles.add({
        cycleId,
        triggeredAt: now,
        annotations,
        prose: narrative?.text ?? null,
      });
    }

    await this.registry.persistEnrichmentStates();

    // `consecutiveEmptyCycles` increments live in `doFlush` (where
    // empty-buffer detection happens), not here — `runCycle` doesn't
    // know whether it was given a non-empty input that the consumer
    // happened to flush, vs an empty-buffer scheduled tick.

    // Per-cycle timing summary. The enrichment stage runs services in
    // parallel so its duration is max(service-duration). Curation runs
    // sequentially so its duration is sum(service-duration) + LLM
    // roundtrips. The cycle's total duration is the critical number
    // for cadence — when it exceeds flushIntervalMs the next tick
    // queues up (see pendingFlushQueued). The cycle_timing event lets
    // us build dashboards that slice by stage and by service.
    const cycleDurationMs = Date.now() - cycleStartMs;
    const slowestEnrichment = Object.entries(perServiceEnrichment)
      .sort(([, a], [, b]) => b - a)[0] ?? null;
    const slowestCuration = Object.entries(perServiceCuration)
      .sort(([, a], [, b]) => b - a)[0] ?? null;
    console.log(
      `[cycle-timing] total=${cycleDurationMs}ms enrich=${enrichmentDurationMs}ms cureSvcs=${curationServicesMs}ms handler=${handlerMs}ms gen=${narrative ? "yes" : "skip"}` +
        (slowestEnrichment ? ` slowEnrich=${slowestEnrichment[0]}:${slowestEnrichment[1]}ms` : "") +
        (slowestCuration ? ` slowCure=${slowestCuration[0]}:${slowestCuration[1]}ms` : ""),
    );
    captureEvent({
      name: "cycle_timing",
      broadcastId: this.broadcastId,
      properties: {
        "cycle.totalMs": cycleDurationMs,
        "cycle.enrichmentMs": enrichmentDurationMs,
        "cycle.curationServicesMs": curationServicesMs,
        "cycle.handlerMs": handlerMs,
        "cycle.triggerReason": triggerReason,
        "cycle.generated": narrative !== null,
        "cycle.entryCount": entries.length,
        "cycle.annotationCount": annotations.length,
        "cycle.perServiceEnrichmentMs": perServiceEnrichment,
        "cycle.perServiceCurationMs": perServiceCuration,
      },
    });

    return enriched;
  }

  getSnapshots(): ServiceSnapshot[] {
    return this.registry.getSnapshots();
  }
}

function buildCurationSnapshot(curated: import("../curation/types.js").CuratedPayload | null): Record<string, unknown> {
  if (!curated) {
    return { skipped: true };
  }
  const ctx = curated.context;
  return {
    mode: ctx.mode,
    forceContextLed: ctx.forceContextLed ?? false,
    skipped: false,
    decisions: ctx.decisions,
    conflicts: ctx.conflicts,
    summary: ctx.summary ?? null,
    pacing: ctx.pacing,
    selectedEntryIds: curated.entries.map((e) => e.id),
    selectedAnnotations: curated.annotations,
    triggerReason: curated.triggerReason,
  };
}
