/**
 * Commentary distillation buffer.
 *
 * Collects raw transcription utterances as they arrive from Deepgram
 * and flushes them through the distiller in batches. Routes the
 * distiller's three output classes via injected callbacks:
 *
 *   - atmosphere   → push immediately to Kairos as match_action
 *   - event_texture → buffer in the correlator (waiting for canonical)
 *   - event_claim   → buffer in the correlator (waiting for canonical)
 *
 * Two flush triggers:
 *
 *   - Time-based: 12 seconds of buffered utterances (default).
 *   - Reactive: an external caller (the runner) calls `flush()` when
 *     a Sportmonks canonical event is about to be processed, so any
 *     commentary leading up to the event makes it into the correlator
 *     before the event itself does.
 *
 * Sequential flushes — if a flush is already in flight when another
 * is requested, the second waits for the first. Lines that arrive
 * while a flush is running are caught by the next flush; we never
 * lose buffered content.
 */
import {
  distillCommentary,
  type AtmosphereOutput,
  type DistillationOutput,
  type EventClaimOutput,
  type EventTextureOutput,
} from "./distiller.js";

/** Default time between automatic flushes. Tuned to land roughly 2-3
 * distillations per Kairos cycle (cycles run at 30-45s). */
export const DEFAULT_FLUSH_INTERVAL_MS = 12_000;

interface BufferedLine {
  text: string;
  /** Wall-clock instant of the originating utterance. Used by the
   * runner to stamp downstream entries with the correct phase /
   * content-time anchor. */
  observedAtMs: number;
}

export interface DistillationContextProvider {
  /** Returns short summaries of canonical events the broadcast-runner
   * has seen recently, oldest first. The distiller uses these to avoid
   * re-extracting claims/texture for events it already covered in a
   * prior chunk. */
  getRecentCanonicalEvents: () => string[];
  /** Match-clock anchor at the chunk's mid-point (e.g. "3", "45+1").
   * Returns null pre-kickoff or between phases. */
  getContentTimeAnchor: () => string | null;
  /** Roster + team-name context for player-name discipline. The
   * distiller uses these to snap near-miss transcriptions back to
   * canonical names and drop unknowns. Returns the most-current
   * lineup snapshot — lineups can update mid-broadcast so we read on
   * each flush rather than capture at construction. Returns nulls /
   * empty arrays when the lineup isn't available (pre-match windows
   * with no published XI). */
  getRosters?: () => {
    home: string[];
    away: string[];
    homeTeamName?: string;
    awayTeamName?: string;
  };
}

export interface DistillationCallbacks {
  /** Each atmosphere output is anchored on the latest line that
   * informed it. The runner pushes these to Kairos as match_action
   * entries with no `parentSourceId`. */
  onAtmosphere: (output: AtmosphereOutput, observedAtMs: number) => void;
  /** Each event-texture output is anchored on the latest line that
   * informed it. The runner buffers these in the correlator (or
   * pushes immediately with `parentSourceId` if a matching canonical
   * is already in the ledger). */
  onEventTexture: (output: EventTextureOutput, observedAtMs: number) => void;
  /** Each event-claim is anchored on the precise line where commentary
   * asserted the claim. The runner correlates against the canonical
   * ledger to fire calibration samples. */
  onEventClaim: (output: EventClaimOutput, observedAtMs: number) => void;
}

export interface DistillationBufferOptions {
  flushIntervalMs?: number;
  /** Override the distiller for testing — defaults to the production
   * Haiku call. */
  distill?: typeof distillCommentary;
}

/**
 * Per-broadcast distillation buffer. The runner constructs one,
 * pumps `add()` on every Deepgram utterance, calls `flush()` reactively
 * on canonical events, and `stop()` at broadcast end.
 */
export class CommentaryDistillationBuffer {
  private buffer: BufferedLine[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private flushInFlight: Promise<void> | null = null;
  private stopped = false;
  private readonly flushIntervalMs: number;
  private readonly distill: typeof distillCommentary;

  constructor(
    private readonly callbacks: DistillationCallbacks,
    private readonly context: DistillationContextProvider,
    options: DistillationBufferOptions = {},
  ) {
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.distill = options.distill ?? distillCommentary;
  }

  /** Buffer a transcription utterance. Schedules a time-based flush
   * if one isn't already pending. */
  add(text: string, observedAtMs: number): void {
    if (this.stopped) return;
    if (!text.trim()) return;
    this.buffer.push({ text, observedAtMs });
    this.scheduleAutoFlush();
  }

  /**
   * Flush immediately. Drains any buffered lines through the
   * distiller and routes the outputs. Awaits any in-flight flush
   * first so caller can rely on "after this resolves, the buffer is
   * caught up to the lines that existed when I called". Lines that
   * arrive *during* the flush land in the next batch.
   */
  async flush(): Promise<void> {
    if (this.flushInFlight) await this.flushInFlight;
    if (this.stopped || this.buffer.length === 0) return;

    this.cancelAutoFlush();

    const chunk = this.buffer.splice(0, this.buffer.length);

    const promise = this.runFlush(chunk);
    this.flushInFlight = promise;
    try {
      await promise;
    } finally {
      if (this.flushInFlight === promise) this.flushInFlight = null;
    }
  }

  /** Cancel pending timers; further `add()` calls are no-ops.
   * Outstanding in-flight flush completes naturally. */
  stop(): void {
    this.stopped = true;
    this.cancelAutoFlush();
  }

  // ---- internals ----

  private scheduleAutoFlush(): void {
    if (this.flushTimer || this.stopped) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
  }

  private cancelAutoFlush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private async runFlush(chunk: BufferedLine[]): Promise<void> {
    let result: DistillationOutput;
    const rosters = this.context.getRosters?.();
    try {
      result = await this.distill({
        lines: chunk.map((l) => l.text),
        recentCanonicalEvents: this.context.getRecentCanonicalEvents(),
        subjectTimeAnchor: this.context.getContentTimeAnchor(),
        homeRoster: rosters?.home,
        awayRoster: rosters?.away,
        homeTeamName: rosters?.homeTeamName,
        awayTeamName: rosters?.awayTeamName,
      });
    } catch (err) {
      console.error(
        `[distillation-buffer] flush failed (${chunk.length} lines): ${(err as Error).message}`,
      );
      return;
    }

    const lastLineMs = chunk[chunk.length - 1]?.observedAtMs ?? Date.now();
    const lineMs = (idx: number) => chunk[idx]?.observedAtMs ?? lastLineMs;

    // Atmosphere: anchored at the latest informing line. Multiple
    // atmospheres in one chunk each get their own anchor.
    for (const a of result.atmosphere) {
      const observedAt = a.fromLines.length > 0
        ? Math.max(...a.fromLines.map(lineMs))
        : lastLineMs;
      try {
        this.callbacks.onAtmosphere(a, observedAt);
      } catch (err) {
        console.error(`[distillation-buffer] onAtmosphere callback threw: ${(err as Error).message}`);
      }
    }

    // Event texture: anchored at the latest informing line. The line
    // span often covers build-up + reaction, so we want the trailing
    // edge so the runner's canonical-correlation window is generous.
    for (const t of result.eventTexture) {
      const observedAt = t.fromLines.length > 0
        ? Math.max(...t.fromLines.map(lineMs))
        : lastLineMs;
      try {
        this.callbacks.onEventTexture(t, observedAt);
      } catch (err) {
        console.error(`[distillation-buffer] onEventTexture callback threw: ${(err as Error).message}`);
      }
    }

    // Event claims: anchored on the precise line that asserted the
    // claim. Calibration accuracy depends on this — using anything
    // other than the originating line would smear the timing signal.
    for (const c of result.eventClaim) {
      const observedAt = lineMs(c.fromLine);
      try {
        this.callbacks.onEventClaim(c, observedAt);
      } catch (err) {
        console.error(`[distillation-buffer] onEventClaim callback threw: ${(err as Error).message}`);
      }
    }
  }
}
