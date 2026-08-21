import { DeepgramClient } from "@deepgram/sdk";

type V1Socket = Awaited<ReturnType<DeepgramClient["listen"]["v1"]["connect"]>>;

/** Cap for the close-then-reopen retry budget. Five attempts covers
 * the realistic case of a moderator's network blipping or a brief
 * Deepgram-side hiccup; beyond that, something deeper is wrong and
 * we surface it as a hard error rather than burning Deepgram credit
 * in a tight loop. */
const MAX_REOPEN_ATTEMPTS = 5;
/** Pause before a reopen attempt — keeps a steady-state failure from
 * looping at full speed. */
const REOPEN_DELAY_MS = 1000;

/**
 * Lifecycle states the pipeline emits via `onStatus`. Consumers
 * (broadcast-runner) discriminate on these to drive UI / self-healing
 * behaviour. `error` is the only state that carries a `message` —
 * everything else is a bare signal.
 *
 *   connecting → ready → streaming → stopped
 *                 ↓
 *               error
 */
export const TRANSCRIPTION_STATUSES = [
  "connecting",
  "ready",
  "streaming",
  "stopped",
  "error",
] as const;
export type TranscriptionStatus = (typeof TRANSCRIPTION_STATUSES)[number];

export interface TranscriptionUtterance {
  text: string;
  /**
   * Wall-clock instant (ms since epoch) at which the utterance ended in
   * the audio stream. Computed as `streamStartWallClock + (msg.start +
   * msg.duration) * 1000`, where `streamStartWallClock` is anchored on
   * the moment the FIRST audio chunk arrived from the moderator's
   * browser. Subtract the radio-source offset from this value to derive
   * the real match-time anchor — the offset gets calibrated against
   * canonical events and absorbs the browser → server transit budget.
   */
  utteranceEndWallClock: number;
}

/**
 * Pipes audio chunks captured in the moderator's browser through to
 * Deepgram and yields final transcript fragments.
 *
 * Pre-2026-05-02 this pipeline fetched the radio stream from the server
 * and decoded it (direct MP3 / HLS / ffmpeg-transcoded). That path was
 * retired when hosted egress proved incompatible with UK-rights audio
 * sources. Capture now happens in the moderator's
 * UK-resident browser via Web Audio + MediaRecorder, and the bytes
 * arrive over the moderator WebSocket as binary frames. This pipeline
 * just opens the Deepgram socket and forwards whatever the browser
 * sends.
 *
 * Deepgram sniffs the format (webm/opus from MediaRecorder) — `encoding`
 * stays unset, same way the old direct-MP3 path worked.
 */
export class TranscriptionPipeline {
  private socket: V1Socket | null = null;
  private socketOpen = false;
  private stopped = false;
  private streamStartWallClock: number | null = null;
  private reopenAttempts = 0;
  // Pre-open chunk queue. Browser starts shipping audio the moment
  // the user clicks Go live, but the server's Deepgram socket takes
  // a few hundred ms to open after activateBroadcast finishes. Without
  // this queue, the FIRST chunk — which contains the webm container's
  // init segment — gets dropped (sendMedia throws "Socket is not
  // open"). Continuation chunks then arrive at Deepgram with no init,
  // so it can't decode them, sends a Metadata handshake, and closes
  // cleanly with code 1000. Buffering early chunks here and flushing
  // on socket open preserves the init segment.
  private preOpenQueue: Buffer[] = [];
  private chunkCount = 0;
  private totalBytes = 0;
  private onTranscript: (u: TranscriptionUtterance) => void = () => {};
  private onStatus: (status: TranscriptionStatus, message?: string) => void = () => {};

  constructor(
    private readonly apiKey: string,
    callbacks: {
      onTranscript: (u: TranscriptionUtterance) => void;
      onStatus?: (status: TranscriptionStatus, message?: string) => void;
    },
  ) {
    this.onTranscript = callbacks.onTranscript;
    if (callbacks.onStatus) this.onStatus = callbacks.onStatus;
  }

  /**
   * Open the Deepgram WebSocket. The pipeline is "armed" but receives
   * no audio until `pushAudioChunk` is called by the moderator WS
   * handler — first chunk seeds `streamStartWallClock`, which the
   * offset math anchors on.
   */
  async start(): Promise<void> {
    this.stopped = false;
    this.onStatus("connecting");

    const dg = new DeepgramClient({ apiKey: this.apiKey });

    // Explicit linear16 / 16kHz / mono — matches the AudioWorklet
    // processor's output (apps/blackout/client/public/audio-capture-processor.js).
    // We tried letting Deepgram sniff webm/opus from MediaRecorder
    // first; Deepgram's parser returned `duration: 0, channels: 0`
    // every time and closed cleanly with code 1000. Switching to
    // explicit raw PCM removes the container/codec compatibility
    // surface entirely (same path the OLD ffmpeg-transcoded HLS
    // used, which worked end-to-end).
    const socket = await dg.listen.v1.connect({
      model: "nova-2",
      language: "en-GB",
      smart_format: "true",
      punctuate: "true",
      interim_results: "false",
      endpointing: 500,
      encoding: "linear16",
      sample_rate: 16000,
      channels: 1,
      Authorization: `Token ${this.apiKey}`,
    });
    this.socket = socket;

    socket.on("message", (msg) => {
      // Diagnostic: log every Deepgram message type at least once per
      // socket. Especially useful for catching Metadata (proves the
      // model received valid audio) vs no messages at all (audio
      // unparseable, will close shortly).
      if (msg.type !== "Results") {
        console.log(`[transcription] Deepgram msg=${JSON.stringify(msg).slice(0, 500)}`);
      }
      if (msg.type !== "Results" || !msg.is_final) return;
      const transcript = msg.channel.alternatives[0]?.transcript?.trim();
      if (!transcript) return;
      // A successful transcript proves the pipe is healthy — clear
      // the close-reopen budget so a subsequent failure starts fresh.
      this.reopenAttempts = 0;

      const start = typeof msg.start === "number" ? msg.start : 0;
      const duration = typeof msg.duration === "number" ? msg.duration : 0;
      const anchor = this.streamStartWallClock ?? Date.now();
      const utteranceEndWallClock = anchor + (start + duration) * 1000;

      this.onTranscript({ text: transcript, utteranceEndWallClock });
    });

    socket.on("error", (err: Error) => {
      console.error("[transcription] Deepgram error:", err.message);
      this.onStatus("error", err.message);
    });

    socket.on("close", (event) => {
      if (this.stopped) return;
      // Auto-reopen instead of giving up. Deepgram closes the socket
      // after ~5-10s of silence or unparseable media (e.g. continuation
      // webm chunks without an init segment after a browser WS
      // reconnect). Reopening from the server side, paired with the
      // moderator console restarting MediaRecorder on its own WS
      // reconnect, gets the pipeline back to a working state without
      // a full broadcast restart. Bounded retry budget guards against
      // a tight loop if Deepgram itself is failing.
      const code = (event as unknown as { code?: number })?.code ?? "?";
      const reason = (event as unknown as { reason?: string | Buffer })?.reason;
      const reasonStr = typeof reason === "string" ? reason : reason?.toString("utf8") ?? "";
      console.log(
        `[transcription] Deepgram socket closed unexpectedly (code=${code}${reasonStr ? `, reason="${reasonStr}"` : ""}) — reopening`,
      );
      this.socket = null;
      this.socketOpen = false;
      this.streamStartWallClock = null;
      this.reopenAttempts++;
      if (this.reopenAttempts > MAX_REOPEN_ATTEMPTS) {
        console.error(
          `[transcription] Deepgram reopen budget exhausted (${MAX_REOPEN_ATTEMPTS} attempts) — giving up`,
        );
        this.onStatus("error", "Deepgram reopen failed after retries");
        this.stop();
        return;
      }
      setTimeout(() => {
        if (this.stopped) return;
        this.start().catch((err) => {
          console.error(`[transcription] reopen failed: ${(err as Error).message}`);
          this.onStatus("error", `reopen failed: ${(err as Error).message}`);
          this.stop();
        });
      }, REOPEN_DELAY_MS);
    });

    // Deepgram SDK v5's `listen.v1.connect()` returns an unconnected
    // wrapper. Call `.connect()` to actually open the underlying
    // websocket; otherwise `waitForOpen()` never resolves.
    socket.connect();
    await socket.waitForOpen();
    console.log("[transcription] Deepgram socket open (browser-capture mode)");
    this.socketOpen = true;
    // Flush any chunks the browser sent during the socket-opening
    // window. The first one carries the webm init segment — losing
    // it leaves Deepgram unable to decode subsequent continuation
    // chunks.
    if (this.preOpenQueue.length > 0) {
      console.log(
        `[transcription] flushing ${this.preOpenQueue.length} queued chunks (first chunk ${this.preOpenQueue[0].length} bytes)`,
      );
      for (const queued of this.preOpenQueue) {
        try { socket.sendMedia(queued); } catch { /* close handler will fire */ }
      }
      this.preOpenQueue = [];
    }
    this.onStatus("ready");
  }

  /**
   * Forward an audio chunk from the moderator's browser to Deepgram.
   * The first non-empty chunk seeds `streamStartWallClock` so the
   * utterance-end math anchors against the real beginning of capture.
   *
   * Silently ignored after `stop()` or before the socket has opened —
   * the moderator WS handler shouldn't be sending us anything in those
   * states, but a transient race (capture restart while the socket is
   * mid-open) shouldn't crash the runner.
   */
  pushAudioChunk(chunk: Buffer): void {
    if (this.stopped) return;
    if (this.streamStartWallClock == null) {
      this.streamStartWallClock = Date.now();
      this.onStatus("streaming");
      console.log(
        `[transcription] FIRST CHUNK: ${chunk.length} bytes, first 16 hex=${chunk.subarray(0, 16).toString("hex")}`,
      );
    }
    this.chunkCount++;
    this.totalBytes += chunk.length;
    if (this.chunkCount % 20 === 0) {
      console.log(
        `[transcription] chunks sent: ${this.chunkCount}, total bytes: ${this.totalBytes}, last chunk: ${chunk.length}b`,
      );
    }
    // Buffer chunks while the Deepgram socket is opening — the FIRST
    // chunk carries the webm container's init segment; without it
    // Deepgram can't decode anything that follows. Once the socket
    // opens, start() flushes the queue.
    if (!this.socket || !this.socketOpen) {
      this.preOpenQueue.push(chunk);
      return;
    }
    try {
      this.socket.sendMedia(chunk);
    } catch (err) {
      console.warn(`[transcription] sendMedia failed: ${(err as Error).message}`);
    }
  }

  stop(): void {
    this.stopped = true;
    try {
      this.socket?.close();
    } catch {
      // socket may already be closed
    }
    this.socket = null;
    this.socketOpen = false;
    this.streamStartWallClock = null;
    this.preOpenQueue = [];
    this.chunkCount = 0;
    this.totalBytes = 0;
    this.onStatus("stopped");
  }
}
