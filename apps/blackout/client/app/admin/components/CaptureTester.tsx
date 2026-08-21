"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { PillButton } from "../../components/PillButton";
import { brand as C } from "../../lib/palette";
import { Stat } from "./Stat";

/**
 * In-browser verification that a stream URL works through the same
 * pipeline the moderator console uses: <audio crossOrigin> (with
 * hls.js for HLS) → Web Audio → MediaRecorder webm/opus.
 *
 * No server round-trip and no Deepgram cost. Confirms that:
 *   - the URL is reachable and CORS-permissive for this origin,
 *   - the codec / container plays in the browser,
 *   - MediaRecorder produces non-empty chunks at the configured
 *     timeslice (proves the encoding side of the capture pipeline),
 *   - audio is actually present (level meter via AnalyserNode —
 *     a silent stream looks the same as an ad break, but a flat
 *     line means the source is dead).
 */

interface CaptureStats {
  chunks: number;
  bytes: number;
  startedAt: number;
  level: number; // 0..1, smoothed peak
  error: string | null;
}

const isHlsUrl = (url: string) =>
  url.includes(".m3u8") || url.includes("application/vnd.apple.mpegurl");

export function CaptureTester({ streamUrl }: { streamUrl: string }) {
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [stats, setStats] = useState<CaptureStats>({
    chunks: 0,
    bytes: 0,
    startedAt: 0,
    level: 0,
    error: null,
  });
  const [now, setNow] = useState(Date.now());

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const srcNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const destNodeRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const hlsRef = useRef<Hls | null>(null);
  const rafRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    if (recorderRef.current) {
      try { recorderRef.current.stop(); } catch {}
      recorderRef.current = null;
    }
    if (hlsRef.current) {
      try { hlsRef.current.destroy(); } catch {}
      hlsRef.current = null;
    }
    if (audioRef.current) {
      try {
        audioRef.current.pause();
        audioRef.current.removeAttribute("src");
        audioRef.current.load();
      } catch {}
    }
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (gainNodeRef.current) gainNodeRef.current.gain.value = 0;
    setActive(false);
    setListening(false);
  }, []);

  const start = useCallback(() => {
    if (active || !streamUrl) return;
    const audio = audioRef.current;
    if (!audio) return;
    setStats({ chunks: 0, bytes: 0, startedAt: Date.now(), level: 0, error: null });

    audio.crossOrigin = "anonymous";
    if (isHlsUrl(streamUrl)) {
      if (Hls.isSupported()) {
        const hls = new Hls({ liveSyncDuration: 1, liveMaxLatencyDuration: 3 });
        hls.loadSource(streamUrl);
        hls.attachMedia(audio);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          audio.play().catch((err) =>
            setStats((s) => ({ ...s, error: `play(): ${err.message}` })),
          );
        });
        hls.on(Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) {
            setStats((s) => ({
              ...s,
              error: `hls.js: ${data.type} / ${data.details}`,
            }));
          }
        });
        hlsRef.current = hls;
      } else if (audio.canPlayType("application/vnd.apple.mpegurl")) {
        audio.src = streamUrl;
        audio.play().catch((err) =>
          setStats((s) => ({ ...s, error: `play(): ${err.message}` })),
        );
      } else {
        setStats((s) => ({ ...s, error: "HLS not supported in this browser" }));
        return;
      }
    } else {
      audio.src = streamUrl;
      audio.play().catch((err) =>
        setStats((s) => ({ ...s, error: `play(): ${err.message}` })),
      );
    }

    const ctx = ctxRef.current ?? new AudioContext();
    ctxRef.current = ctx;
    // AudioContext is created in 'suspended' state and won't pull
    // samples through the graph until resumed — the user-gesture
    // click satisfies the autoplay policy but resume is still
    // needed explicitly. Without this the analyser stays at silence
    // (128) and MediaRecorder only emits container overhead bytes,
    // which looks like "capture working but meter dead".
    if (ctx.state === "suspended") {
      void ctx.resume().catch(() => {});
    }
    const src = srcNodeRef.current ?? ctx.createMediaElementSource(audio);
    srcNodeRef.current = src;

    const analyser = analyserRef.current ?? ctx.createAnalyser();
    analyser.fftSize = 512;
    analyserRef.current = analyser;

    const dest = destNodeRef.current ?? ctx.createMediaStreamDestination();
    destNodeRef.current = dest;

    // Speaker branch goes through a GainNode so the Listen button can
    // toggle audibility without touching capture. Default 0 — admin
    // shouldn't blast a stream just because the row was opened.
    const gain = gainNodeRef.current ?? ctx.createGain();
    if (!gainNodeRef.current) {
      gain.connect(ctx.destination);
      gainNodeRef.current = gain;
    }
    gain.gain.value = 0;

    // Wire (idempotent — reusing nodes across start/stop just leaves
    // them connected). Capture and analyser take the full-volume signal
    // direct from src; the gain only sits on the speaker path.
    src.connect(analyser);
    src.connect(dest);
    src.connect(gain);

    const recorder = new MediaRecorder(dest.stream, {
      mimeType: "audio/webm;codecs=opus",
    });
    recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return;
      setStats((s) => ({ ...s, chunks: s.chunks + 1, bytes: s.bytes + e.data.size }));
    };
    recorder.onerror = (e) =>
      setStats((s) => ({ ...s, error: `recorder: ${(e as Event).type}` }));
    recorder.start(250);
    recorderRef.current = recorder;

    // Level meter: peak of the time-domain waveform, exponentially
    // smoothed so the bar doesn't strobe on every frame. Decay set
    // slow enough that brief transients in commentary stay visible
    // for a few frames.
    const buf = new Uint8Array(analyser.fftSize);
    let smoothed = 0;
    let logged = false;
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      smoothed = Math.max(peak, smoothed * 0.92);
      if (!logged && peak > 0.01) {
        logged = true;
        console.log(`[capture-test] first audio detected, peak=${peak.toFixed(3)}, ctx.state=${ctxRef.current?.state}`);
      }
      setStats((s) => ({ ...s, level: smoothed }));
      setNow(Date.now());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    setActive(true);
  }, [active, streamUrl]);

  useEffect(() => () => stop(), [stop]);

  const elapsedMs = active ? Math.max(0, now - stats.startedAt) : 0;
  const kbps = elapsedMs > 100
    ? ((stats.bytes * 8) / 1000 / (elapsedMs / 1000)).toFixed(1)
    : "—";

  return (
    <div
      style={{
        marginTop: 18,
        padding: "12px 14px",
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        fontSize: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <div>
          <div style={{
            fontSize: 10, fontWeight: 500, letterSpacing: "0.12em",
            textTransform: "uppercase", color: C.stone, marginBottom: 2,
          }}>
            Capture test
          </div>
          <div style={{ color: C.driftwood }}>
            Verifies the stream reaches the browser via the same pipeline the
            moderator uses. Speakers stay silent.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {active ? (
            <PillButton
              variant="ghost"
              onClick={() => {
                const g = gainNodeRef.current;
                if (!g) return;
                const next = !listening;
                g.gain.value = next ? 1 : 0;
                setListening(next);
              }}
            >
              {listening ? "Mute" : "Listen"}
            </PillButton>
          ) : null}
          {active ? (
            <PillButton variant="destructive" onClick={stop}>Stop</PillButton>
          ) : (
            <PillButton variant="primary" onClick={start} disabled={!streamUrl}>
              Start
            </PillButton>
          )}
        </div>
      </div>

      {active || stats.chunks > 0 || stats.error ? (
        <div style={{ marginTop: 12 }}>
          {stats.error ? (
            <div style={{ color: C.crimson, marginBottom: 8 }}>{stats.error}</div>
          ) : null}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(4, 1fr)",
              gap: 12,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <Stat label="Chunks" value={String(stats.chunks)} />
            <Stat label="Bytes" value={`${(stats.bytes / 1024).toFixed(1)} KB`} />
            <Stat label="Bitrate" value={`${kbps} kbps`} />
            <Stat label="Elapsed" value={`${(elapsedMs / 1000).toFixed(1)}s`} />
          </div>
          {/* Level meter — peak amplitude of the captured signal,
              smoothed so a normal commentary segment shows continuous
              motion. A flat bar with chunks still firing means the
              source is silent (ad break, dead stream, wrong URL). */}
          <div
            style={{
              marginTop: 10,
              height: 6,
              borderRadius: 3,
              background: `${C.celadon}80`,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.min(100, stats.level * 220)}%`,
                height: "100%",
                background: stats.level > 0.02 ? C.forest : C.stone,
                transition: "width 60ms linear",
              }}
            />
          </div>
        </div>
      ) : null}

      {/* Hidden audio element — the source for Web Audio. Never plays
          through speakers (muted) but is a real DOM element so the
          browser's media stack actually fetches and decodes the
          stream. */}
      <audio ref={audioRef} style={{ display: "none" }} />
    </div>
  );
}

