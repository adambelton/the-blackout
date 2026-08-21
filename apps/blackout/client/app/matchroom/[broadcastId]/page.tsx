"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { brand as C } from "../../lib/palette";
import { AdminFooter } from "../../components/AdminFooter";
import { apiGet, API_URL } from "@/lib/api";
import { useReconnectingWebSocket } from "@/lib/ws";
import { routes } from "@/lib/routes";
import { applyRevealingCanonical, compareEventsByMatchTime, emptyCanonicalState, isLivePhase, parseMatchTime } from "@blackout/shared";
import type { CanonicalEvent, CanonicalState, Passage } from "@blackout/shared";
import {
  computeCoverRevealSchedule,
  computeContentMinuteLabel,
  deriveScore,
  type Phase,
  type ViewerEvent,
} from "./derivations";
import type { BroadcastMeta, Narrative, PlayCue } from "./components/types";
import { loadReplayProgress, saveReplayProgress } from "./components/utils";
import { ConnectionPill } from "./components/ConnectionPill";
import { EventRibbon } from "./components/EventRibbon";
import { Fixture } from "./components/Fixture";
import { Header } from "./components/Header";
import { Illustration } from "./components/Illustration";
import { Marginalia } from "./components/Marginalia";
import { Narration } from "./components/Narration";
import { NowPlaying } from "./components/NowPlaying";
import { PhasePlaceholder } from "./components/PhasePlaceholder";

const WS_URL = API_URL.replace(/^http/, "ws");

export default function MatchroomPage({
  params,
}: {
  params: Promise<{ broadcastId: string }>;
}) {
  const { broadcastId } = use(params);

  const [broadcast, setBroadcast] = useState<BroadcastMeta | null>(null);
  // Revealed events only — feed_entry cues arrive here via the staging
  // map below, promoted to this array at audio-end of the narration
  // whose batchEntryIds cite them.
  const [events, setEvents] = useState<ViewerEvent[]>([]);
  const [narratives, setNarratives] = useState<Narrative[]>([]);
  // Narratives whose `play` cue has fired — i.e. their audio has
  // started (or is being skipped because consoleAutoplay was off).
  // Text UI filters against this set so nothing reads ahead of the
  // narrator's voice.
  const [visibleNarrativeIds, setVisibleNarrativeIds] = useState<Set<string>>(() => new Set());
  // Broadcast phase — drives quiet-window placeholder copy (pre-ramp,
  // halftime, full-time winddown). Transitions arrive via the
  // server's `phase` cues; initial value from `connected.phase`.
  const [phase, setPhase] = useState<Phase>("pre_ramp");
  // `connection` is derived below from the WS hook's status + the
  // broadcast's lifecycle phase. No setter needed.
  const [nowPlayingId, setNowPlayingId] = useState<string | null>(null);
  const [audioProgress, setAudioProgress] = useState(0); // 0..1
  const [audioDuration, setAudioDuration] = useState<number | null>(null);

  // Staged events — received via `feed_entry` cues but not yet
  // revealed. Held in a ref so the revealer can batch-move entries
  // into `events` state without triggering intermediate renders.
  const stagedEventsRef = useRef<Map<string, ViewerEvent>>(new Map());
  // ttsEnabled snapshot as a ref so the narrative-cue handler's closure
  // sees the current value. When false, reveal is immediate (no audio
  // gate exists); when true, reveal waits on audio-end.
  const ttsEnabledRef = useRef<boolean>(false);
  useEffect(() => {
    ttsEnabledRef.current = broadcast?.ttsEnabled === true;
  }, [broadcast?.ttsEnabled]);
  // The radio starts off. The user tunes in by clicking the now-playing
  // strip, which unblocks the audio pipeline and satisfies the browser's
  // user-gesture requirement for autoplay. Framed as an on-brand entry
  // gesture rather than a "click to enable audio" consent pattern.
  const [radioOn, setRadioOn] = useState(false);

  // Match clock — driven by the current passage's contentMinute (bundle
  // path) or `contentTime` (legacy `play` cue). Set when audio
  // begins; the narrator is speaking from this minute onward. Null
  // means pre-match or no numeric contentTime in the current cycle's
  // batch. Stored as a string so stoppage forms ("45+2") survive
  // end-to-end rather than being floored to "45". `parseMatchTime`
  // is the comparator used elsewhere; phase-label sentinels
  // ("pre_match" → -1) are filtered at every setter site so the clock
  // doesn't render "-1'". See docs/kairos-architecture.md.
  const [currentContentMinute, setCurrentBatchMinute] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Preloaded <audio> elements keyed by narrationId. Populated when a
  // `preload` cue arrives so the browser downloads the bytes ahead of
  // time. Drained into `audioRef` on `play`. Cleared on end-of-clip.
  const preloadedAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Holds a `play` cue that arrived while the radio was off, paired
  // with the client-clock estimate of when playback started. When the
  // user tunes in, we seek to the live offset computed from that anchor.
  const pendingPlayRef = useRef<{ cue: PlayCue; clientStartTime: number } | null>(null);
  const radioOnRef = useRef(false);
  // requestAnimationFrame handle for typewriter reveal. `timeupdate` on
  // HTMLAudioElement fires at ~250ms — visibly chunky for character-
  // by-character reveal. RAF runs at the display refresh rate, reading
  // `audio.currentTime` directly each frame for smooth progression.
  const progressRafRef = useRef<number | null>(null);
  // Scheduled per-entry reveal timers for the currently-playing clip.
  // Cleared on clip end / skip so nothing fires after audio has moved
  // on. Populated from the narrative's covers when a `play` cue
  // starts — each covered entry with a `charOffset` gets an
  // independent setTimeout scheduled at `(charOffset/length) * duration`.
  const coverRevealTimersRef = useRef<number[]>([]);
  // Per-narrative cover metadata captured from `narrative` cues.
  // Keyed by narrativeId. The `play` cue doesn't re-carry covers, so
  // we stash them here on narrative arrival and read them out when
  // playback starts. Entries cleared on replay reset.
  const narrativeCoversRef = useRef<
    Map<string, Array<{ entryId: string; charOffset?: number }>>
  >(new Map());
  // Per-narrativeId bundle stash for the bundle-driven cue contract
  // (Sub-piece 4c). passage_added stores; passage_audio_ready /
  // passage_started / passage_updated patch in place; passage_skipped
  // deletes. Reads at passage_started time to drive the playback +
  // marker schedule.
  const passageBundlesRef = useRef<Map<string, Passage>>(new Map());
  // nowPlayingId mirror so the WS handler closure (captured at hook
  // mount) can read the latest value without going stale.
  const nowPlayingIdRef = useRef<string | null>(null);
  useEffect(() => { radioOnRef.current = radioOn; }, [radioOn]);
  useEffect(() => { nowPlayingIdRef.current = nowPlayingId; }, [nowPlayingId]);

  // ---- Replay mode (status === "complete").
  // The conductor isn't running for a complete broadcast, so there's
  // no live cue stream. Instead we read `view.revealedPassages`
  // (sequence of canonical bundles, server-authored) and walk them
  // through the same `receivePassageBundle` + `startPassagePlayback`
  // helpers the live path uses. The only difference is playback
  // timing — replay synthesises `playback.startedAt = Date.now()`
  // for each passage so audio plays from offset 0.
  const replayPassagesRef = useRef<Passage[]>([]);
  const replayIndexRef = useRef(0);

  // Illustration state. Images arrive on `illustration` cues, decoupled
  // from their narratives' `play` cues — generation and synthesis race,
  // finishing in their own time. Gating: image displays when its
  // narrative's audio starts. Map holds images waiting for their
  // passage; `displayedIllustrationUrl` is what's actually on screen.
  const [displayedIllustrationUrl, setDisplayedIllustrationUrl] = useState<string | null>(null);
  const pendingIllustrationsRef = useRef<Map<string, string>>(new Map());

  // Promote staged events to the displayed set. Called at audio-end
  // for a `play` cue — reveals any staged events the narrator had
  // context on (whether or not the prose explicitly cited them). The
  // "audio is canonical" contract: nothing shown before spoken.
  const revealEvents = useCallback((entryIds: string[]) => {
    if (!entryIds || entryIds.length === 0) return;
    const staged = stagedEventsRef.current;
    const toReveal: ViewerEvent[] = [];
    for (const id of entryIds) {
      const event = staged.get(id);
      if (event) {
        toReveal.push(event);
        staged.delete(id);
      }
    }
    if (toReveal.length === 0) return;
    setEvents((prev) => {
      const byId = new Map(prev.map((e) => [e.id, e]));
      for (const e of toReveal) byId.set(e.id, e);
      return Array.from(byId.values()).sort(compareEventsByMatchTime);
    });
  }, []);

  // Cancel any scheduled per-cover reveal timers. Called on clip end
  // (so an anchor that didn't fire in time still reveals at end via
  // the audio-end batch path) and on replay restart.
  const clearCoverRevealTimers = useCallback(() => {
    for (const t of coverRevealTimersRef.current) clearTimeout(t);
    coverRevealTimersRef.current = [];
  }, []);

  // Schedule per-entry reveals for a clip whose audio is about to
  // play. Pure scheduling math lives in `computeCoverRevealSchedule`;
  // this thin wrapper wires `setTimeout` and tracks timers for
  // cleanup. Returns the set of entry ids it scheduled so the caller
  // can exclude them from the audio-end batch (avoids double-reveal).
  const schedulePerCoverReveals = useCallback(
    (
      covers: Array<{ entryId: string; charOffset?: number }>,
      text: string,
      durationMs: number,
    ): Set<string> => {
      clearCoverRevealTimers();
      const schedule = computeCoverRevealSchedule(covers, text, durationMs);
      const scheduled = new Set<string>();
      for (const { entryId, delayMs } of schedule) {
        scheduled.add(entryId);
        const timer = window.setTimeout(() => {
          revealEvents([entryId]);
        }, delayMs);
        coverRevealTimersRef.current.push(timer);
      }
      return scheduled;
    },
    [clearCoverRevealTimers, revealEvents],
  );

  // ---- Playback driver.
  // Single entry point for starting a clip — invoked from `play` cues
  // (real-time), `connected.currentPlay` (late-join snapshot), and the
  // tune-in gesture (when a `play` cue arrived while radio was off).
  // `clientStartTime` is the client-clock estimate of when playback
  // actually began on the server — offset from "now" gives the live
  // position, which is what every listener must hear in sync.
  const startPlayback = useCallback((
    cue: PlayCue,
    clientStartTime: number,
    onClipEnd?: () => void,
  ) => {
    const audio = audioRef.current;
    if (!audio) return;

    // Drop the preloaded shadow element for this cue — browser's HTTP
    // cache should have its bytes warm by now; the main element just
    // re-fetches the same URL and gets a cache hit (or a quick retry).
    const preloaded = preloadedAudiosRef.current.get(cue.narrationId);
    if (preloaded) {
      preloadedAudiosRef.current.delete(cue.narrationId);
      preloaded.src = "";
      try { preloaded.load(); } catch { /* ignore */ }
    }

    const offsetMs = Math.max(0, Date.now() - clientStartTime);
    const covers = narrativeCoversRef.current.get(cue.narrativeId) ?? [];
    const coverEntryIds = covers.map((c) => c.entryId);
    if (offsetMs >= cue.durationMs) {
      // Clip already ended from the server's POV — reveal the
      // covered entries (the canonical reveal contract: only what
      // the narrator explicitly cited gets gated/revealed by the
      // narration). Per-cover timing can't help here; we're past
      // the audio window.
      revealEvents(coverEntryIds);
      setVisibleNarrativeIds((prev) => {
        if (prev.has(cue.narrativeId)) return prev;
        const next = new Set(prev);
        next.add(cue.narrativeId);
        return next;
      });
      onClipEnd?.();
      return;
    }

    // Schedule per-entry early reveals for anchored covers. Each
    // anchor fires at its own `(charOffset/length) * duration` — so
    // an event mentioned early in the prose appears early, not at
    // audio-end. Returns the ids we scheduled so we can subtract
    // them from the audio-end batch (no double reveal). Unanchored
    // covers still reveal at audio-end.
    const scheduledIds = schedulePerCoverReveals(
      covers,
      cue.text,
      cue.durationMs,
    );

    audio.src = cue.audioUrl;
    audio.onloadedmetadata = () => {
      setAudioDuration(Number.isFinite(audio.duration) ? audio.duration : null);
      // Seek only once metadata is loaded — setting currentTime before
      // loadedmetadata is a silent no-op in most browsers.
      audio.currentTime = offsetMs / 1000;
    };
    // RAF-driven progress instead of `ontimeupdate` — timeupdate fires
    // at ~250ms so reveal jumps in big chunks. RAF runs at display
    // rate for smooth character-by-character progression.
    const tick = () => {
      if (!audio.duration || !Number.isFinite(audio.duration)) {
        progressRafRef.current = requestAnimationFrame(tick);
        return;
      }
      setAudioProgress(Math.min(1, audio.currentTime / audio.duration));
      progressRafRef.current = requestAnimationFrame(tick);
    };
    if (progressRafRef.current != null) cancelAnimationFrame(progressRafRef.current);
    progressRafRef.current = requestAnimationFrame(tick);

    audio.onended = () => {
      // Audio-end reveals the remaining covers — any cover that
      // wasn't already fired by a per-cover timer (covers without a
      // charOffset, or anchors near the end of the audio that the
      // RAF tick reached before the timer). Reveal contract: only
      // covered entries get gated/revealed by a narration; events
      // outside covers stay visible by default (server's
      // revealedEvents already includes them).
      clearCoverRevealTimers();
      const remaining = coverEntryIds.filter((id) => !scheduledIds.has(id));
      revealEvents(remaining);
      if (progressRafRef.current != null) {
        cancelAnimationFrame(progressRafRef.current);
        progressRafRef.current = null;
      }
      setNowPlayingId(null);
      setAudioProgress(0);
      setAudioDuration(null);
      // Replay-mode chaining hook — live path passes nothing.
      onClipEnd?.();
    };

    // Text reveal fires on play-start (audio begins) so sentence-level
    // emphasis tracks playback; events stay staged until audio-end.
    setVisibleNarrativeIds((prev) => {
      if (prev.has(cue.narrativeId)) return prev;
      const next = new Set(prev);
      next.add(cue.narrativeId);
      return next;
    });

    // Snap the match clock to the minute the narrator is beginning
    // from. Decoupled from revealed events — a passage "at minute 9"
    // advances the clock to 9 the moment its audio starts, even if
    // the cited events haven't all revealed yet. Null contentTime
    // (pre-match, no numeric anchor) leaves the prior value so the
    // clock doesn't flicker back to "no minute". The legacy `play`
    // cue carries a number (Kairos-clamped, no stoppage suffix);
    // stringify it for the unified `string | null` state. The
    // bundle path (passage_started) carries the stoppage form
    // separately and overrides this when present.
    if (cue.contentTime != null && cue.contentTime >= 0) {
      setCurrentBatchMinute(String(cue.contentTime));
    }
    // If an illustration for this passage arrived before its audio
    // started (generation finished before TTS synthesis), swap it in
    // now — audio-canonical contract says the image can only appear
    // once the passage is speaking.
    const pendingIllustration = pendingIllustrationsRef.current.get(cue.narrativeId);
    if (pendingIllustration) {
      setDisplayedIllustrationUrl(pendingIllustration);
      pendingIllustrationsRef.current.delete(cue.narrativeId);
    }
    setNowPlayingId(cue.narrativeId);
    setAudioProgress(0);
    setAudioDuration(null);
    audio.play().catch(() => {
      // Autoplay blocked — stash for re-attempt when the user tunes in.
      pendingPlayRef.current = { cue, clientStartTime };
      setNowPlayingId(null);
    });
  }, [revealEvents, schedulePerCoverReveals, clearCoverRevealTimers]);

  // ---- Bundle-driven path (Sub-piece 4c).
  // Bridges the new bundle cues into the existing playback machinery
  // (startPlayback + revealEvents + cover-reveal timers). The bundle
  // is the source of truth for events, phase, illustration, and the
  // covers used to schedule per-event marker reveals.

  /** passage_added handler — stash the bundle, pre-populate the
   * narratives list, stage events into stagedEventsRef so the
   * existing audio-end + per-cover reveal path can fire them. Also
   * stashes covers (built from revealing.events with charOffsets) so
   * startPlayback's existing schedulePerCoverReveals call works
   * without modification. */
  const receivePassageBundle = useCallback((passage: Passage) => {
    passageBundlesRef.current.set(passage.narrativeId, passage);

    // Add the narrative entry so the typewriter has data when
    // playback starts. Idempotent against duplicate passage_added.
    setNarratives((prev) =>
      prev.some((p) => p.id === passage.narrativeId)
        ? prev
        : [
            ...prev,
            {
              id: passage.narrativeId,
              text: passage.text,
              generatedAt: passage.generatedAt,
              wordCount: passage.wordCount,
            },
          ],
    );

    // Stage every event in the revealing set so the existing
    // revealEvents path can promote them when their marker fires.
    // CanonicalEvent → ViewerEvent: the rendering shape needs
    // `content` (string fallback) and `timestamp` (sort tiebreaker)
    // — both are absent from CanonicalEvent. Stub them; events come
    // pre-sorted from the server, and the player/team fields cover
    // every rendering case the matchroom uses.
    for (const marker of passage.revealingCanonical.events ?? []) {
      const ce = marker.value;
      stagedEventsRef.current.set(ce.id, {
        id: ce.id,
        eventType: ce.eventType,
        content: "",
        minute: ce.minute,
        extraMinute: ce.extraMinute,
        contentTime: ce.contentTime,
        timestamp: 0,
        player: ce.player,
        relatedPlayer: ce.relatedPlayer,
        team: ce.team,
        teamName: ce.teamName,
        isGoal: ce.isGoal,
      });
    }

    // Stash covers in the shape startPlayback expects.
    narrativeCoversRef.current.set(
      passage.narrativeId,
      (passage.revealingCanonical.events ?? []).map((m) => ({
        entryId: m.value.id,
        charOffset: m.charOffset,
      })),
    );

    // TTS-disabled broadcasts have no audio gate — passage_started
    // never fires, so the marker walk never runs. Reveal everything
    // on receipt: text becomes visible, all revealing events fire,
    // phase + illustration land. The chain invariant absorbs the
    // tail-passage's revealing into the NEXT passage_added's
    // revealedCanonical, so the matchroom display remains
    // consistent across passages.
    if (!ttsEnabledRef.current) {
      setVisibleNarrativeIds((prev) => {
        if (prev.has(passage.narrativeId)) return prev;
        const next = new Set(prev);
        next.add(passage.narrativeId);
        return next;
      });
      revealEvents((passage.revealingCanonical.events ?? []).map((m) => m.value.id));
      setPhase(passage.revealedCanonical.phase as Phase);
      if (passage.revealingCanonical.phase) {
        setPhase(passage.revealingCanonical.phase.value as Phase);
      }
      if (passage.revealedCanonical.illustration) {
        setDisplayedIllustrationUrl(passage.revealedCanonical.illustration.imageUrl);
      }
      const minuteStr = passage.revealedCanonical.contentMinute;
      // Sentinel filter via parseMatchTime — phase labels
      // ("pre_match" → -1, blank → -Infinity) should leave the clock
      // empty rather than render as "pre_match'" / "-1'".
      if (minuteStr != null && parseMatchTime(minuteStr) >= 0) {
        setCurrentBatchMinute(minuteStr);
      }
    }
  }, [revealEvents]);

  /** Bridge a Passage into the existing startPlayback path. Builds
   * the legacy PlayCue shape from the bundle, applies the listener-
   * facing state at audio-start (phase from revealedCanonical,
   * illustration from revealedCanonical), and schedules the phase
   * reveal marker if revealing.phase is present. */
  const startPassagePlayback = useCallback(
    (passage: Passage) => {
      if (!passage.audio || !passage.playback) return;

      // Listener's view at this passage's audio-start. revealedCanonical
      // is the snapshot the server composed from running canonical
      // state; phase here is what the listener was in BEFORE this
      // passage's revealing.phase fires.
      setPhase(passage.revealedCanonical.phase as Phase);
      if (passage.revealedCanonical.illustration) {
        setDisplayedIllustrationUrl(passage.revealedCanonical.illustration.imageUrl);
      }
      // Snap the match clock — bundle's contentMinute is the string
      // form ("47" or "45+3"); pass through directly so stoppage
      // suffix survives. Sentinel filter via parseMatchTime
      // ("pre_match" → -1) keeps phase labels off the displayed clock.
      const minuteStr = passage.revealedCanonical.contentMinute;
      if (minuteStr != null && parseMatchTime(minuteStr) >= 0) {
        setCurrentBatchMinute(minuteStr);
      }

      // Schedule a phase reveal timer if this passage carries one.
      // Cleared alongside the per-cover timers on clip end.
      const phaseMarker = passage.revealingCanonical.phase;
      if (phaseMarker && passage.audio.durationMs > 0) {
        const ratio =
          phaseMarker.charOffset != null && passage.text.length > 0
            ? Math.max(
                0,
                Math.min(1, phaseMarker.charOffset / passage.text.length),
              )
            : 1; // no charOffset → audio-end
        const delayMs = Math.round(ratio * passage.audio.durationMs);
        const timer = window.setTimeout(() => {
          setPhase(phaseMarker.value as Phase);
        }, delayMs);
        coverRevealTimersRef.current.push(timer);
      }

      // Build the legacy PlayCue shape from the bundle and hand to
      // startPlayback. Reuses every existing audio + reveal mechanism
      // (per-cover timers from narrativeCoversRef stash, audio.onended
      // batch reveal via revealEvents from stagedEventsRef).
      // The legacy cue.contentTime contract is still numeric;
      // floor the bundle's string form for compatibility — the bundle
      // path's setter (above) already captured the stoppage form.
      const legacyMinuteNum =
        minuteStr != null && parseMatchTime(minuteStr) >= 0
          ? Math.floor(parseMatchTime(minuteStr))
          : null;
      const cue: PlayCue = {
        narrationId: passage.narrationId ?? passage.narrativeId,
        narrativeId: passage.narrativeId,
        text: passage.text,
        wordCount: passage.wordCount,
        audioUrl: passage.audio.url,
        durationMs: passage.audio.durationMs,
        playbackStartedAt: passage.playback.startedAt,
        serverNow: passage.playback.serverNow,
        batchEntryIds: (passage.revealingCanonical.events ?? []).map(
          (m) => m.value.id,
        ),
        contentTime: legacyMinuteNum,
      };
      const clientStartTime =
        Date.now() - (cue.serverNow - cue.playbackStartedAt);
      if (radioOnRef.current) {
        startPlayback(cue, clientStartTime);
      } else {
        pendingPlayRef.current = { cue, clientStartTime };
      }
    },
    [startPlayback],
  );

  // ---- Broadcast view bootstrap.
  // `GET /broadcasts/:id` returns the matchroom-shaped view: broadcast
  // row + phase + revealedEvents + currentNarrative (+ archive for
  // completed runs). One call, one shape, populates everything a fresh
  // mount or a reconnect needs to render the current broadcast state.
  // Hoisted to component scope so the WS effect can call it on
  // reconnect to backfill anything emitted during the disconnect gap —
  // the merge logic preserves whatever WS has already streamed in.
  const fetchView = useCallback(async () => {
    type MatchroomView = BroadcastMeta & {
      phase?: Phase;
      revealedEvents?: ViewerEvent[];
      currentNarrative?: {
        id: string;
        narrativeId: string;
        text: string;
        wordCount: number;
        audioUrl: string | null;
        durationMs: number;
        playbackStartedAt: string;
      } | null;
      revealedPassages?: Passage[];
    };
    try {
      const view = await apiGet<MatchroomView>(routes.broadcasts.item(broadcastId));
      setBroadcast(view);
      if (view.phase) setPhase(view.phase);
      const isReplayBroadcast =
        view.status === "complete" &&
        view.revealedPassages !== undefined &&
        view.revealedPassages.length > 0;
      if (
        view.revealedEvents &&
        view.revealedEvents.length > 0 &&
        !isReplayBroadcast
      ) {
        // Hydrate events for LIVE bootstrap. Merge with whatever's
        // already landed via WS so a late-arriving bootstrap doesn't
        // wipe live-received events.
        //
        // Skipped when revealedPassages is present (broadcast
        // complete → replay mode). Replay starts from a clean slate
        // and reveals events progressively as the bundle walk drives
        // each passage's revealing markers. Hydrating revealedEvents
        // in replay would surface every match event before the
        // listener has tuned in — exactly the spoiler the reveal
        // contract exists to prevent.
        setEvents((prev) => {
          const byId = new Map<string, ViewerEvent>();
          for (const e of view.revealedEvents!) byId.set(e.id, e);
          for (const e of prev) byId.set(e.id, e);
          return Array.from(byId.values()).sort(compareEventsByMatchTime);
        });
      }
      // Replay mode: any events accumulated during a prior live
      // session in this tab need to be cleared. The bundle-walk
      // driver is the sole authority on what's revealed.
      if (isReplayBroadcast) {
        setEvents([]);
      }
      // `currentNarrative` only matters for LIVE late-joiners — it
      // tells the matchroom which passage is mid-flight so it can
      // snap into the live offset on tune-in. For complete broadcasts
      // (replay mode) it would resolve to the LAST narration of the
      // run; pre-marking it visible would render the whole closing
      // passage with revealRatio=1 (the live "passage just ended"
      // read-back semantic) before the user has even tuned in. Skip
      // in replay — the bundle walk owns reveal timing.
      if (view.currentNarrative && !isReplayBroadcast) {
        const n = view.currentNarrative;
        const narrativeEntry: Narrative = {
          id: n.narrativeId,
          text: n.text,
          generatedAt: n.playbackStartedAt,
          wordCount: n.wordCount,
        };
        setNarratives((prev) =>
          prev.some((p) => p.id === n.narrativeId) ? prev : [...prev, narrativeEntry],
        );
        setVisibleNarrativeIds((prev) => {
          if (prev.has(n.narrativeId)) return prev;
          const next = new Set(prev);
          next.add(n.narrativeId);
          return next;
        });
        // Is it still playing? Play-state is derived from wall-clock
        // time vs (playbackStartedAt + durationMs).
        const startedMs = new Date(n.playbackStartedAt).getTime();
        const endsMs = startedMs + n.durationMs;
        if (Date.now() < endsMs) {
          setNowPlayingId(n.narrativeId);
          // Don't start audio here — user hasn't given a tune-in
          // gesture yet. The tune-in handler picks up `nowPlayingId`
          // and seeks to the live offset.
        }
      }
      // Replay seed — completed broadcasts. Stage all events (will
      // reveal as narrations end) and pre-load the narration text
      // into `narratives` so the typewriter has data the moment
      // playback begins. Audio playback waits for tune-in gesture.
      if (isReplayBroadcast) {
        const passages = view.revealedPassages!;
        replayPassagesRef.current = passages;

        // Restore replay progress from localStorage. The version tag
        // is the last-passage's narrativeId — if the archive has
        // been rebuilt (e.g. backfill re-ran with different data),
        // the tag won't match and we reset cleanly to passage 0.
        const tag = passages[passages.length - 1]?.narrativeId ?? "";
        const stored = loadReplayProgress(broadcastId, tag);
        const startIdx = Math.min(Math.max(stored.index, 0), passages.length);
        replayIndexRef.current = startIdx;

        // Seed the narratives list from the bundle text — gives the
        // typewriter source data immediately. Audio playback still
        // waits on the tune-in gesture.
        setNarratives(
          passages.map((p) => ({
            id: p.narrativeId,
            text: p.text,
            generatedAt: p.generatedAt,
            wordCount: p.wordCount,
          })),
        );

        // Stage every event the bundle reveals into stagedEventsRef
        // so the live-style per-cover-marker + audio-end batch
        // reveal works during the walk.
        for (const passage of passages) {
          for (const marker of passage.revealingCanonical.events ?? []) {
            const ce = marker.value;
            stagedEventsRef.current.set(ce.id, {
              id: ce.id,
              eventType: ce.eventType,
              content: "",
              minute: ce.minute,
              extraMinute: ce.extraMinute,
              contentTime: ce.contentTime,
              timestamp: 0,
              player: ce.player,
              relatedPlayer: ce.relatedPlayer,
              team: ce.team,
              teamName: ce.teamName,
              isGoal: ce.isGoal,
            });
          }
          narrativeCoversRef.current.set(
            passage.narrativeId,
            (passage.revealingCanonical.events ?? []).map((m) => ({
              entryId: m.value.id,
              charOffset: m.charOffset,
            })),
          );
        }

        // Resumed replay — derive the visible canonical state by
        // walking passages[0..startIdx-1] and applying each
        // revealing forward, then layering on passages[startIdx-1]'s
        // revealing (the user heard that passage to the end). The
        // result is the state at audio-start of passage[startIdx].
        if (startIdx > 0) {
          let state: CanonicalState = emptyCanonicalState();
          for (let i = 0; i < startIdx; i++) {
            state = applyRevealingCanonical(state, passages[i].revealingCanonical);
          }
          setEvents(state.events.map(canonicalEventToViewerEvent));
          setPhase(state.phase as Phase);
          if (state.illustration) {
            setDisplayedIllustrationUrl(state.illustration.imageUrl);
          }
          if (state.contentMinute != null && parseMatchTime(state.contentMinute) >= 0) {
            setCurrentBatchMinute(state.contentMinute);
          }
          // Mark played passages as already heard.
          setVisibleNarrativeIds(
            new Set(passages.slice(0, startIdx).map((p) => p.narrativeId)),
          );
        }
      }
    } catch {
      // Silent — next poll / reconnect tries again; WS is the backstop.
    }
  }, [broadcastId]);

  /** Project a CanonicalEvent into the matchroom's ViewerEvent shape.
   * The rendering shape needs `content` and `timestamp` which
   * CanonicalEvent doesn't carry — both are stubbed (player/team
   * fields cover every render path the matchroom uses today). */
  function canonicalEventToViewerEvent(ce: CanonicalEvent): ViewerEvent {
    return {
      id: ce.id,
      eventType: ce.eventType,
      content: "",
      minute: ce.minute,
      extraMinute: ce.extraMinute,
      contentTime: ce.contentTime,
      timestamp: 0,
      player: ce.player,
      relatedPlayer: ce.relatedPlayer,
      team: ce.team,
      teamName: ce.teamName,
      isGoal: ce.isGoal,
    };
  }

  // Bootstrap on mount, then poll every 10s while scheduled so the
  // client flips to live as soon as status changes (the WS effect
  // re-runs on status change and opens the connection).
  useEffect(() => {
    void fetchView();
    const interval = setInterval(() => {
      // Stop polling once live — the WS connection + its cues carry
      // state from there. Complete broadcasts also stop.
      setBroadcast((curr) => {
        if (curr && (curr.status === "live" || curr.status === "complete")) return curr;
        void fetchView();
        return curr;
      });
    }, 10_000);
    return () => { clearInterval(interval); };
  }, [fetchView]);

  // ---- WebSocket: all playback cues + feed entries + narratives.
  // Conductor-driven — the server owns the narration clock and fans
  // out the same cues to every connected client. No per-client TTS
  // POSTs.
  //
  // Connection lifecycle is delegated to useReconnectingWebSocket
  // (lib/ws.ts): pass `null` when not live and the hook tears down;
  // pass a URL once status flips live and the hook opens (with
  // backoff reconnect on close). The page's job here is just the
  // message dispatch + the once-per-reopen backfill.
  const wsUrl = broadcast?.status === "live"
    ? `${WS_URL}/ws/matchroom?broadcastId=${broadcastId}`
    : null;
  const isReconnectRef = useRef(false);
  const { status: wsStatus } = useReconnectingWebSocket(wsUrl, {
    onOpen: () => {
      // First open is the bootstrap; the parallel fetchView effect
      // already ran. Subsequent opens are reconnects after the socket
      // dropped — backfill so anything emitted during the gap shows
      // up. The merge logic in fetchView dedupes against whatever WS
      // has already streamed.
      if (isReconnectRef.current) void fetchView();
      isReconnectRef.current = true;
    },
    onMessage: (evt) => {
      try {
        const msg = JSON.parse(evt.data);

        if (msg.type === "connected" && msg.broadcast) {
          setBroadcast(msg.broadcast);
          if (typeof msg.phase === "string") setPhase(msg.phase as Phase);
          // Late joiner — if a passage is in flight, drop into it at
          // the server-anchored offset. Stage the bundle and call
          // through the same path passage_started uses for fresh
          // arrivals.
          if (msg.currentPassage && typeof msg.serverNow === "number") {
            const passage = msg.currentPassage as Passage;
            receivePassageBundle(passage);
            startPassagePlayback(passage);
          }
          return;
        }

        if (msg.type === "passage_added" && msg.passage) {
          receivePassageBundle(msg.passage as Passage);
          return;
        }

        if (msg.type === "passage_audio_ready" && msg.audio) {
          // Warm the browser cache — a hidden Audio object with
          // preload="auto" downloads the bytes. When the matching
          // `passage_started` arrives, audioRef re-requests the same
          // URL and hits cache.
          const a = new Audio();
          a.preload = "auto";
          a.src = msg.audio.url;
          try { a.load(); } catch { /* ignore */ }
          preloadedAudiosRef.current.set(msg.narrationId, a);
          return;
        }

        if (msg.type === "passage_started" && msg.audio && msg.playback) {
          const stashed = passageBundlesRef.current.get(msg.narrativeId);
          if (!stashed) return;
          // Patch the stashed bundle with audio + playback before
          // handing to the playback path — passage_added stashes with
          // these as null.
          const passage: Passage = {
            ...stashed,
            narrationId: msg.narrationId,
            audio: msg.audio,
            playback: msg.playback,
          };
          passageBundlesRef.current.set(msg.narrativeId, passage);
          startPassagePlayback(passage);
          return;
        }

        if (msg.type === "passage_skipped" && typeof msg.narrativeId === "string") {
          // Synthesis failed for this passage. Drop the bundle —
          // the conductor's running canonical state has already
          // folded the revealings forward, so the next passage's
          // revealedCanonical includes them. No UI work needed.
          passageBundlesRef.current.delete(msg.narrativeId);
          return;
        }

        if (msg.type === "passage_updated" && msg.patch?.revealedCanonical) {
          const stashed = passageBundlesRef.current.get(msg.narrativeId);
          if (!stashed) return;
          const patch = msg.patch.revealedCanonical;
          passageBundlesRef.current.set(msg.narrativeId, {
            ...stashed,
            revealedCanonical: { ...stashed.revealedCanonical, ...patch },
          });
          // Patch live UI for fields that can update mid-passage —
          // illustration is the common case (image generation can
          // finish after audio has started).
          if (
            patch.illustration?.imageUrl &&
            nowPlayingIdRef.current === msg.narrativeId
          ) {
            setDisplayedIllustrationUrl(patch.illustration.imageUrl);
          }
          return;
        }

        if (msg.type === "broadcast_status_changed") {
          // Lifecycle change — refetch the broadcast view so the
          // matchroom picks up the archive on `complete` and flips
          // to replay mode.
          void fetchView();
          return;
        }
      } catch {
        // Non-JSON message — server sends JSON only, ignore.
      }
    },
  });

  // Display state — derived. The hook reports raw connection status
  // for the live case; the page rules apply outside it (no broadcast
  // yet → "connecting"; complete → "open" since replay mode has
  // everything; otherwise → "scheduled"). No setter / no effect.
  const connection: "connecting" | "open" | "closed" | "error" | "scheduled" =
    !broadcast ? "connecting"
      : broadcast.status === "complete" ? "open"
        : broadcast.status !== "live" ? "scheduled"
          : wsStatus;

  // Cycle-state caches + timers built up while live: drain them when
  // leaving live (status changes or unmount). Independent of the WS
  // lifecycle — the hook above closes the socket itself.
  useEffect(() => {
    if (broadcast?.status !== "live") return;
    return () => {
      for (const a of preloadedAudiosRef.current.values()) {
        a.src = "";
        try { a.load(); } catch { /* ignore */ }
      }
      preloadedAudiosRef.current.clear();
      stagedEventsRef.current.clear();
      narrativeCoversRef.current.clear();
      for (const t of coverRevealTimersRef.current) clearTimeout(t);
      coverRevealTimersRef.current = [];
      if (progressRafRef.current != null) {
        cancelAnimationFrame(progressRafRef.current);
        progressRafRef.current = null;
      }
    };
  }, [broadcast?.status]);

  // ---- Replay clip chaining.
  // Walks revealedPassages — the bundle-driven replay payload — and
  // chains audio clip-by-clip via the same path the live cues use
  // (receivePassageBundle stages, startPlayback drives audio +
  // per-cover-marker timers + audio-end batch reveal). Phase + the
  // bundle's revealedCanonical.illustration are applied in the same
  // shape as live; a phase reveal marker, if present, fires at its
  // charOffset just like in live. 400ms inter-clip gap matches the
  // live conductor's gap — absorbs decode jitter without dead air.
  // The natural side-effect of chaining clip-to-clip is that the long
  // silent stretches between live narrations are stripped, per the
  // replay memo's "preserve pacing within a clip, strip dead air
  // between" principle.
  const playReplayNext = useCallback(() => {
    const passages = replayPassagesRef.current;
    const tag = passages[passages.length - 1]?.narrativeId ?? "";
    const idx = replayIndexRef.current;
    if (idx >= passages.length) return;
    const source = passages[idx];
    if (!source.audio) {
      replayIndexRef.current = idx + 1;
      saveReplayProgress(broadcastId, tag, idx + 1, 0);
      setTimeout(playReplayNext, 0);
      return;
    }

    // Synthesise playback timing so audio plays from offset 0 — the
    // walk owns playback locally; there's no server-anchored start.
    const now = Date.now();
    const audio = source.audio;
    const passage: Passage = {
      ...source,
      audio,
      playback: { startedAt: now, serverNow: now },
    };
    receivePassageBundle(passage);

    // Apply the listener-facing state (matches startPassagePlayback's
    // setup but with synthetic timing + an onClipEnd to advance).
    setPhase(passage.revealedCanonical.phase as Phase);
    if (passage.revealedCanonical.illustration) {
      setDisplayedIllustrationUrl(passage.revealedCanonical.illustration.imageUrl);
    }
    const minuteStr = passage.revealedCanonical.contentMinute;
    if (minuteStr != null && parseMatchTime(minuteStr) >= 0) {
      setCurrentBatchMinute(minuteStr);
    }
    const phaseMarker = passage.revealingCanonical.phase;
    if (phaseMarker && audio.durationMs > 0) {
      const ratio =
        phaseMarker.charOffset != null && passage.text.length > 0
          ? Math.max(0, Math.min(1, phaseMarker.charOffset / passage.text.length))
          : 1;
      const delayMs = Math.round(ratio * audio.durationMs);
      const timer = window.setTimeout(() => {
        setPhase(phaseMarker.value as Phase);
      }, delayMs);
      coverRevealTimersRef.current.push(timer);
    }

    // Legacy cue contract is still numeric; floor the bundle's string
    // contentMinute for compatibility — the bundle path's setter (above)
    // already captured the stoppage form into currentContentMinute.
    const legacyMinuteNum =
      minuteStr != null && parseMatchTime(minuteStr) >= 0
        ? Math.floor(parseMatchTime(minuteStr))
        : null;
    const cue: PlayCue = {
      narrationId: passage.narrationId ?? passage.narrativeId,
      narrativeId: passage.narrativeId,
      text: passage.text,
      wordCount: passage.wordCount,
      audioUrl: audio.url,
      durationMs: audio.durationMs,
      playbackStartedAt: now,
      serverNow: now,
      batchEntryIds: (passage.revealingCanonical.events ?? []).map(
        (m) => m.value.id,
      ),
      contentTime: legacyMinuteNum,
    };
    startPlayback(cue, now, () => {
      replayIndexRef.current = idx + 1;
      saveReplayProgress(broadcastId, tag, idx + 1, 0);
      setTimeout(playReplayNext, 400);
    });
  }, [broadcastId, receivePassageBundle, startPlayback]);

  // ---- Tune-in gesture.
  // Satisfies the browser's user-gesture requirement for autoplay and
  // frames entering the room as a deliberate act. Live: snaps into the
  // current playback offset. Replay: starts the chained clip queue at
  // the current replayIndex (0 on fresh mount).
  const turnOnRadio = useCallback(() => {
    setRadioOn(true);
    radioOnRef.current = true;
    const pending = pendingPlayRef.current;
    pendingPlayRef.current = null;
    if (pending) {
      startPlayback(pending.cue, pending.clientStartTime);
      return;
    }
    if (replayPassagesRef.current.length > 0) {
      playReplayNext();
    }
  }, [startPlayback, playReplayNext]);

  // ---- Score derived from revealed events (no-spoilers contract).
  // Match minute comes from the current passage's contentTime —
  // the narrator is speaking from that minute onward. Falls back to
  // the latest revealed event's contentTime if contentTime
  // hasn't been set yet (older broadcasts without the field,
  // pre-passage state on live broadcasts).
  //
  // Phase short-circuits the minute display at the breaks: a numeric
  // minute reads as "still playing" during halftime / full-time, which
  // is the wrong story. "HT" / "FT" make the break explicit.
  // Server-derived canonical state from the broadcast view, with
  // local derivation as a fallback for live updates between bootstrap
  // fetches. Server runs the same dedup + sort logic on the same
  // events list, so the two sources agree on clean data — local
  // derivation just keeps the UI responsive between view refreshes.
  // The view fields land via `setBroadcast(view)` after the bootstrap
  // fetch resolves; the BroadcastMeta state type is intentionally
  // narrow so we read the augmented fields off an `unknown` cast.
  //
  // Replay mode (archive present) is the exception: server's score /
  // fallbackContentMinute reflect the FINAL state, but replay starts from
  // empty and reveals progressively as the chained playback drives
  // each narration. Force local derivation in replay so the displayed
  // values track the events array, which only contains what's been
  // revealed so far.
  const broadcastView = broadcast as
    | (BroadcastMeta & { score?: { home: number; away: number }; currentContentMinute?: string | null })
    | null;
  const isReplay = replayPassagesRef.current.length > 0;
  const score = useMemo(
    () => (!isReplay && broadcastView?.score ? broadcastView.score : deriveScore(events)),
    [isReplay, broadcastView, events],
  );
  const contentMinute = useMemo(
    () =>
      computeContentMinuteLabel({
        phase,
        isReplay,
        currentContentMinute,
        fallbackContentMinute: broadcastView?.currentContentMinute ?? null,
        events,
      }),
    [phase, currentContentMinute, broadcastView, events, isReplay],
  );

  // ---- Current + next narrative, scoped to visible (played) passages.
  // Passages that haven't had their `play` cue fire are hidden — the
  // "audio is canonical" principle means the text can't reveal ahead
  // of the narrator's voice. `visibleNarratives` is the played subset;
  // the current passage is nowPlayingId if playing, else the most
  // recently played (last in the visible list).
  const visibleNarratives = useMemo(
    () => narratives.filter((n) => visibleNarrativeIds.has(n.id)),
    [narratives, visibleNarrativeIds],
  );
  const currentIdx = nowPlayingId
    ? visibleNarratives.findIndex((n) => n.id === nowPlayingId)
    : visibleNarratives.length - 1;
  const currentNarrative = currentIdx >= 0 ? visibleNarratives[currentIdx] : null;
  // "Next" is meaningful only while playing and a played-after passage
  // exists. Without audio-end reveal, we never show anyone a queued
  // passage — keeping the gate strict.
  const nextNarrative = currentIdx >= 0 && currentIdx + 1 < visibleNarratives.length
    ? visibleNarratives[currentIdx + 1]
    : null;

  // ---- Typewriter reveal ratio for the current passage.
  // While playing: 0 until audio metadata lands, then linear with
  // audio progress. The explicit 0-during-load avoids flashing the
  // full text for the ~150ms between `setNowPlayingId` firing and
  // `onloadedmetadata` resolving. Not playing: 1 (fully visible as a
  // persisted read-back of the passage that just ended). See
  // docs/match-windows memory on the audio-is-canonical contract.
  const isPlaying = nowPlayingId != null;
  const revealRatio = isPlaying
    ? audioDuration != null ? audioProgress : 0
    : 1;

  // The "Now" strip's pill text — ON state only. The OFF state uses its
  // own copy inside NowPlaying. When radio is on but queue is empty (we
  // just finished a passage and are waiting for the next), show a
  // quieter waiting note so the pill doesn't flash empty.
  const voiceLabel = nowPlayingId && currentIdx >= 0
    ? `The Author's Voice · passage ${currentIdx + 1}`
    : visibleNarratives.length > 0
      ? "Waiting for the next passage"
      : "Waiting for the first passage";

  const minuteLabel =
    broadcast?.status === "live"
      ? contentMinute
        ? `Live now · ${contentMinute}`
        : "Live now"
      : broadcast?.status === "complete"
        ? "Broadcast complete"
        : broadcast?.status === "scheduled"
          ? "Scheduled"
          : "Not yet live";

  return (
    <div
      style={{
        background: C.umber,
        color: C.ivory,
        minHeight: "100vh",
        fontFamily: "inherit",
      }}
    >
      <main
        style={{
          maxWidth: 720,
          margin: "0 auto",
          padding: "24px 24px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 16,
          width: "100%",
          // CAP at viewport (don't force-stretch). On tall screens the
          // natural content height (sum of children) is less than 100vh
          // → main is content-sized and sits at the top, empty space
          // below. On short screens main is clamped to 100vh and only
          // the illustration wrapper shrinks to fit (every other child
          // is wrapped in flexShrink: 0). box-sizing: border-box ensures
          // the cap includes padding — without it the padding sits
          // outside the cap and the actual element overflows.
          maxHeight: "100vh",
          boxSizing: "border-box",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0 }}>
          <Header minuteLabel={minuteLabel} live={broadcast?.status === "live"} />
        </div>

        <div style={{ flexShrink: 0 }}>
          <Fixture
            home={broadcast?.homeTeam ?? "—"}
            away={broadcast?.awayTeam ?? "—"}
            competition={broadcast?.competition ?? ""}
            homeScore={score.home}
            awayScore={score.away}
            contentMinute={contentMinute}
            live={broadcast?.status === "live"}
          />
        </div>

        {/* The ONE shrinkable child. Explicit height = column width
            × 0.75 (the natural 4:3 size at full column width) breaks
            the circular dependency between wrapper-size-from-flex
            and illustration-size-from-wrapper. On tall screens the
            wrapper sits at this height with empty space below the
            footer; on short screens flex-shrink reduces it and the
            Illustration inside (measured via ResizeObserver) shrinks
            its 4:3 box accordingly. */}
        <div
          style={{
            flexShrink: 1,
            minHeight: 0,
            height: 540,
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            position: "relative",
            // CRITICAL: tells the browser the wrapper's intrinsic
            // min-content does NOT depend on the illustration's
            // natural 540 height. Without this, flex-shrink could
            // only reduce the wrapper down to the illustration's
            // initial-render height, leaving total content above
            // viewport. With overflow:hidden the wrapper shrinks
            // freely to whatever flex distributes.
            overflow: "hidden",
          }}
        >
          <Illustration imageUrl={displayedIllustrationUrl} />
        </div>

        <div style={{ flexShrink: 0 }}>
          <NowPlaying
            radioOn={radioOn}
            onTurnOn={turnOnRadio}
            voiceLabel={voiceLabel}
            playing={nowPlayingId != null}
            ttsEnabled={broadcast?.ttsEnabled === true}
          />
        </div>

        {/* Quiet phases show a placeholder in place of the live passage
            — the narrator isn't speaking, so the matchroom shouldn't
            pretend otherwise. Switching at the phase boundary keeps
            layout stable while the copy changes beneath.
            Replay mode (status=complete) renders the typewriter
            whenever a clip is loaded, regardless of the (terminal)
            phase. */}
        {/* Typewriter slot — always rendered with a fixed height so
            the layout doesn't shift when narration starts/stops. The
            slot reserves its space empty pre-tune-in; on tune-in the
            same slot fills with the typewriter content. */}
        <div style={{ flexShrink: 0 }}>
          {broadcast?.status === "complete" ||
          isLivePhase(phase) ||
          ((phase === "halftime" || phase === "full_time_winddown") &&
            currentNarrative != null) ? (
            <Narration
              current={currentNarrative}
              revealRatio={revealRatio}
              isPlaying={isPlaying}
              isReplay={broadcast?.status === "complete"}
            />
          ) : (
            <PhasePlaceholder phase={phase} />
          )}
        </div>

        <AdminFooter theme="dark" left={<ConnectionPill connection={connection} />} />
      </main>

      {/* Hidden audio element — driven by conductor `play` cues. */}
      <audio ref={audioRef} style={{ display: "none" }} />

      {/* Event ribbon lives in the LEFT print margin — visible at a
          glance, doesn't pull focus from the passage being read. */}
      <EventRibbon events={events} />

      {/* Marginalia — placeholder chat drawer in the RIGHT print
          margin. Closed state is a small listener pill + thin edge
          line; open state slides a 280px panel in over the empty
          margin space. Coming-soon copy for now. */}
      <Marginalia />

      {/* Mobile overrides. Desktop layout is kept for the hero — the
          big "Home vs Away" reads fine at phone widths in practice.
          The two mobile-specific moves are: hide the left-margin event
          ribbon (no room for it) and rework the marginalia drawer for
          thumb-zone interaction. 640px is the standard phone-vs-tablet
          cutoff; tablets keep the desktop layout. */}
      <style>{`
        /* ---- Mobile width overrides (applies to every narrow
           viewport, portrait or landscape). Non-hero treatments that
           don't care about available vertical space. */
        @media (max-width: 640px) {
          /* Event ribbon — hidden. The left print margin doesn't
             exist at this width; events would overlap the main column. */
          .mr-event-ribbon { display: none !important; }

          /* Close trigger — matching the 44px touch target the open
             trigger uses. The hit area enlarges via padding so the
             × glyph stays visually 18px. */
          .mr-marginalia-close {
            min-width: 44px !important;
            min-height: 44px !important;
            padding: 8px 12px !important;
            font-size: 24px !important;
          }

          /* Marginalia trigger — reposition to the bottom-right
             thumb zone and grow to a 44px minimum touch target per
             iOS/Android guidelines. Floating affordance instead of
             the subtle margin pip the desktop uses. */
          .mr-marginalia-trigger {
            top: auto !important;
            bottom: 76px !important;
            right: 16px !important;
            min-height: 44px !important;
            min-width: 44px !important;
            padding: 10px 14px !important;
            font-size: 13px !important;
            opacity: 1 !important;
            background: ${C.umber} !important;
            border-color: ${C.driftwood}66 !important;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
          }

          /* Drawer panel — fills the viewport when open rather than
             sliding in over an imaginary print margin. border-box so
             the padding sits *inside* the 100vw envelope (default
             content-box would render as 100vw + 56px of padding and
             push the content past the right edge). */
          .mr-marginalia-panel {
            width: 100vw !important;
            box-sizing: border-box !important;
            padding: 56px 28px 32px !important;
          }
          .mr-marginalia-panel:not(.is-open) {
            right: -100vw !important;
          }
        }

        /* ---- Hero compaction — applies at every mobile width.
           Compact sizes across the board; the only thing that varies
           with viewport height is leading (see the taller-viewport
           rule below). */
        @media (max-width: 640px) {
          .mr-fixture { margin-top: 4px !important; }
          .mr-fixture-headline {
            font-size: 24px !important;
            margin-top: 2px !important;
          }
          .mr-fixture-scoreline {
            margin-top: 8px !important;
            column-gap: 14px !important;
          }
          .mr-fixture-digit {
            font-size: 22px !important;
          }
        }

        /* ---- Short viewports (≤720h). Every pixel counts — drop
           the "Home vs Away" headline entirely (team names are
           duplicated in the scoreline row below it) and tighten
           leading across the remaining lines. iPhone SE class. */
        @media (max-width: 640px) and (max-height: 720px) {
          .mr-fixture-headline { display: none !important; }
          .mr-fixture-competition { line-height: 1 !important; }
          .mr-fixture-teamname { line-height: 1 !important; }
          .mr-fixture-digit {
            font-size: 20px !important;
            line-height: 1 !important;
          }
          .mr-fixture-minute { line-height: 1 !important; }
        }

        /* ---- Medium-tall viewports (800–879h). Compact sizes, modest
           leading bump across hero lines — enough to occupy more
           vertical space without the hero looking like it's floating
           apart. iPhone 14 / 13 / 12 class at 844h. */
        @media (max-width: 640px) and (min-height: 800px) and (max-height: 879px) {
          .mr-fixture-competition { line-height: 2 !important; }
          .mr-fixture-headline { line-height: 1.8 !important; }
          .mr-fixture-teamname { line-height: 2 !important; }
          .mr-fixture-digit { line-height: 1.6 !important; }
          .mr-fixture-minute { line-height: 2 !important; }
        }

        /* ---- Tall viewports (≥880h). Enough vertical room that the
           compact treatment leaves awkward empty bands above and below
           the illustration — revert to full desktop sizes. iPhone
           14/15 Pro Max (932h), 11 Pro Max (896h). */
        @media (max-width: 640px) and (min-height: 880px) {
          .mr-fixture { margin-top: 16px !important; }
          .mr-fixture-headline {
            font-size: 40px !important;
            margin-top: 8px !important;
          }
          .mr-fixture-scoreline {
            margin-top: 20px !important;
            column-gap: 20px !important;
          }
          .mr-fixture-digit { font-size: 32px !important; }
        }
      `}</style>
    </div>
  );
}
