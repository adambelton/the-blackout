import type { ServiceRegistry } from "../registry.js";
import type { ServiceSnapshot } from "../enrichment/types.js";
import type { PacingSignal } from "./types.js";

export interface GenerationRecord {
  id: string;
  triggeredAt: number;
  wordCount: number;
  triggerReason: string;
}

export interface ConsumerPacingSignal {
  signal: PacingSignal;
  wordsPerMinute: number;
  receivedAt: number;
}

/**
 * Single source of truth for cross-service state the curator reads from.
 * Aggregates enrichment service snapshots with broadcast-level context
 * (elapsed time, generation history, consumer pacing signals) so curation
 * services don't each have to re-derive this picture.
 */
// EMA smoothing for consumer-reported wpm. 0.3 weights new readings
// meaningfully without letting a single bad clip swing the estimate.
const WPM_EMA_ALPHA = 0.3;
// Clamp bounds: prevent pathological reports (TTS clip stalled at 30wpm,
// stutter at 400wpm) from destabilising target_words downstream.
const WPM_MIN = 80;
const WPM_MAX = 220;
// Bound how far a single sample can pull the EMA once the estimate is
// warmed up. A Hume clip with a long silent trailer can briefly report
// ~60 wpm when the speaking rate is 145; without this bound, that one
// sample moves the estimate by α × (ceiling − 60) ≈ 25 wpm. Capping the
// per-sample delta keeps outliers to ≤ WPM_STEP_MAX × α ≈ 6 wpm while
// still letting real drift track across a few consecutive samples.
const WPM_STEP_MAX = 20;

export class BroadcastStateTracker {
  private startedAt: number = Date.now();
  private generations: GenerationRecord[] = [];
  private pacingSignals: ConsumerPacingSignal[] = [];
  private estimatedWpm: number | null = null;
  private runningSummary = "";

  constructor(
    readonly broadcastId: string,
    private registry: ServiceRegistry,
  ) {}

  markActivated(at: number = Date.now()): void {
    this.startedAt = at;
  }

  recordGeneration(record: GenerationRecord): void {
    this.generations.push(record);
  }

  recordPacingSignal(signal: ConsumerPacingSignal): void {
    this.pacingSignals.push(signal);
    const clamped = Math.max(WPM_MIN, Math.min(WPM_MAX, signal.wordsPerMinute));
    if (this.estimatedWpm == null) {
      this.estimatedWpm = clamped;
      return;
    }
    const bounded = Math.max(
      this.estimatedWpm - WPM_STEP_MAX,
      Math.min(this.estimatedWpm + WPM_STEP_MAX, clamped),
    );
    this.estimatedWpm = WPM_EMA_ALPHA * bounded + (1 - WPM_EMA_ALPHA) * this.estimatedWpm;
  }

  /** Smoothed estimate of consumer TTS wpm, or null until the first report. */
  getEstimatedWpm(): number | null {
    return this.estimatedWpm;
  }

  /** The narrator's running memory of the broadcast — replaces the
   * rolling feed window as the bulk context carrier in delta-prompt mode. */
  getRunningSummary(): string {
    return this.runningSummary;
  }

  setRunningSummary(summary: string): void {
    this.runningSummary = summary;
  }

  /** All enrichment + curation service snapshots (read-through from registry). */
  getServiceSnapshots(): ServiceSnapshot[] {
    return this.registry.getSnapshots();
  }

  getLastGeneration(): GenerationRecord | null {
    return this.generations[this.generations.length - 1] ?? null;
  }

  getGenerationCount(): number {
    return this.generations.length;
  }

  getElapsedMs(now: number = Date.now()): number {
    return now - this.startedAt;
  }

  getMsSinceLastGeneration(now: number = Date.now()): number | null {
    const last = this.getLastGeneration();
    if (!last) return null;
    return now - last.triggeredAt;
  }

  getLatestPacingSignal(): ConsumerPacingSignal | null {
    return this.pacingSignals[this.pacingSignals.length - 1] ?? null;
  }
}
