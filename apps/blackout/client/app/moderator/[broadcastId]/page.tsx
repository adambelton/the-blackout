"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { useCurrentUser } from "../../../lib/use-current-user";
import { AdminFooter } from "../../components/AdminFooter";
import { brand as C } from "../../lib/palette";
import { API_URL, apiFetch, apiGet, apiPatch } from "@/lib/api";
import { routes } from "@/lib/routes";
import { useReconnectingWebSocket } from "@/lib/ws";
import { STORAGE_KEYS } from "@/lib/storage-keys";
import {
  collectScheduleBlockers,
  type Broadcast,
  type BroadcastStatus,
  type BroadcastTtsProvider,
  type ModeratorFeedEntry,
  type ModeratorView,
  type RadioSource,
  type ServiceStatus,
} from "@blackout/shared";
import { useAudioCapture } from "./useAudioCapture";
import type { TtsVoice, NarrativeRecord, ModeratorPlayCue, LatencySample } from "./components/types";
import { Topbar } from "./components/Topbar";
import { StatusBar } from "./components/StatusBar";
import { GenerationPauseBanner } from "./components/GenerationPauseBanner";
import { LeftColumn } from "./components/LeftColumn";
import { NarratorVoicePanel } from "./components/NarratorVoicePanel";
import { CombinedFeedPanel } from "./components/CombinedFeedPanel";
import { NarrativesPanel } from "./components/NarrativesPanel";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Origin only — the path (`/ws/moderator`) is appended at the
// construction site below. Derived from API_URL so a deploy that
// sets NEXT_PUBLIC_API_URL automatically gets the matching WS origin —
// no second env var to forget. Mirrors how the matchroom builds its URL.
const WS_URL = API_URL.replace(/^http/, "ws");

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ModeratorPage() {
  const params = useParams();
  const broadcastId = params.broadcastId as string;
  const { user } = useCurrentUser();
  const isAdmin = user?.isAdmin ?? false;

  // ---- Core broadcast + connection state ---------------------------------
  const [ready, setReady] = useState(false);
  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [broadcastError, setBroadcastError] = useState<string | null>(null);
  // Set when the moderator clicks "Go live", cleared when the broadcast
  // row flips to `live` (or after a timeout). Disables the activate
  // button so the moderator can't double-fire while Kairos's brief-init
  // (~13s) is in flight.
  const [isActivating, setIsActivating] = useState(false);

  // Briefs (match + author voice) now live in the Content Studio
  // (`/studio/:id`). Moderator console links out to it.

  // ---- Voice picker + preview --------------------------------------------
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [expandedProviders, setExpandedProviders] = useState<Set<BroadcastTtsProvider>>(new Set());
  const [previewLoadingId, setPreviewLoadingId] = useState<string | null>(null);
  const [previewPlayingId, setPreviewPlayingId] = useState<string | null>(null);

  // ---- Radio commentary -------------------------------------------------
  // Source selection. Local-listen + capture state lives in the
  // useAudioCapture hook below — this page owns the source selection
  // and the audio element; the hook owns the Web Audio plumbing.
  const [streamUrl, setStreamUrl] = useState("");
  const [availableSources, setAvailableSources] = useState<RadioSource[]>([]);
  const [latencySamples, setLatencySamples] = useState<LatencySample[]>([]);

  // ---- Service status ---------------------------------------------------
  const [services, setServices] = useState<ServiceStatus[]>([]);

  // ---- Feed entries -----------------------------------------------------
  const [feedEntries, setFeedEntries] = useState<ModeratorFeedEntry[]>([]);
  const [moderatorInput, setModeratorInput] = useState("");

  // ---- Narratives + countdown ------------------------------------------
  const [narratives, setNarratives] = useState<NarrativeRecord[]>([]);
  const [playingNarrativeId, setPlayingNarrativeId] = useState<string | null>(null);
  const [narrativeEngineStatus, setNarrativeEngineStatus] = useState<string>("idle");
  const [narrativeCountdown, setNarrativeCountdown] = useState<number | null>(null);
  const [generationPause, setGenerationPause] = useState<
    { reason: string; retryAt: number | null; triggerReason?: string } | null
  >(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // ---- TTS voice + console-local autoplay ------------------------------
  // No frontend defaults — the broadcast row is the source of truth for
  // ttsVoiceId (UUID FK into tts_voices, stamped by the server at
  // createBroadcast). The voice's display name and provider resolve from
  // the /tts-voices catalogue keyed by id. Initial state is empty;
  // bootstrap fills ttsVoiceId; the derived effect below fills name +
  // provider from voices.find. The provider initial value is only used
  // to satisfy the type system — the derived effect replaces it.
  const [voices, setVoices] = useState<TtsVoice[]>([]);
  const [selectedVoiceId, setSelectedVoiceId] = useState("");
  const [selectedVoiceName, setSelectedVoiceName] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<BroadcastTtsProvider>("openai");

  // Console-local autoplay. Independent of any broadcast-level setting —
  // this only governs whether the moderator's browser plays narrative
  // audio, not whether the matchroom or pipeline produces it. Persisted
  // per-browser via localStorage so the moderator's preference carries
  // across broadcasts without writing to the broadcast row.
  const [consoleAutoplay, setConsoleAutoplay] = useState(false);

  // ---- Refs shared across effects --------------------------------------
  const wsRef = useRef<WebSocket | null>(null);
  const streamUrlRef = useRef(streamUrl);
  const availableSourcesRef = useRef<RadioSource[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null); // radio playback (also tapped for capture once live)
  const narrativeAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);

  // Audio capture pipeline lives in a hook — owns the hls.js loader,
  // Web Audio graph, AudioWorklet PCM forwarding to the moderator
  // WebSocket, listen-toggle gain control, and the auto-disarm on
  // broadcast completion. The page only owns the <audio> element
  // and the source URL. See the hook for the full architecture
  // rationale (UK-resident browser, AudioWorklet vs MediaRecorder,
  // graph split for speaker-vs-capture independence).
  const {
    captureActive,
    isListeningLocally,
    armCapture,
    disarmCapture,
    startListening,
    stopListening,
  } = useAudioCapture({
    streamUrl,
    audioRef,
    wsRef,
    broadcastStatus: broadcast?.status,
  });

  const feedScrollRef = useRef<HTMLDivElement | null>(null);
  const narrativeScrollRef = useRef<HTMLDivElement | null>(null);
  const selectedVoiceRef = useRef(selectedVoiceId);
  const selectedProviderRef = useRef<BroadcastTtsProvider>(selectedProvider);
  const consoleAutoplayRef = useRef(consoleAutoplay);
  const ttsEnabledRef = useRef(false);
  // Preloaded <audio> elements keyed by narrationId — populated on
  // `preload` cues so the browser downloads ahead of time. Drained on
  // `play`. Per the server-authoritative playback contract, every
  // listener (moderator + matchroom) plays the same bytes at the same
  // instant; late joiners or console-autoplay-toggled-on re-entries
  // seek to the live offset.
  const preloadedAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Holds a `play` cue that arrived while consoleAutoplay was off.
  const pendingPlayRef = useRef<{ cue: ModeratorPlayCue; clientStartTime: number } | null>(null);
  const isPlayingRef = useRef(false);
  const nextGenerateAtRef = useRef<number | null>(null);

  useEffect(() => { streamUrlRef.current = streamUrl; }, [streamUrl]);
  useEffect(() => { availableSourcesRef.current = availableSources; }, [availableSources]);
  useEffect(() => { selectedVoiceRef.current = selectedVoiceId; }, [selectedVoiceId]);
  useEffect(() => { selectedProviderRef.current = selectedProvider; }, [selectedProvider]);
  useEffect(() => { consoleAutoplayRef.current = consoleAutoplay; }, [consoleAutoplay]);
  useEffect(() => { ttsEnabledRef.current = broadcast?.ttsEnabled === true; }, [broadcast?.ttsEnabled]);

  // Clear the activating-pending state once the broadcast row's status
  // moves off `scheduled` (typically to `live`). Safety timeout below
  // covers the case where activation fails silently — the moderator
  // gets the button back after 30s instead of being stuck.
  useEffect(() => {
    if (!isActivating) return;
    if (broadcast && broadcast.status !== "scheduled") {
      setIsActivating(false);
      return;
    }
    const timer = setTimeout(() => setIsActivating(false), 30_000);
    return () => clearTimeout(timer);
  }, [isActivating, broadcast?.status]);

  // ---- Load console-local autoplay from localStorage -------------------
  // Storage key includes the broadcast id so different moderators (or
  // different broadcasts) can have independent preferences. Default is
  // off — the moderator's instinct should be "mute by default" when the
  // matchroom is the intended audio surface.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const raw = window.localStorage.getItem(STORAGE_KEYS.consoleAutoplay(broadcastId));
    if (raw === "1") setConsoleAutoplay(true);
  }, [broadcastId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(
      STORAGE_KEYS.consoleAutoplay(broadcastId),
      consoleAutoplay ? "1" : "0",
    );
  }, [broadcastId, consoleAutoplay]);

  // ---- Tick for generation-pause countdown -----------------------------
  useEffect(() => {
    if (!generationPause || generationPause.retryAt == null) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [generationPause]);

  // ---- Bootstrapping fetches: voices, radio sources, broadcast --------
  useEffect(() => {
    apiGet<{ voices?: TtsVoice[] }>(routes.ttsVoices.list())
      .then((data) => {
        if (data?.voices) setVoices(data.voices);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    apiGet<RadioSource[]>(routes.radioSources.list())
      .then((data) => {
        if (Array.isArray(data)) setAvailableSources(data);
      })
      .catch(() => {});
  }, []);

  // Resolve stream URL from the broadcast's stored radioSourceId when the
  // catalogue arrives. This is the single authority on what "current
  // source" means — no fallback to availableSources[0], because that
  // races with this effect and clobbers the broadcast's real selection.
  // If the broadcast has no saved source, streamUrl stays "" and the
  // dropdown renders the "(no source selected)" option until the user
  // picks one.
  useEffect(() => {
    if (!broadcast?.radioSourceId || availableSources.length === 0) return;
    const source = availableSources.find((s) => s.id === broadcast.radioSourceId);
    if (source) setStreamUrl(source.streamUrl);
  }, [broadcast?.radioSourceId, availableSources]);

  // ---- Bootstrap ---------------------------------------------------------
  // Single fetch of the moderator-shaped view restores the console's
  // working state on mount: broadcast row + brief inputs + every feed
  // entry the moderator's UI renders + every narrative generated so
  // far. WS opens after `setReady(true)` and streams new entries from
  // there; merge-by-id dedupes against bootstrap-loaded ones.
  //
  // Hoisted so the WS effect can call it on reconnect to backfill any
  // entries / narratives emitted while the socket was down.
  const fetchBootstrap = useCallback(async () => {
    try {
      const view = await apiGet<ModeratorView | null>(
        routes.broadcasts.moderatorView(broadcastId),
      );
      if (!view) return;
      setBroadcast(view);
      if (view.ttsVoiceId) setSelectedVoiceId(view.ttsVoiceId);

      // Hydrate feed + narratives. Merge with whatever's already
      // landed via WS (StrictMode / fast WS open) so a slow
      // bootstrap doesn't wipe live-received state.
      if (view.allFeedEntries.length > 0) {
        setFeedEntries((prev) => {
          const byId = new Map<string, ModeratorFeedEntry>();
          for (const e of view.allFeedEntries) byId.set(e.id, e as ModeratorFeedEntry);
          for (const e of prev) byId.set(e.id, e);
          return Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp);
        });
      }
      if (view.allNarratives.length > 0) {
        setNarratives((prev) => {
          const byId = new Map<string, NarrativeRecord>();
          for (const n of view.allNarratives) {
            byId.set(n.id, {
              id: n.id,
              text: n.text,
              generatedAt: n.generatedAt as unknown as number,
              covers: n.covers,
            });
          }
          for (const n of prev) byId.set(n.id, n);
          return Array.from(byId.values()).sort(
            (a, b) =>
              Date.parse(String(a.generatedAt)) -
              Date.parse(String(b.generatedAt)),
          );
        });
      }
    } catch {
      // Silent — WS is the live source of truth; reconnect retries.
    }
  }, [broadcastId]);

  useEffect(() => {
    void fetchBootstrap().finally(() => setReady(true));
  }, [fetchBootstrap]);

  // Resolve voice name when voices load or selection changes.
  useEffect(() => {
    const match = voices.find((v) => v.id === selectedVoiceId);
    if (match) {
      setSelectedVoiceName(match.name);
      setSelectedProvider(match.provider);
    }
  }, [voices, selectedVoiceId]);

  // ---- WebSocket --------------------------------------------------------
  // Connection lifecycle is delegated to useReconnectingWebSocket
  // (lib/ws.ts): pass `null` while bootstrap is still running and the
  // hook stays closed; pass a URL once `ready` flips and the hook
  // opens (with backoff reconnect on close). The page populates its
  // own wsRef from the hook's onOpen so `useAudioCapture` (which ships
  // PCM chunks via wsRef.current.send) keeps working without API
  // changes.
  const wsUrl = ready
    ? `${WS_URL}/ws/moderator?broadcastId=${encodeURIComponent(broadcastId)}`
    : null;
  const isReconnectRef = useRef(false);
  const { status: wsStatus } = useReconnectingWebSocket(wsUrl, {
    onOpen: (ws) => {
      wsRef.current = ws;
      if (isReconnectRef.current) {
        void fetchBootstrap();
        // The AudioWorklet keeps producing PCM through the WS gap;
        // chunks during the disconnect window were dropped on the
        // wsRef.current.readyState check inside useAudioCapture.
        // Post-reconnect chunks land cleanly on the new socket. No
        // restart needed — PCM has no init segment to lose.
        if (captureActive) {
          console.log("[moderator] WS reconnected; PCM capture resumes on next worklet tick");
        }
      }
      isReconnectRef.current = true;
    },
    onError: (e) => console.error("[moderator] WebSocket error:", e),
    onMessage: (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "connected" && msg.broadcast) {
          setBroadcast(msg.broadcast);
          // Late joiner / reconnect — if something is mid-playback and
          // console autoplay is on, snap to the live offset.
          if (msg.currentPlay && typeof msg.serverNow === "number") {
            const cp = msg.currentPlay as ModeratorPlayCue;
            const cue: ModeratorPlayCue = { ...cp, serverNow: msg.serverNow };
            const clientStartTime = Date.now() - (cue.serverNow - cue.playbackStartedAt);
            if (consoleAutoplayRef.current) {
              startPlayback(cue, clientStartTime);
            } else {
              pendingPlayRef.current = { cue, clientStartTime };
            }
          }
          return;
        }
        if (msg.type === "broadcast_status" && msg.broadcast) {
          setBroadcast(msg.broadcast);
          setBroadcastError(null);
          return;
        }
        if (msg.type === "error" && typeof msg.message === "string") {
          setBroadcastError(msg.message);
          return;
        }
        if (msg.type === "feed_entry") {
          const incoming = msg.entry as ModeratorFeedEntry;
          // Dedupe by id — StrictMode + HMR can briefly keep two
          // subscriptions alive and deliver the same entry twice.
          setFeedEntries((prev) =>
            prev.some((e) => e.id === incoming.id) ? prev : [...prev, incoming],
          );
          return;
        }
        if (msg.type === "service_status") {
          setServices(msg.services);
          return;
        }
        if (msg.type === "narrative") {
          const n = msg.narrative;
          setNarratives((prev) =>
            prev.some((p) => p.id === n.id)
              ? prev
              : [
                  ...prev,
                  {
                    id: n.id,
                    text: n.text,
                    generatedAt: n.generatedAt,
                    covers: Array.isArray(n.covers) ? n.covers : undefined,
                  },
                ],
          );
          setGenerationPause(null);
          return;
        }

        if (msg.type === "preload" && typeof msg.audioUrl === "string") {
          // Warm the browser cache for an upcoming clip. A hidden Audio
          // with preload="auto" kicks the download; when the matching
          // `play` arrives, the real element's src-set hits cache.
          const a = new Audio();
          a.preload = "auto";
          a.src = msg.audioUrl;
          try { a.load(); } catch { /* ignore */ }
          preloadedAudiosRef.current.set(msg.narrationId, a);
          return;
        }

        if (msg.type === "play" && typeof msg.audioUrl === "string") {
          const cue = msg as ModeratorPlayCue;
          const clientStartTime = Date.now() - (cue.serverNow - cue.playbackStartedAt);
          if (consoleAutoplayRef.current) {
            startPlayback(cue, clientStartTime);
          } else {
            pendingPlayRef.current = { cue, clientStartTime };
          }
          return;
        }
        if (msg.type === "latency_sample") {
          setLatencySamples((prev) => {
            const next: LatencySample = {
              goalContentTime: String(msg.goalContentTime ?? ""),
              transcriptionContentTime: String(msg.transcriptionContentTime ?? ""),
              rawDeltaSeconds: Number(msg.rawDeltaSeconds) || 0,
              configuredOffsetSeconds: Number(msg.configuredOffsetSeconds) || 0,
              sourceName: typeof msg.sourceName === "string" ? msg.sourceName : null,
              receivedAt: Date.now(),
            };
            return [...prev, next].slice(-10);
          });
          return;
        }
        if (msg.type === "generation_skipped") {
          const retryAfterMs =
            typeof msg.retryAfterMs === "number" ? msg.retryAfterMs : null;
          setGenerationPause({
            reason: typeof msg.reason === "string" ? msg.reason : "unknown",
            retryAt: retryAfterMs != null ? Date.now() + retryAfterMs : null,
            triggerReason:
              typeof msg.triggerReason === "string" ? msg.triggerReason : undefined,
          });
          return;
        }
        if (msg.type === "narrative_status") {
          setNarrativeEngineStatus(msg.status);
          nextGenerateAtRef.current = msg.nextGenerateAt ?? null;
          return;
        }
      } catch {
        // ignore malformed message
      }
    },
  });

  // Sync isConnected with the hook's status (kept as state because
  // multiple JSX consumers branch on it).
  useEffect(() => {
    setIsConnected(wsStatus === "open");
  }, [wsStatus]);

  // Drain preloaded audio cache when the WS lifecycle ends (hook URL
  // flips back to null on unmount; this effect mirrors that boundary).
  useEffect(() => {
    if (!ready) return;
    return () => {
      for (const a of preloadedAudiosRef.current.values()) {
        a.src = "";
        try { a.load(); } catch { /* ignore */ }
      }
      preloadedAudiosRef.current.clear();
    };
  }, [ready]);

  // ---- Narrative countdown ticker --------------------------------------
  useEffect(() => {
    const id = setInterval(() => {
      const target = nextGenerateAtRef.current;
      if (target) {
        const remaining = Math.max(0, Math.ceil((target - Date.now()) / 1000));
        setNarrativeCountdown(remaining);
      } else {
        setNarrativeCountdown(null);
      }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // ---- Auto-scroll feed + narratives -----------------------------------
  useEffect(() => {
    if (feedScrollRef.current) {
      feedScrollRef.current.scrollTop = feedScrollRef.current.scrollHeight;
    }
  }, [feedEntries]);
  useEffect(() => {
    if (narrativeScrollRef.current) {
      narrativeScrollRef.current.scrollTop = narrativeScrollRef.current.scrollHeight;
    }
  }, [narratives]);

  // ---- Live narration playback (conductor-driven) ---------------------
  // When the moderator flips console autoplay off, pause live playback
  // immediately. Any in-flight `play` cue is stashed so toggling back
  // on can snap to the live offset. Matchroom + pipeline are unaffected.
  useEffect(() => {
    if (consoleAutoplay) return;
    const audio = narrativeAudioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    isPlayingRef.current = false;
    setPlayingNarrativeId(null);
  }, [consoleAutoplay]);

  // Single entry point for starting a live clip — invoked from `play`
  // cues in real time and from `connected.currentPlay` on reconnect.
  // `clientStartTime` anchors the server's clock in the client's frame;
  // live offset = Date.now() - clientStartTime.
  const startPlayback = useCallback((cue: ModeratorPlayCue, clientStartTime: number) => {
    const audio = narrativeAudioRef.current;
    if (!audio) return;

    // Consume any preloaded shadow element for this cue — browser HTTP
    // cache should be warm by now; the real element re-requests and hits.
    const preloaded = preloadedAudiosRef.current.get(cue.narrationId);
    if (preloaded) {
      preloadedAudiosRef.current.delete(cue.narrationId);
      preloaded.src = "";
      try { preloaded.load(); } catch { /* ignore */ }
    }

    const offsetMs = Math.max(0, Date.now() - clientStartTime);
    if (offsetMs >= cue.durationMs) return; // already ended

    audio.src = cue.audioUrl;
    audio.onloadedmetadata = () => {
      audio.currentTime = offsetMs / 1000;
    };
    audio.onended = () => {
      isPlayingRef.current = false;
      setPlayingNarrativeId(null);
      // No pacing report here — the server owns the playback clock and
      // reports to Kairos itself on clip-end.
    };

    isPlayingRef.current = true;
    setPlayingNarrativeId(cue.narrativeId);
    audio.play().catch(() => {
      // Autoplay blocked (unlikely here since consoleAutoplay gates us,
      // but guard anyway). Stash so the toggle-on effect can retry.
      pendingPlayRef.current = { cue, clientStartTime };
      isPlayingRef.current = false;
      setPlayingNarrativeId(null);
    });
  }, []);

  // When the moderator flips consoleAutoplay ON, snap to the live clip
  // at its current offset if one is pending.
  useEffect(() => {
    if (!consoleAutoplay) return;
    const pending = pendingPlayRef.current;
    pendingPlayRef.current = null;
    if (pending) startPlayback(pending.cue, pending.clientStartTime);
  }, [consoleAutoplay, startPlayback]);

  const playNarrative = useCallback(
    (id: string, text: string) => {
      // Manual replay of a past narrative. Bypasses the conductor's live
      // queue — fetches fresh bytes via /tts and plays into the same
      // audio element. Interrupts any live playback (moderator is
      // explicitly requesting this one); a subsequent live `play` cue
      // will swap back to live via startPlayback.
      if (!ttsEnabledRef.current) {
        setBroadcastError("TTS is disabled for this broadcast — enable it in the narrator voice panel.");
        return;
      }
      const audio = narrativeAudioRef.current;
      if (!audio) return;
      audio.pause();
      audio.src = "";
      isPlayingRef.current = true;
      setPlayingNarrativeId(id);

      // /tts returns audio bytes (not JSON), so it stays on apiFetch.
      // The typed verbs are JSON-only by design.
      apiFetch(routes.tts.speak(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          voiceId: selectedVoiceRef.current,
          provider: selectedProviderRef.current,
          broadcastId,
        }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error("tts failed");
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          audio.src = url;
          audio.onended = () => {
            URL.revokeObjectURL(url);
            isPlayingRef.current = false;
            setPlayingNarrativeId(null);
          };
          await audio.play();
        })
        .catch(() => {
          isPlayingRef.current = false;
          setPlayingNarrativeId(null);
        });
    },
    [broadcastId],
  );

  // ---- Voice selection --------------------------------------------------
  const selectVoice = useCallback(
    (id: string, name: string, provider: BroadcastTtsProvider) => {
      setSelectedVoiceId(id);
      setSelectedVoiceName(name);
      setSelectedProvider(provider);
      setVoicePickerOpen(false);
      apiPatch<{ ttsVoiceId: string }, Broadcast>(routes.broadcasts.item(broadcastId), {
        ttsVoiceId: id,
      }).then(setBroadcast).catch(() => {});
    },
    [broadcastId],
  );

  // Open picker — ensure the currently-selected voice's provider group is
  // expanded so the moderator lands on their pick, not an empty list.
  const openVoicePicker = useCallback(() => {
    setVoicePickerOpen(true);
    setExpandedProviders((prev) => {
      if (prev.has(selectedProvider)) return prev;
      const next = new Set(prev);
      next.add(selectedProvider);
      return next;
    });
  }, [selectedProvider]);

  const toggleProviderExpanded = useCallback((provider: BroadcastTtsProvider) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  }, []);

  // ---- Voice preview (server-side TTS of a sample sentence) ------------
  // Previews also hit /tts and cost money, so they're subject to the
  // same kill switch. Voice shopping while TTS is off means turning it
  // on briefly, picking, turning it off — deliberate by design.
  const previewVoice = useCallback(
    async (voiceId: string, provider: BroadcastTtsProvider) => {
      if (!ttsEnabledRef.current) {
        setBroadcastError("TTS is disabled — enable it to preview voices.");
        return;
      }
      const audio = previewAudioRef.current;
      if (audio) {
        audio.pause();
        audio.src = "";
      }
      setPreviewLoadingId(voiceId);
      setPreviewPlayingId(null);
      try {
        // /tts returns audio bytes (not JSON), so it stays on apiFetch.
        const res = await apiFetch(routes.tts.speak(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: "The ball crossed the line with the inevitability of a sentence that had been forming since the first whistle. The crowd rose as one.",
            voiceId,
            provider,
            broadcastId,
          }),
        });
        if (!res.ok) {
          setPreviewLoadingId(null);
          return;
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (audio) {
          audio.src = url;
          setPreviewLoadingId(null);
          setPreviewPlayingId(voiceId);
          audio.onended = () => {
            URL.revokeObjectURL(url);
            setPreviewPlayingId(null);
          };
          audio.play().catch(() => {
            setPreviewLoadingId(null);
            setPreviewPlayingId(null);
          });
        }
      } catch {
        setPreviewLoadingId(null);
        setPreviewPlayingId(null);
      }
    },
    [broadcastId],
  );

  // ---- TTS kill switch --------------------------------------------------
  // Pipeline-wide. When off, every surface gates out: matchroom tune-in
  // is hidden, moderator auto-play is blocked, previews are blocked,
  // `/tts` server returns 503. Persists on the broadcast row so the
  // setting carries across moderator sessions and applies to matchroom
  // viewers who never see the console.
  const setTtsEnabled = useCallback(
    async (next: boolean) => {
      if (!broadcast) return;
      // Optimistic — the toggle should feel instant. If the PATCH fails
      // we revert and surface the error.
      setBroadcast({ ...broadcast, ttsEnabled: next });
      try {
        const updated = await apiPatch<{ ttsEnabled: boolean }, Broadcast>(
          routes.broadcasts.item(broadcastId),
          { ttsEnabled: next },
        );
        setBroadcast(updated);
      } catch (err) {
        setBroadcastError(
          (err as Error).message || "TTS toggle failed",
        );
        setBroadcast(broadcast);
      }
    },
    [broadcast, broadcastId],
  );

  // ---- WS control helpers ----------------------------------------------
  const sendWs = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const sendModeratorNote = useCallback(() => {
    const text = moderatorInput.trim();
    if (!text) return;
    sendWs({ type: "moderator_message", text });
    setModeratorInput("");
  }, [moderatorInput, sendWs]);

  // When the moderator changes the source dropdown, persist the choice
  // immediately so a page reload resumes with the same source. The old
  // code only persisted on transcription-started, which meant merely
  // reselecting didn't stick — combined with the (now removed) fallback
  // effect, that caused reloads to revert to the catalogue's first entry.
  const onSelectSource = useCallback(
    (url: string) => {
      setStreamUrl(url);
      const source = availableSources.find((s) => s.streamUrl === url);
      if (!source) return;
      apiPatch<{ radioSourceId: string }, Broadcast>(routes.broadcasts.item(broadcastId), {
        radioSourceId: source.id,
      }).then(setBroadcast).catch(() => {});
    },
    [availableSources, broadcastId],
  );

  // ---- Status transitions ----------------------------------------------
  // draft → scheduled: server-side prereqs (briefs non-empty, fixture +
  // radio source set). Schedule button is disabled with an explanatory
  // tooltip when any blocker is present.
  const scheduleBlockers = useMemo(
    () => (broadcast ? collectScheduleBlockers(broadcast) : ["Loading broadcast"]),
    [broadcast],
  );

  const goLiveBlockers = useMemo(() => {
    if (!broadcast) return ["Loading broadcast"];
    const blockers: string[] = [];
    if (!broadcast.radioSourceId) blockers.push("radio source not set");
    if (broadcast.ttsEnabled === true && !broadcast.ttsVoiceId) blockers.push("TTS is enabled but no voice is selected");
    return blockers;
  }, [broadcast]);

  const schedule = useCallback(async () => {
    if (!broadcast) return;
    let updated: Broadcast;
    try {
      updated = await apiPatch<{ status: BroadcastStatus }, Broadcast>(
        routes.broadcasts.item(broadcast.id),
        { status: "scheduled" },
      );
    } catch (err) {
      setBroadcastError((err as Error).message || "Scheduling failed");
      return;
    }
    setBroadcast(updated);
  }, [broadcast]);

  const goLive = useCallback(() => {
    if (!broadcast) return;
    // Activation hands off to the BroadcastRunner server-side
    // (Sportmonks polling, Deepgram pipe, pressure derivation,
    // distillation). Audio capture itself is now client-side — the
    // moderator's UK browser is the only network seat with reliable
    // UK origin for radio sources, so we arm Web Audio +
    // MediaRecorder here, inside the user-gesture click, before
    // browser autoplay policy expires it. Pre-activation chunks are
    // dropped server-side until the runner is registered (~13s of
    // brief-init); that's fine, no useful audio in that window.
    setIsActivating(true);
    sendWs({ type: "activate_broadcast" });
    armCapture();
  }, [broadcast, sendWs, armCapture]);

  const endBroadcast = useCallback(() => {
    if (!broadcast) return;
    if (!window.confirm("End this broadcast? This cannot be undone.")) return;
    sendWs({ type: "complete_broadcast" });
    disarmCapture();
  }, [broadcast, sendWs, disarmCapture]);

  // Covered-entry lookup for the feed's ✓ indicator.
  const coveredEntryIds = useMemo(() => {
    const set = new Set<string>();
    for (const n of narratives) {
      for (const c of n.covers ?? []) set.add(c.entryId);
    }
    return set;
  }, [narratives]);

  // ---- Render -----------------------------------------------------------
  if (!ready) {
    return <main style={{ minHeight: "100vh", background: C.ivory }} />;
  }

  const status: BroadcastStatus = broadcast?.status ?? "draft";
  const isLive = status === "live";
  const isComplete = status === "complete";

  return (
    <main
      style={{
        maxWidth: 1440,
        margin: "0 auto",
        padding: "32px 32px 0",
        color: C.umber,
        background: C.ivory,
        // Pin main to the viewport so the grid row below can stretch
        // to fill whatever space remains after the topbar / status /
        // banners. Without this the grid sits at a fixed min-height and
        // the combined-feed + narratives panels get stuck at that
        // height regardless of how tall the viewport actually is.
        height: "100vh",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      <Topbar
        broadcast={broadcast}
        status={status}
        scheduleBlockers={scheduleBlockers}
        goLiveBlockers={goLiveBlockers}
        connected={isConnected}
        isActivating={isActivating}
        isAdmin={isAdmin}
        captureActive={captureActive}
        onSchedule={schedule}
        onGoLive={goLive}
        onEnd={endBroadcast}
        onResumeCapture={armCapture}
      />

      {broadcastError ? (
        <div
          style={{
            marginTop: 12,
            padding: "10px 14px",
            border: `0.5px solid ${C.crimson}40`,
            background: `${C.crimson}14`,
            color: C.crimson,
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          {broadcastError}
        </div>
      ) : null}

      {captureActive ? (
        <div
          style={{
            marginTop: 12,
            padding: "8px 14px",
            border: `0.5px solid ${C.forest}40`,
            background: `${C.forest}14`,
            color: C.forest,
            borderRadius: 10,
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{
            width: 8, height: 8, borderRadius: 4,
            background: C.forest,
          }} />
          Audio capture active — keep this tab open and your machine awake.
          Closing the tab or sleeping will silence the broadcast.
        </div>
      ) : null}

      <StatusBar services={services} status={status} connected={isConnected} />

      {generationPause ? (
        <GenerationPauseBanner pause={generationPause} now={nowTick} />
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "360px 1fr 360px",
          gap: 20,
          // Grid fills the remaining viewport space (main is height:
          // 100vh + flex column). `minHeight: 0` lets each column's
          // scroll containers size themselves — without it the grid
          // would expand to fit content and defeat the flex cap.
          alignItems: "stretch",
          marginTop: 20,
          marginBottom: 20,
          flex: 1,
          minHeight: 0,
        }}
      >
        {/* Left column — inputs + output config. Studio link, radio
            source, then narrator voice at the bottom. Freeing the right
            column means the narratives feed has the same breathing
            room the combined feed gets in the centre. */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <LeftColumn
            availableSources={availableSources}
            streamUrl={streamUrl}
            onStreamUrlChange={onSelectSource}
            isListeningLocally={isListeningLocally}
            onStartListening={startListening}
            onStopListening={stopListening}
            latencySamples={latencySamples}
          />
          <NarratorVoicePanel
            voices={voices}
            selectedVoiceId={selectedVoiceId}
            selectedVoiceName={selectedVoiceName}
            selectedProvider={selectedProvider}
            onSelectVoice={selectVoice}
            voicePickerOpen={voicePickerOpen}
            onOpenVoicePicker={openVoicePicker}
            onCloseVoicePicker={() => setVoicePickerOpen(false)}
            expandedProviders={expandedProviders}
            onToggleProviderExpanded={toggleProviderExpanded}
            previewLoadingId={previewLoadingId}
            previewPlayingId={previewPlayingId}
            onPreviewVoice={previewVoice}
            ttsEnabled={broadcast?.ttsEnabled === true}
            onTtsEnabledChange={setTtsEnabled}
            consoleAutoplay={consoleAutoplay}
            onConsoleAutoplayChange={setConsoleAutoplay}
          />
        </div>

        <CombinedFeedPanel
          feedEntries={feedEntries}
          coveredEntryIds={coveredEntryIds}
          scrollRef={feedScrollRef}
          moderatorInput={moderatorInput}
          onModeratorInputChange={setModeratorInput}
          onSendModeratorNote={sendModeratorNote}
          disabled={isComplete}
        />

        <NarrativesPanel
          narratives={narratives}
          playingNarrativeId={playingNarrativeId}
          engineStatus={narrativeEngineStatus}
          countdown={narrativeCountdown}
          onPlay={playNarrative}
          scrollRef={narrativeScrollRef}
          isLive={isLive}
        />
      </div>

      {/* Hidden audio elements, one per concern. The radio element
          carries crossOrigin so post-goLive Web Audio can tap it for
          capture; without the attribute set before src is assigned,
          createMediaElementSource refuses to attach. */}
      <audio ref={audioRef} crossOrigin="anonymous" style={{ display: "none" }} />
      <audio ref={narrativeAudioRef} style={{ display: "none" }} />
      <audio ref={previewAudioRef} style={{ display: "none" }} />

      {/* Idle-hidden scrollbars for the long feeds. Thumb is invisible
          by default and fades in while the pointer is over the panel or
          while a scroll is active. Firefox uses `scrollbar-color` (thin
          track) and WebKit uses the ::-webkit-scrollbar pseudos. */}
      <style>{`
        .idle-hidden-scroll { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .idle-hidden-scroll:hover, .idle-hidden-scroll:focus-within { scrollbar-color: ${C.driftwood}66 transparent; }
        .idle-hidden-scroll::-webkit-scrollbar { width: 8px; }
        .idle-hidden-scroll::-webkit-scrollbar-track { background: transparent; }
        .idle-hidden-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; transition: background 180ms ease; }
        .idle-hidden-scroll:hover::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:focus-within::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:active::-webkit-scrollbar-thumb { background: ${C.driftwood}66; }
      `}</style>

      <AdminFooter left="Moderator" />
    </main>
  );
}
