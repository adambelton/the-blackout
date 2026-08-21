"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";

/**
 * Moderator-side audio capture hook.
 *
 * Owns the entire UK-resident-browser audio pipeline:
 *   audioEl → MediaElementSource ─┬─→ GainNode → speakers
 *                                 └─→ AudioWorkletNode → port → WS (binary)
 *
 * The audio element itself is owned by the page (rendered into the
 * DOM); this hook receives a ref to it. Same for the moderator
 * WebSocket — the hook only forwards binary PCM frames into it.
 *
 * Pipeline:
 *   1. hls.js (or direct <audio src>) loads the radio stream into
 *      the page's audio element. CORS = anonymous so Web Audio can
 *      tap it later.
 *   2. armCapture() builds the Web Audio graph: source → worklet
 *      (down-samples + int16 PCM) → port → WS as binary frames.
 *      Server pipes those into Deepgram with linear16/16kHz/mono.
 *   3. Listen toggle controls the speaker branch's gain only —
 *      capture stays full-volume regardless.
 *   4. disarmCapture() tears the graph down. Idempotent.
 *
 * The capture branch was originally MediaRecorder → webm/opus.
 * AudioWorklet → linear16 PCM is structurally more reliable on
 * desktop moderators (no codec init segment to drop on WS reconnect;
 * Deepgram parses raw PCM with explicit encoding rather than
 * sniffing container framing). Confirmed live 2026-05-02.
 */

// Usage: call armCapture() inside a user-gesture handler (e.g. "Go live"
// button) to wire the Web Audio graph. Call disarmCapture() on broadcast
// completion or unmount. toggleListening() controls speaker gain only —
// capture continues at full volume regardless.

interface UseAudioCaptureOptions {
  /** The radio source URL (HLS .m3u8 or direct media). */
  streamUrl: string;
  /** Page-owned <audio> element. The hook taps this for both speaker
   * playback and Web Audio capture. */
  audioRef: React.RefObject<HTMLAudioElement | null>;
  /** Moderator WebSocket. Binary PCM frames are sent here.
   * Held by ref so the hook always sees the live socket through
   * reconnects. */
  wsRef: React.RefObject<WebSocket | null>;
  /** When the broadcast flips to complete, capture is disarmed
   * automatically — the runner's transcription pipe is closed
   * server-side anyway. */
  broadcastStatus: string | undefined;
}

export interface AudioCaptureControls {
  /** True while the worklet is wired and pumping PCM to the WS. */
  captureActive: boolean;
  /** True while the speaker branch is unmuted. */
  isListeningLocally: boolean;
  /** Build the Web Audio graph + worklet. Called from goLive after
   * the user gesture has unblocked autoplay. Idempotent. */
  armCapture: () => Promise<void>;
  /** Tear down the worklet + audio source. Idempotent. */
  disarmCapture: () => void;
  /** Pre-capture: start direct playback. Post-capture: open the
   * speaker branch's gain. */
  startListening: () => void;
  /** Pre-capture: stop playback. Post-capture: mute the speaker
   * branch (capture stays live). */
  stopListening: () => void;
}

const isHlsUrl = (url: string) =>
  url.includes(".m3u8") || url.includes("application/vnd.apple.mpegurl");

/**
 * Pure dispatcher for PCM frames coming off the worklet's MessagePort.
 * Forwards `ArrayBuffer` payloads to the WS only when the socket is
 * open and the frame is non-empty. Anything else is silently dropped —
 * the worklet emits steady frames and we don't want backpressure noise
 * for transient closed-socket states (reconnects, shutdown).
 */
export function dispatchPcmFrame(
  ws: WebSocket | null,
  data: unknown,
): boolean {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  if (!(data instanceof ArrayBuffer) || data.byteLength === 0) return false;
  ws.send(data);
  return true;
}

export function useAudioCapture({
  streamUrl,
  audioRef,
  wsRef,
  broadcastStatus,
}: UseAudioCaptureOptions): AudioCaptureControls {
  const [captureActive, setCaptureActive] = useState(false);
  const [isListeningLocally, setIsListeningLocally] = useState(false);

  // Refs for cross-render audio plumbing. Each ref + lifecycle is
  // implicit by design — the speaker branch's gain reads the page's
  // current "listening" intent on every state change.
  const hlsRef = useRef<Hls | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const audioCtxModuleLoadedRef = useRef(false);
  const srcNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Mirror of captureActive for closure-safe reads inside the
  // worklet onmessage and disarm path.
  const captureActiveRef = useRef(false);

  const loadAudioSource = useCallback((audio: HTMLAudioElement, url: string) => {
    // crossOrigin must be set BEFORE assigning src, otherwise the
    // CORS preflight is skipped and Web Audio's
    // createMediaElementSource refuses to tap the element later.
    audio.crossOrigin = "anonymous";

    if (isHlsUrl(url)) {
      if (Hls.isSupported()) {
        // liveSyncDuration: 1 + liveMaxLatencyDuration: 3 → play
        // within ~6s of live edge instead of the default ~18s
        // (3 × 6s segments on BBC's manifest). Browser-capture
        // latency is dominated by hls.js's live-sync window.
        const hls = new Hls({ liveSyncDuration: 1, liveMaxLatencyDuration: 3 });
        hls.loadSource(url);
        hls.attachMedia(audio);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          audio.play().catch((err) =>
            console.warn("[moderator] audio autoplay blocked:", err),
          );
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal || data.type === "networkError") {
            console.error("[moderator] hls error:", {
              type: data.type,
              details: data.details,
              fatal: data.fatal,
              url: data.url,
            });
          }
        });
        hlsRef.current = hls;
      } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        audio.src = url;
        audio.play().catch((err) =>
          console.warn("[moderator] audio autoplay blocked:", err),
        );
      }
    } else {
      audio.src = url;
      audio.play().catch((err) =>
        console.warn("[moderator] audio autoplay blocked:", err),
      );
    }
  }, []);

  const teardownAudioSource = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
    }
  }, [audioRef]);

  const armCapture = useCallback(async () => {
    if (captureActiveRef.current) return;
    const url = streamUrl.trim();
    if (!url) {
      console.warn("[moderator] armCapture: no streamUrl");
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;

    // Fresh load — pre-goLive direct-play may have left src bound.
    // Tear down (including any hls instance) then reload via the
    // same loader so the Web Audio tap below attaches to a clean
    // element.
    teardownAudioSource();
    loadAudioSource(audio, url);

    let ctx = audioCtxRef.current;
    if (!ctx) {
      ctx = new AudioContext();
      audioCtxRef.current = ctx;
    }
    // AudioContext starts suspended — the user-gesture click on
    // Go live satisfies the autoplay policy but resume is still
    // needed explicitly.
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    // addModule throws on a second call with the same URL — load
    // once per AudioContext.
    if (!audioCtxModuleLoadedRef.current) {
      try {
        await ctx.audioWorklet.addModule("/audio-capture-processor.js");
        audioCtxModuleLoadedRef.current = true;
      } catch (err) {
        console.error("[moderator] failed to load audio worklet:", err);
        return;
      }
    }

    // createMediaElementSource can only be called ONCE per element.
    // Reuse the cached node across capture restarts.
    if (!srcNodeRef.current) {
      srcNodeRef.current = ctx.createMediaElementSource(audio);
    }
    const src = srcNodeRef.current;

    if (!gainNodeRef.current) {
      gainNodeRef.current = ctx.createGain();
      src.connect(gainNodeRef.current).connect(ctx.destination);
    }
    // Force-mute speakers when capture starts. The moderator should
    // be paying attention to the narrator's TTS once live, not the
    // radio commentary. Capture itself is unaffected — it taps src
    // directly via the worklet branch. The Listen toggle below
    // re-routes through this same gain node so the moderator can
    // opt back in to monitoring the radio if they need to.
    gainNodeRef.current.gain.value = 0;
    setIsListeningLocally(false);

    // Tear down a previous worklet instance if we're re-arming.
    // AudioWorkletNode has no .stop() — disconnect is the way to
    // end its participation in the graph.
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch { /* already gone */ }
      try { workletNodeRef.current.port.close(); } catch { /* already gone */ }
      workletNodeRef.current = null;
    }

    const wn = new AudioWorkletNode(ctx, "audio-capture-processor");
    wn.port.onmessage = (e) => {
      dispatchPcmFrame(wsRef.current, e.data);
    };
    wn.onprocessorerror = (err) => console.error("[moderator] worklet error", err);
    src.connect(wn);
    workletNodeRef.current = wn;

    captureActiveRef.current = true;
    setCaptureActive(true);
    console.log(
      `[moderator] audio capture armed (AudioWorklet → linear16, ctx=${ctx.sampleRate}Hz → 16kHz)`,
    );
  }, [streamUrl, loadAudioSource, teardownAudioSource, audioRef, wsRef]);

  const disarmCapture = useCallback(() => {
    if (workletNodeRef.current) {
      try { workletNodeRef.current.disconnect(); } catch { /* already gone */ }
      try { workletNodeRef.current.port.close(); } catch { /* already gone */ }
      workletNodeRef.current = null;
    }
    teardownAudioSource();
    captureActiveRef.current = false;
    setCaptureActive(false);
    console.log("[moderator] audio capture disarmed");
  }, [teardownAudioSource]);

  const startListening = useCallback(() => {
    if (captureActiveRef.current && gainNodeRef.current) {
      gainNodeRef.current.gain.value = 1;
      setIsListeningLocally(true);
      return;
    }
    const url = streamUrl.trim();
    if (!url) return;
    const audio = audioRef.current;
    if (!audio) return;
    loadAudioSource(audio, url);
    setIsListeningLocally(true);
  }, [streamUrl, loadAudioSource, audioRef]);

  const stopListening = useCallback(() => {
    if (captureActiveRef.current && gainNodeRef.current) {
      gainNodeRef.current.gain.value = 0;
      setIsListeningLocally(false);
      return;
    }
    teardownAudioSource();
    setIsListeningLocally(false);
  }, [teardownAudioSource]);

  // Tear capture down on unmount so a route change doesn't leave
  // the worklet running against a dead WebSocket.
  useEffect(() => {
    return () => {
      if (captureActiveRef.current) {
        try { workletNodeRef.current?.disconnect(); } catch { /* already gone */ }
      }
    };
  }, []);

  // Watchdog: if the broadcast row flips to complete from elsewhere
  // (auto-complete on full-time, another moderator ending the
  // broadcast), tear down capture. The runner's transcription pipe
  // is closed server-side anyway; we just stop burning bandwidth.
  useEffect(() => {
    if (broadcastStatus === "complete" && captureActiveRef.current) {
      disarmCapture();
    }
  }, [broadcastStatus, disarmCapture]);

  return {
    captureActive,
    isListeningLocally,
    armCapture,
    disarmCapture,
    startListening,
    stopListening,
  };
}
