import type { WebSocket as WsWebSocket } from "ws";
import { eq } from "drizzle-orm";
import * as kairos from "../lib/kairos.js";
import { db } from "../db/client.js";
import { broadcastNarrations, broadcastIllustrations } from "../db/schema.js";
import { getStorage } from "../lib/storage/index.js";
import { reportPacing } from "../lib/kairos-bridge.js";
import {
  CLOSING_PASSAGE_PROMPT,
  HALFTIME_REFLECTION_PROMPT,
} from "../lib/defaults.js";
import type { TtsProvider } from "../lib/tts/index.js";
import type {
  Broadcast,
  CanonicalState,
  Passage,
  RevealingCanonical,
} from "@blackout/shared";
import { applyRevealingCanonical, emptyCanonicalState, parseMatchTime } from "@blackout/shared";
import { synthesiseNarration } from "./synthesiser.js";
import { getTtsVoice } from "../lib/tts-voices.js";
import { composePassageBundle } from "./canonical-compose.js";
import { generateImage } from "../lib/replicate.js";
import { checkNarrativeInvariants } from "./invariants.js";
import { captureEvent } from "../lib/telemetry.js";
import type {
  BroadcastPhase,
  ConductorCue,
  GameplayTransitionEventType,
  LatencySampleCue,
  NarrationRecord,
  PlaySnapshot,
  PreloadCue,
} from "./types.js";


/** Gap between clips to protect against the previous clip's tail being
 * clipped by the next. The server-side `setTimeout(onClipEnd, durationMs)`
 * fires on the nominal MP3 duration — but the client's actual playback
 * lags by network + decode time (typically 200–400ms). Without a buffer,
 * the next `play` cue arrives while the previous audio is still finishing
 * its tail on the client, which is audible as a clip. 400ms is enough
 * to absorb that jitter, tight enough to preserve flow. */
const INTER_CLIP_GAP_MS = 400;

import {
  CLOSING_DEADLINE_MS,
  PHASE_FOR_TRANSITION_EVENT,
  decideClipEndAction,
  decideSourcePushAllowed,
  nextPhaseFromEntryPhase,
} from "./phase-logic.js";

/**
 * Per-broadcast room conductor. Owns the Kairos feed subscription, the
 * synthesis + playback pipeline, and fan-out to every connected matchroom
 * and moderator WebSocket. Exactly one instance per broadcast, lifecycle
 * tied to broadcast activation / completion.
 *
 *   Kairos narrative → server synthesis → storage → queue → play/preload cues
 *                                                             ↓
 *                                       every subscribed WS client plays the
 *                                       same audio URL at the same server-
 *                                       anchored instant
 *
 * Synthesis runs serially so queue order matches Kairos's emission order.
 * Playback is driven by `setTimeout` keyed off clip duration — the server
 * is the authoritative clock, clients follow.
 *
 * A late joiner (WS connects mid-clip) receives a `connected` snapshot
 * with `currentPlay.playbackStartedAt` and the server's `serverNow` so
 * the client can seek to `(serverNow - playbackStartedAt) / 1000` and
 * drop into the live position.
 */
export class RoomConductor {
  readonly broadcastId: string;
  readonly kairosBroadcastId: string;

  private broadcast: Broadcast;
  private clients = new Set<ClientEntry>();
  private kairosWs: ReturnType<typeof kairos.subscribeFeed> | null = null;

  // Broadcast phase — see BroadcastPhase for the FSM and
  // docs/match-windows memory for the product shape. Starts `warming`
  // on conductor construction; transitions driven by the Blackout's
  // Sportmonks adapter (KICKOFF → live_first_half, HALFTIME → halftime,
  // etc). `complete` is terminal.
  private phase: BroadcastPhase = "warming";

  // LRU entry cache for invariant checks. Maintains the last ~500
  // feed entries the Kairos feed has emitted for this broadcast so
  // the domain-aware invariants (goal-uncovered etc.) can look up
  // entries by id. Bounded to keep memory flat over a 2-hour match;
  // the invariants only need recent entries.
  private entryCache = new Map<string, kairos.KairosFeedEntry>();
  private static readonly ENTRY_CACHE_CAPACITY = 500;

  private narrativeQueue: Array<{
    narrativeId: string;
    text: string;
    generatedAt: string;
    wordCount: number;
    batchEntryIds: string[];
    covers: { entryId: string; charOffset?: number }[];
    contentTime: number | null;
    revealedCanonical: CanonicalState;
    revealingCanonical: RevealingCanonical;
  }> = [];
  private synthesising = false;

  // Running canonical state for the matchroom bundle (Design A —
  // `docs/matchroom-reveal-architecture-scoping.md`). Updated on each
  // Kairos narrative receipt by folding that passage's revealing
  // forward, so the next passage's revealedCanonical is correct (the
  // chain invariant).
  //
  // `runningCanonical.phase` is the LISTENER'S view of phase — what's
  // been revealed via passage audio so far. It lags `this.phase` (the
  // FSM, advanced on observation of the synthetic phase-transition
  // entry) until the bundle's `revealingCanonical.phase` marker fires
  // during audio playback. The two converge at the boundary of every
  // phase-revealing passage.
  //
  // Initial empty state on construction; recovery walks persisted
  // bundles in `start()` to rebuild for restarts mid-broadcast.
  private runningCanonical: CanonicalState = emptyCanonicalState(this.phase);

  /** Highest contentMinute string ever emitted on a `revealedCanonical`
   * for this broadcast. Threaded into `composePassageBundle` as the
   * monotonic floor so the matchroom's clock never goes backwards.
   *
   * The value is the bundle's `contentMinute` string ("47" / "45+2"),
   * not a parsed number — `parseMatchTime` is the comparator inside
   * `composeContentMinute`. Null until the first non-null contentMinute
   * is composed (pre-match cycles emit null).
   *
   * Recovered alongside `runningCanonical` from persisted narrations
   * at start() so a server restart mid-broadcast doesn't reset the
   * floor and re-introduce the regression. */
  private lastEmittedContentMinute: string | null = null;

  private readyQueue: NarrationRecord[] = [];
  private currentlyPlaying: NarrationRecord | null = null;
  private playbackTimer: NodeJS.Timeout | null = null;

  private stopped = false;

  // Wall-clock at which the conductor observed the FT phase
  // transition. Set on entering full_time_winddown; null otherwise
  // (including pre-FT and post-completion). Drives the closing-
  // passage deadline that protects the broadcast from auto-completing
  // mid-roundtrip — see Finding 7 in the 2026-05-03 debrief.
  private fullTimeObservedAtMs: number | null = null;
  private closingDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

  // Tracks narrativeIds whose imagery has already been actioned so the
  // early `imagery_decision` WS message and the later `narrative`
  // message don't both fire image work. The early path is the
  // primary; the `narrative` path is a fallback if we missed the
  // early message (e.g. WS reconnect between the two).
  private imageryHandled = new Set<string>();

  // Per-narrativeId Passage state (Design A — sub-piece 4a).
  // Materialised on `passage_added`, mutated as audio/playback land,
  // emitted alongside the legacy cues during the migration window.
  // Sub-piece 4c flips matchroom to consume these; 4d retires the
  // legacy cues. Garbage-collected when a passage is no longer the
  // active or a likely-active one — bounded against long broadcasts.
  private passages = new Map<string, Passage>();

  constructor(broadcast: Broadcast) {
    if (!broadcast.kairosBroadcastId) {
      throw new Error(
        `Cannot create RoomConductor for broadcast ${broadcast.id}: no kairosBroadcastId`,
      );
    }
    this.broadcast = broadcast;
    this.broadcastId = broadcast.id;
    this.kairosBroadcastId = broadcast.kairosBroadcastId;
  }

  /**
   * Open the Kairos feed subscription and begin consuming narratives.
   *
   * Recovers `this.phase` from the broadcast's existing transition
   * entries before subscribing. Without this, a conductor that comes
   * up against a broadcast already past kickoff (server restart,
   * deploy, late client connect) would start at `warming` and walk
   * the FSM forward via the Kairos feed's sync-on-connect, pushing a
   * duplicate transition entry on every step. Recovery sets the
   * phase to whatever the latest transition implies; subsequent
   * `nextPhaseFromEntryPhase` calls then refuse backward transitions
   * for cached entries and only forward-progress on genuine new
   * activity.
   */
  async start(): Promise<void> {
    if (this.kairosWs) return;

    try {
      const latest = await kairos.getLatestTransitionEventType(this.kairosBroadcastId);
      if (latest) {
        const recoveredPhase = PHASE_FOR_TRANSITION_EVENT[latest];
        if (recoveredPhase !== this.phase) {
          console.log(
            `[conductor:${this.broadcastId}] phase recovered from history: ${this.phase} → ${recoveredPhase} (latest transition: ${latest})`,
          );
          this.phase = recoveredPhase;
        }
      }
    } catch (err) {
      console.warn(
        `[conductor:${this.broadcastId}] phase recovery failed; starting at ${this.phase}: ${(err as Error).message}`,
      );
    }

    // Recover running canonical state by folding every persisted
    // narration's revealing forward in synthesis order. Rows pre-dating
    // the bundle contract have NULL bundles and contribute nothing;
    // until the Liverpool W backfill runs, those broadcasts simply
    // start with empty running state on restart (acceptable — they
    // were testing data and aren't being matchroom-served).
    const recovered = await this.recoverRunningCanonical();
    this.runningCanonical = recovered.runningCanonical;
    this.lastEmittedContentMinute = recovered.lastEmittedContentMinute;

    this.kairosWs = kairos.subscribeFeed(this.kairosBroadcastId, {
      onSync: (entries) => {
        for (const entry of entries) {
          this.cacheEntry(entry);
          this.fanOut({ type: "feed_entry", entry });
        }
      },
      onEntry: (entry) => {
        this.cacheEntry(entry);
        this.fanOut({ type: "feed_entry", entry });
      },
      onNarrative: (narrative) => {
        this.onKairosNarrative(narrative).catch((err) => {
          console.error(
            `[conductor:${this.broadcastId}] narrative handling failed:`,
            err,
          );
        });
      },
      onImageryDecision: (decision) => {
        // Early-fire: Haiku returned before Sonnet. Start image work
        // now so Replicate runs in parallel with the still-pending
        // narrative rather than sequentially after it.
        this.handleImageryDecision(
          decision.narrativeId,
          decision.imagery,
        ).catch((err) => {
          console.error(
            `[conductor:${this.broadcastId}] imagery decision handling failed:`,
            err,
          );
        });
      },
      onGenerationSkipped: (info) => {
        this.fanOut({ type: "generation_skipped", ...info });
      },
      onClose: () => {
        console.log(`[conductor:${this.broadcastId}] Kairos feed closed`);
      },
    });
    console.log(
      `[conductor:${this.broadcastId}] started (kairos=${this.kairosBroadcastId}, tts=${this.broadcast.ttsEnabled ? "on" : "off"})`,
    );
    captureEvent({
      name: "conductor_started",
      broadcastId: this.broadcastId,
      properties: {
        "kairos.broadcastId": this.kairosBroadcastId,
        "broadcast.ttsEnabled": this.broadcast.ttsEnabled === true,
      },
    });
  }

  /** LRU cache insert. Evicts the oldest entry if at capacity. Also
   * observes the entry's `data.phase` and drives phase transitions when
   * the entry's phase advances beyond the current one — this is the
   * single source for phase transitions in both live and replay paths.
   * Live: the runner pushes a synthetic match_events whistle entry on
   * each Sportmonks lifecycle callback; the entry round-trips through
   * Kairos and lands here. Replay: the entries already exist in Kairos
   * and arrive on `subscribeFeed`'s sync. transitionTo is idempotent
   * on same phase and rejects backward transitions by ordinal, so a
   * re-cached entry is safe. */
  private cacheEntry(entry: kairos.KairosFeedEntry): void {
    if (this.entryCache.has(entry.id)) return;
    if (this.entryCache.size >= RoomConductor.ENTRY_CACHE_CAPACITY) {
      const oldest = this.entryCache.keys().next().value;
      if (oldest !== undefined) this.entryCache.delete(oldest);
    }
    this.entryCache.set(entry.id, entry);
    this.maybeTransitionFromEntry(entry);
  }

  private maybeTransitionFromEntry(entry: kairos.KairosFeedEntry): void {
    const data = entry.data as Record<string, unknown> | null | undefined;
    const next = nextPhaseFromEntryPhase(data?.phase, this.phase);
    if (!next) return;
    this.transitionTo(next);
  }

  /** Tear down. Safe to call multiple times. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;

    if (this.playbackTimer) {
      clearTimeout(this.playbackTimer);
      this.playbackTimer = null;
    }
    if (this.closingDeadlineTimer) {
      clearTimeout(this.closingDeadlineTimer);
      this.closingDeadlineTimer = null;
    }
    try {
      this.kairosWs?.close();
    } catch {
      // already closed
    }
    this.kairosWs = null;

    for (const entry of this.clients) {
      try {
        entry.ws.close();
      } catch {
        // already closed
      }
    }
    this.clients.clear();
    console.log(`[conductor:${this.broadcastId}] stopped`);
  }

  /**
   * Called when the broadcast row is updated (e.g. ttsEnabled flipped,
   * voice changed). Refreshes the local snapshot so future synthesis
   * picks up the new config.
   */
  refreshBroadcast(broadcast: Broadcast): void {
    this.broadcast = broadcast;
  }

  /** Current phase — read-only snapshot. */
  getSubjectPhase(): BroadcastPhase {
    return this.phase;
  }

  /**
   * Whether a push to Kairos is allowed for a source-typed entry,
   * given the entry's stamped content-time phase. Call sites
   * (moderator WS, broadcast runner) consult this before forwarding.
   * Pure decision lives in `decideSourcePushAllowed`; this method
   * is the conductor's instance-side surface.
   */
  canPushFromSource(sourceType: string, data?: Record<string, unknown>): boolean {
    return decideSourcePushAllowed(sourceType, data);
  }

  /**
   * Drive a phase transition. Idempotent against the same phase.
   * Triggers side-effects per phase:
   *   - halftime: one explicit "first half reflection" generation, then quiet
   *   - full_time_winddown: one explicit "closing passage" generation;
   *     when its audio ends the broadcast transitions to complete
   *   - complete: no further generation, clients receive final cue
   *
   * All transitions fan out a `phase` cue so clients swap copy.
   *
   * The synthetic match_events entry that anchors a gameplay-state
   * transition (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME)
   * is pushed by the runner, not here. The conductor sees those
   * entries via its Kairos feed subscription and reaches `transitionTo`
   * through `maybeTransitionFromEntry` — same path the replay flow
   * uses. The only direct internal caller is the auto-complete on
   * clip end (no synthetic entry for `complete`).
   */
  transitionTo(phase: BroadcastPhase): void {
    if (this.phase === phase) return;
    const prev = this.phase;
    this.phase = phase;
    console.log(`[conductor:${this.broadcastId}] phase ${prev} → ${phase}`);
    this.fanOut({ type: "phase", phase, serverNow: Date.now() });
    // Sub-piece 4a — emit `broadcast_status_changed` on terminal
    // transition. The matchroom uses this to flip into replay mode
    // (refetches GET /broadcasts/:id for the archive). Phase changes
    // within a live broadcast ride the bundle's revealingCanonical.phase
    // and don't need a separate status cue.
    if (phase === "complete") {
      this.fanOut({
        type: "broadcast_status_changed",
        status: "complete",
        serverNow: Date.now(),
      });
    }
    captureEvent({
      name: "phase_transitioned",
      broadcastId: this.broadcastId,
      properties: {
        "phase.from": prev,
        "phase.to": phase,
      },
    });

    if (phase === "halftime") {
      void this.triggerExplicitGeneration(HALFTIME_REFLECTION_PROMPT);
    } else if (phase === "full_time_winddown") {
      // Open the closing-passage protection window before firing the
      // reflection trigger — `decideClipEndAction` consults this to
      // hold auto-complete until the closing roundtrip lands or the
      // deadline forces a give-up.
      this.fullTimeObservedAtMs = Date.now();
      this.closingDeadlineTimer = setTimeout(() => {
        this.closingDeadlineTimer = null;
        this.onClosingDeadlineElapsed().catch((err) =>
          console.error(
            `[conductor:${this.broadcastId}] closing-deadline handler error:`,
            err,
          ),
        );
      }, CLOSING_DEADLINE_MS);
      void this.triggerExplicitGeneration(CLOSING_PASSAGE_PROMPT);
    }
  }

  /**
   * Fired when the closing-passage deadline elapses. Auto-completes
   * the broadcast IFF the conductor is fully idle (no clip playing,
   * no clips queued, no synthesis or narrative-queue work in flight).
   * If a clip is in flight, the next clip-end will re-evaluate via
   * `decideClipEndAction` — the deadline+idle handoff happens there.
   */
  private async onClosingDeadlineElapsed(): Promise<void> {
    if (this.stopped) return;
    if (this.phase !== "full_time_winddown") return;
    if (this.currentlyPlaying) return;
    if (this.readyQueue.length > 0) return;
    if (this.narrativeQueue.length > 0) return;
    if (this.synthesising) return;

    console.warn(
      `[conductor:${this.broadcastId}] closing-passage deadline elapsed with no narration in flight — auto-completing.`,
    );
    captureEvent({
      name: "closing_deadline_force_complete",
      broadcastId: this.broadcastId,
      properties: {
        "closing.deadlineMs": CLOSING_DEADLINE_MS,
      },
    });
    this.transitionTo("complete");
    try {
      const { completeBroadcast } = await import("../lib/kairos-bridge.js");
      await completeBroadcast(this.broadcastId);
    } catch (err) {
      console.warn(
        `[conductor:${this.broadcastId}] deadline → complete failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Ask Kairos to generate one passage against whatever context it has.
   * Fire-and-forget — the narrative lands on the feed WS the conductor
   * already subscribes to, so it flows through the normal synthesis +
   * play path. Used for halftime reflection + fulltime closing where
   * the phase explicitly wants a generation outside the accumulation
   * cadence. The conductor passes a consumer-side prompt verbatim;
   * Kairos's enum stays domain-agnostic.
   */
  private async triggerExplicitGeneration(consumerPrompt: string): Promise<void> {
    try {
      await kairos.triggerNarrativeGeneration(
        this.kairosBroadcastId,
        consumerPrompt,
      );
    } catch (err) {
      console.warn(
        `[conductor:${this.broadcastId}] explicit generation failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Register a new WS client and send it the current state snapshot.
   * Returns the unsubscribe function the caller should invoke on WS close.
   *
   * `transform` lets the calling WS handler (matchroom vs moderator)
   * customise cues for its audience — e.g. the matchroom reshapes raw
   * Kairos `feed_entry` payloads into a viewer-shaped entry and drops
   * noisy signal types, while the moderator forwards nearly everything.
   * Returning `null` from transform drops the cue for that client.
   */
  async addClient(
    ws: WsWebSocket,
    transform?: (cue: unknown) => unknown | null,
  ): Promise<() => void> {
    const entry: ClientEntry = { ws, transform };
    this.clients.add(entry);
    await this.sendConnected(entry);
    return () => this.clients.delete(entry);
  }

  // ---- Internals ----

  private async sendConnected(entry: ClientEntry): Promise<void> {
    const currentPlay = await this.currentPlaySnapshot();
    const message = {
      type: "connected",
      broadcast: this.broadcast,
      currentPlay,
      phase: this.phase,
      // Sub-piece 4b — additive `currentPassage` for the bundle-
      // driven contract. Late joiner reads
      // currentPassage.revealedCanonical to render the room's state
      // immediately, then walks revealingCanonical from the live
      // audio offset. Null when no passage is in flight (between
      // passages, pre-first-passage, post-FT). serverNow on the
      // playback field is refreshed to the snapshot send time so
      // every client computes the same audio offset.
      currentPassage: this.currentPassageSnapshot(),
      serverNow: Date.now(),
    };
    this.sendToClient(entry, message);
  }

  /** Build the late-joiner snapshot of the currently in-flight
   * passage, with `playback.serverNow` refreshed to send time. Null
   * when nothing is playing or the passage isn't in our in-memory
   * map (defensive — can happen on conductor restart before the
   * first new narrative composes). */
  private currentPassageSnapshot(): Passage | null {
    if (!this.currentlyPlaying) return null;
    const passage = this.passages.get(this.currentlyPlaying.narrativeId);
    if (!passage || !passage.playback) return null;
    return {
      ...passage,
      playback: {
        startedAt: passage.playback.startedAt,
        serverNow: Date.now(),
      },
    };
  }

  private async currentPlaySnapshot(): Promise<PlaySnapshot | null> {
    const n = this.currentlyPlaying;
    if (!n || !n.playbackStartedAt) return null;
    return {
      narrationId: n.id,
      narrativeId: n.narrativeId,
      text: n.text,
      wordCount: n.wordCount,
      audioUrl: await getStorage().getPublicUrl(n.audioKey),
      durationMs: n.durationMs,
      playbackStartedAt: n.playbackStartedAt.getTime(),
      batchEntryIds: n.batchEntryIds,
      contentTime: n.contentTime,
    };
  }

  private async onKairosNarrative(narrative: kairos.KairosNarrativeOutput): Promise<void> {
    const wordCount =
      typeof narrative.wordCount === "number" && narrative.wordCount > 0
        ? narrative.wordCount
        : countWords(narrative.text);
    const batchEntryIds = narrative.batchEntryIds ?? [];
    const contentTime = narrative.contentTime ?? null;
    const covers = narrative.covers ?? [];

    // Invariant pass — domain-aware checks against the cached
    // entries the generator had in scope. Looks for missed goals,
    // unreferenced cards, score hallucinations. Logs + PostHog.
    const batchEntries = batchEntryIds
      .map((id) => this.entryCache.get(id))
      .filter((e): e is kairos.KairosFeedEntry => e !== undefined);
    checkNarrativeInvariants({
      broadcastId: this.broadcastId,
      narrative,
      batchEntries,
    });

    // Compose this passage's canonical bundle and advance running
    // state. revealedCanonical snapshots the running state at this
    // passage's audio-start; revealingCanonical carries the deltas
    // this passage will reveal during its audio. Folding revealing
    // forward into running upholds the chain invariant
    // revealedCanonical[N+1] === apply(revealedCanonical[N],
    // revealingCanonical[N]).
    //
    // We advance running state at narrative compose time (here),
    // NOT at synthesis success or audio start. This is deliberate:
    // if synthesis fails for this passage, the reveals still fold
    // forward and the next passage's revealedCanonical absorbs them
    // — the events don't get swallowed. See the design discussion
    // in the cluster scoping doc, section "Synthesis-failed".
    const { revealedCanonical, revealingCanonical } = composePassageBundle({
      runningCanonical: this.runningCanonical,
      phase: this.phase,
      covers,
      batchEntryIds,
      entryCache: this.entryCache,
      lastEmittedContentMinute: this.lastEmittedContentMinute,
    });
    this.runningCanonical = applyRevealingCanonical(
      this.runningCanonical,
      revealingCanonical,
    );
    if (revealedCanonical.contentMinute != null) {
      this.lastEmittedContentMinute = revealedCanonical.contentMinute;
    }

    // Text propagation fires unconditionally — UI renders prose whether
    // or not audio is on. Nested shape matches the legacy Kairos payload
    // so moderator and matchroom read the same fields. `batchEntryIds`
    // travels with every narrative so consumers can stage reveals even
    // before a corresponding `play` cue lands (text-only broadcasts
    // reveal everything on narrative receipt). `contentTime` drives
    // the matchroom's match clock — snapped at passage audio-start.
    this.fanOut({
      type: "narrative",
      narrative: {
        id: narrative.id,
        narrationId: null,
        text: narrative.text,
        wordCount,
        generatedAt: narrative.generatedAt,
        covers: narrative.covers,
        batchEntryIds,
        contentTime,
      },
    });

    // Imagery decision usually arrives as an early `imagery_decision`
    // WS message ahead of this narrative. Fallback path: if the early
    // message was missed (WS reconnect mid-cycle), the imagery on
    // this payload kicks the same handler — deduped by narrativeId.
    if (narrative.imagery) {
      void this.handleImageryDecision(narrative.id, narrative.imagery);
    }

    if (this.broadcast.ttsEnabled !== true) return;

    this.narrativeQueue.push({
      narrativeId: narrative.id,
      text: narrative.text,
      generatedAt: narrative.generatedAt,
      wordCount,
      batchEntryIds,
      covers,
      contentTime,
      revealedCanonical,
      revealingCanonical,
    });

    // Sub-piece 4a — emit `passage_added` alongside the legacy
    // `narrative` cue. Audio + playback are still null; later cues
    // in the lifecycle (`passage_audio_ready`, `passage_started`)
    // populate them. Stored on `this.passages` for in-place mutation
    // by those later cues.
    const passage: Passage = {
      narrativeId: narrative.id,
      narrationId: null,
      text: narrative.text,
      wordCount,
      generatedAt: narrative.generatedAt,
      audio: null,
      playback: null,
      revealedCanonical,
      revealingCanonical,
    };
    this.passages.set(narrative.id, passage);
    this.fanOut({ type: "passage_added", passage });

    void this.drainSynthesisQueue();
  }

  /**
   * Walk every persisted narration row and fold its `revealingCanonical`
   * forward to reconstruct the conductor's running canonical state.
   * Used at conductor.start() so a server restart mid-broadcast picks
   * up exactly where it left off — events already revealed stay
   * revealed, score stays projected, the next composed passage's
   * revealedCanonical is correct without round-tripping to Kairos.
   *
   * Rows pre-dating the bundle contract have NULL bundles and
   * contribute nothing. The Liverpool W backfill (Sub-piece 1c)
   * populates them retroactively; until then those broadcasts'
   * recovery is best-effort empty.
   */
  private async recoverRunningCanonical(): Promise<{
    runningCanonical: CanonicalState;
    lastEmittedContentMinute: string | null;
  }> {
    let state = emptyCanonicalState(this.phase);
    let lastEmittedContentMinute: string | null = null;
    let lastEmittedContentMinuteRank = -Infinity;
    try {
      const rows = await db
        .select({
          revealedCanonical: broadcastNarrations.revealedCanonical,
          revealingCanonical: broadcastNarrations.revealingCanonical,
        })
        .from(broadcastNarrations)
        .where(eq(broadcastNarrations.broadcastId, this.broadcastId))
        .orderBy(broadcastNarrations.synthesizedAt);
      let lastIllustration: CanonicalState["illustration"] = null;
      for (const row of rows) {
        if (row.revealingCanonical) {
          state = applyRevealingCanonical(state, row.revealingCanonical);
        }
        if (row.revealedCanonical?.illustration) {
          lastIllustration = row.revealedCanonical.illustration;
        }
        // Re-seed the monotonic floor from the highest contentMinute
        // ever emitted on this broadcast — not the latest by row
        // order, because the very bug this floor exists to prevent
        // means a regressed value could be at the tail. parseMatchTime
        // is the comparator: "45+2" > "45" > "44".
        const mm = row.revealedCanonical?.contentMinute;
        if (typeof mm === "string" && mm.length > 0) {
          const rank = parseMatchTime(mm);
          if (rank !== -Infinity && rank > lastEmittedContentMinuteRank) {
            lastEmittedContentMinuteRank = rank;
            lastEmittedContentMinute = mm;
          }
        }
      }
      // Illustration isn't a revealingCanonical channel (per Q1 c
      // — appears at audio-start without a marker). Re-seed it from
      // the latest persisted revealedCanonical so restart resumes
      // with the current image rather than blanking it.
      if (lastIllustration) {
        state = { ...state, illustration: lastIllustration };
      }
    } catch (err) {
      console.warn(
        `[conductor:${this.broadcastId}] running-canonical recovery failed; starting empty: ${(err as Error).message}`,
      );
    }
    return { runningCanonical: state, lastEmittedContentMinute };
  }

  /**
   * Route an imagery decision to the right side of the pipeline:
   *  - `generate`: kick Replicate; bytes land via `generateIllustration`.
   *  - `pool`: resolve the already-generated pool image via the
   *    illustrationId Blackout stashed on `consumerMetadata` when the
   *    studio pushed the item to Kairos; fire the cue directly.
   *  - `hold`: nothing — the previous image stays on screen.
   *
   * Deduped by narrativeId: whichever of the early `imagery_decision`
   * or the later `narrative.imagery` arrives first wins; the other is
   * a no-op.
   */
  private async handleImageryDecision(
    narrativeId: string,
    imagery: kairos.KairosNarrativeImagery,
  ): Promise<void> {
    if (this.stopped) return;
    if (this.imageryHandled.has(narrativeId)) return;
    this.imageryHandled.add(narrativeId);

    if (imagery.decision === "hold") return;

    if (imagery.decision === "pool") {
      await this.resolvePoolIllustration(narrativeId, imagery).catch((err) => {
        console.error(
          `[conductor:${this.broadcastId}] pool illustration resolve failed for ${narrativeId}: ${(err as Error).message}`,
        );
      });
      return;
    }

    if (imagery.decision === "generate" && imagery.prompt) {
      void this.generateIllustration(narrativeId, imagery.prompt);
      return;
    }
  }

  /**
   * Look up the illustration bytes for a pool-decision imagery by the
   * illustrationId Blackout stashed on `consumerMetadata` at accept
   * time, resolve a storage URL, and fan out the cue. Degrades to
   * telemetry-only on failure (previous image stays on screen).
   */
  private async resolvePoolIllustration(
    narrativeId: string,
    imagery: kairos.KairosNarrativeImagery,
  ): Promise<void> {
    const illustrationId =
      imagery.consumerMetadata && typeof imagery.consumerMetadata === "object"
        ? (imagery.consumerMetadata as { illustrationId?: unknown }).illustrationId
        : undefined;
    if (typeof illustrationId !== "string" || !illustrationId) {
      console.warn(
        `[conductor:${this.broadcastId}] pool decision missing illustrationId in consumerMetadata for ${narrativeId}`,
      );
      return;
    }

    const [row] = await db
      .select()
      .from(broadcastIllustrations)
      .where(eq(broadcastIllustrations.id, illustrationId))
      .limit(1);
    if (!row || !row.imageKey) {
      console.warn(
        `[conductor:${this.broadcastId}] pool illustration ${illustrationId} not found for ${narrativeId}`,
      );
      return;
    }

    const imageUrl = await getStorage().getPublicUrl(row.imageKey);
    this.fanOut({ type: "illustration", narrativeId, imageUrl });
    this.runningCanonical = {
      ...this.runningCanonical,
      illustration: { imageKey: row.imageKey, imageUrl },
    };
    this.patchPassageIllustration(narrativeId, row.imageKey, imageUrl);

    captureEvent({
      name: "illustration_pool_hit",
      broadcastId: this.broadcastId,
      properties: {
        "illustration.id": row.id,
        "illustration.narrativeId": narrativeId,
        "illustration.poolItemId": imagery.poolItemId ?? null,
      },
    });
  }

  /**
   * Generate an illustration for the given narrative via Replicate,
   * persist it to storage + DB, and fan out an `illustration` cue.
   * Fire-and-forget — runs parallel to TTS synthesis. Failures log +
   * PostHog, but don't disrupt playback; the matchroom just keeps
   * whatever image is currently displayed.
   */
  private async generateIllustration(
    narrativeId: string,
    prompt: string,
  ): Promise<void> {
    if (this.stopped) return;
    try {
      const image = await generateImage(prompt);
      if (this.stopped) return;

      const [row] = await db
        .insert(broadcastIllustrations)
        .values({
          broadcastId: this.broadcastId,
          narrativeId,
          prompt,
          imageKey: "",
          contentType: image.contentType,
          model: image.model,
          generationMs: image.generationMs,
        })
        .returning();

      const imageKey = `broadcasts/${this.broadcastId}/illustrations/${row.id}.webp`;
      await getStorage().put(imageKey, image.bytes, image.contentType);
      await db
        .update(broadcastIllustrations)
        .set({ imageKey })
        .where(eq(broadcastIllustrations.id, row.id));

      const imageUrl = await getStorage().getPublicUrl(imageKey);
      this.fanOut({ type: "illustration", narrativeId, imageUrl });
      this.runningCanonical = {
        ...this.runningCanonical,
        illustration: { imageKey, imageUrl },
      };
      this.patchPassageIllustration(narrativeId, imageKey, imageUrl);

      captureEvent({
        name: "illustration_generated",
        broadcastId: this.broadcastId,
        properties: {
          "illustration.id": row.id,
          "illustration.narrativeId": narrativeId,
          "illustration.generationMs": image.generationMs,
          "illustration.model": image.model,
          "illustration.bytes": image.bytes.byteLength,
        },
      });
    } catch (err) {
      console.error(
        `[conductor:${this.broadcastId}] illustration generation failed for narrative ${narrativeId}: ${(err as Error).message}`,
      );
      captureEvent({
        name: "illustration_failed",
        broadcastId: this.broadcastId,
        properties: {
          "illustration.narrativeId": narrativeId,
          "illustration.error": (err as Error).message.slice(0, 200),
        },
      });
    }
  }

  private async resolveTtsVoice(): Promise<{
    provider: TtsProvider;
    voiceId: string;
    speed: number | undefined;
  }> {
    if (!this.broadcast.ttsVoiceId) {
      throw new Error(
        `Broadcast ${this.broadcastId} has no TTS voice set. Assign one before activating.`,
      );
    }
    const record = await getTtsVoice(this.broadcast.ttsVoiceId);
    if (!record) {
      throw new Error(
        `TTS voice ${this.broadcast.ttsVoiceId} on broadcast ${this.broadcastId} no longer exists in the catalogue.`,
      );
    }
    return {
      provider: record.provider as TtsProvider,
      voiceId: record.providerVoiceId,
      speed: record.speed ?? undefined,
    };
  }

  private async drainSynthesisQueue(): Promise<void> {
    if (this.synthesising) return;
    this.synthesising = true;
    try {
      while (this.narrativeQueue.length > 0 && !this.stopped) {
        const narrative = this.narrativeQueue.shift()!;
        try {
          const { provider, voiceId, speed } = await this.resolveTtsVoice();
          if (!provider || !voiceId) {
            throw new Error(
              `Cannot synthesise narration for broadcast ${this.broadcastId}: ` +
                `no voice configured on the broadcast and no default voice in the ` +
                `TTS catalogue. Add a voice at /admin/tts-voices or set one on ` +
                `this broadcast via PATCH /broadcasts/:id.`,
            );
          }
          const synthStart = Date.now();
          const narration = await synthesiseNarration({
            broadcastId: this.broadcastId,
            narrativeId: narrative.narrativeId,
            text: narrative.text,
            provider,
            voiceId,
            speed,
            batchEntryIds: narrative.batchEntryIds,
            covers: narrative.covers ?? [],
            contentTime: narrative.contentTime,
            revealedCanonical: narrative.revealedCanonical,
            revealingCanonical: narrative.revealingCanonical,
          });
          captureEvent({
            name: "narration_synthesised",
            broadcastId: this.broadcastId,
            properties: {
              "narration.id": narration.id,
              "narration.narrativeId": narration.narrativeId,
              "narration.wordCount": narration.wordCount,
              "narration.audioDurationMs": narration.durationMs,
              "narration.synthesisMs": Date.now() - synthStart,
              "narration.provider": narration.provider,
              "narration.voiceId": narration.voiceId,
            },
          });
          // Sub-piece 4a — emit `passage_audio_ready` once synthesis
          // succeeds. Patches the in-memory passage with audio +
          // narrationId so subsequent cues (`passage_started`,
          // `connected.currentPassage`) carry the same shape.
          const audioUrl = await getStorage().getPublicUrl(narration.audioKey);
          const passage = this.passages.get(narrative.narrativeId);
          if (passage) {
            passage.audio = { url: audioUrl, durationMs: narration.durationMs };
            passage.narrationId = narration.id;
          }
          this.fanOut({
            type: "passage_audio_ready",
            narrativeId: narrative.narrativeId,
            narrationId: narration.id,
            audio: { url: audioUrl, durationMs: narration.durationMs },
          });
          await this.onNarrationReady(narration);
        } catch (err) {
          console.error(
            `[conductor:${this.broadcastId}] synthesis failed for narrative ${narrative.narrativeId}:`,
            (err as Error).message,
          );
          // Sub-piece 4a — emit `passage_skipped` so the matchroom
          // can drop the passage from its local set. Conductor's
          // running canonical state has already advanced (folded the
          // revealing forward at compose time), so reveals are not
          // lost — the next passage's revealedCanonical absorbs them.
          this.passages.delete(narrative.narrativeId);
          this.fanOut({
            type: "passage_skipped",
            narrativeId: narrative.narrativeId,
            reason: (err as Error).message.slice(0, 200),
          });
        }
      }
    } finally {
      this.synthesising = false;
    }
  }

  private async onNarrationReady(narration: NarrationRecord): Promise<void> {
    if (this.stopped) return;
    if (!this.currentlyPlaying) {
      await this.startPlayback(narration);
    } else {
      this.readyQueue.push(narration);
      await this.sendPreload(narration);
    }
  }

  private async startPlayback(narration: NarrationRecord): Promise<void> {
    const now = new Date();
    narration.playbackStartedAt = now;
    this.currentlyPlaying = narration;

    // Persist the start time so a server restart can still know when
    // this clip was playing (useful for replay / forensics).
    await db
      .update(broadcastNarrations)
      .set({ playbackStartedAt: now })
      .where(eq(broadcastNarrations.id, narration.id));

    const audioUrl = await getStorage().getPublicUrl(narration.audioKey);
    this.fanOut({
      type: "play",
      narrationId: narration.id,
      narrativeId: narration.narrativeId,
      text: narration.text,
      wordCount: narration.wordCount,
      audioUrl,
      durationMs: narration.durationMs,
      playbackStartedAt: now.getTime(),
      serverNow: Date.now(),
      batchEntryIds: narration.batchEntryIds,
      contentTime: narration.contentTime,
    });

    // Sub-piece 4a — emit `passage_started` alongside the legacy
    // `play` cue. Patches the in-memory passage with playback so
    // late-joiner snapshots (Sub-piece 4b's `connected.currentPassage`)
    // carry the correct anchor.
    const passage = this.passages.get(narration.narrativeId);
    if (passage) {
      passage.playback = { startedAt: now.getTime(), serverNow: Date.now() };
    }
    this.fanOut({
      type: "passage_started",
      narrativeId: narration.narrativeId,
      narrationId: narration.id,
      audio: { url: audioUrl, durationMs: narration.durationMs },
      playback: { startedAt: now.getTime(), serverNow: Date.now() },
    });
    captureEvent({
      name: "narration_play_started",
      broadcastId: this.broadcastId,
      properties: {
        "narration.id": narration.id,
        "narration.narrativeId": narration.narrativeId,
        "narration.durationMs": narration.durationMs,
        "narration.wordCount": narration.wordCount,
        "connectedClients": this.clients.size,
      },
    });

    this.playbackTimer = setTimeout(() => {
      this.onClipEnd(narration).catch((err) =>
        console.error(`[conductor:${this.broadcastId}] clip-end error:`, err),
      );
    }, narration.durationMs + INTER_CLIP_GAP_MS);
  }

  private async onClipEnd(finished: NarrationRecord): Promise<void> {
    this.playbackTimer = null;
    this.currentlyPlaying = null;

    // Pacing report — fire-and-forget, don't let a Kairos hiccup stall
    // the playback loop.
    const playbackSeconds = finished.durationMs / 1000;
    reportPacing(this.broadcastId, finished.wordCount, playbackSeconds).catch(
      (err) =>
        console.warn(
          `[conductor:${this.broadcastId}] pacing report failed: ${(err as Error).message}`,
        ),
    );

    // Full-time closing passage just finished playing — we've said our
    // final word. The pure decider in phase-logic decides between
    // advancing the queue, completing the broadcast, or suppressing
    // a too-early auto-complete (the 2026-04-22 Burnley-City glitch
    // that flipped a live broadcast to complete from what appears to
    // be a transient Sportmonks state blip). The conductor side just
    // applies the outcome.
    const closingDeadlineMs =
      this.fullTimeObservedAtMs !== null
        ? this.fullTimeObservedAtMs + CLOSING_DEADLINE_MS
        : null;
    const action = decideClipEndAction({
      phase: this.phase,
      readyQueueEmpty: this.readyQueue.length === 0,
      matchStartMs: new Date(this.broadcast.matchDate).getTime(),
      nowMs: Date.now(),
      closingDeadlineMs,
      inFlightWork: this.narrativeQueue.length > 0 || this.synthesising,
    });

    if (action.type === "wait_for_closing_passage") {
      const remainingMs = Math.max(0, action.deadlineMs - Date.now());
      console.log(
        `[conductor:${this.broadcastId}] clip ended in winddown — holding for closing roundtrip (deadline in ${remainingMs}ms, in-flight=${this.narrativeQueue.length > 0 || this.synthesising})`,
      );
      return;
    }

    if (action.type === "suppress_winddown_complete") {
      console.warn(
        `[conductor:${this.broadcastId}] winddown → complete suppressed — match is only ${action.elapsedMinutes.toFixed(1)} min old. Probable stale phase state. Leaving phase at winddown; next legitimate winddown clip will complete.`,
      );
      captureEvent({
        name: "winddown_complete_suppressed",
        broadcastId: this.broadcastId,
        properties: {
          "match.elapsedMinutes": Math.round(action.elapsedMinutes * 10) / 10,
          "match.matchDate": this.broadcast.matchDate,
        },
      });
      return;
    }

    if (action.type === "complete_broadcast") {
      this.transitionTo("complete");
      try {
        const { completeBroadcast } = await import("../lib/kairos-bridge.js");
        await completeBroadcast(this.broadcastId);
      } catch (err) {
        console.warn(
          `[conductor:${this.broadcastId}] winddown → complete failed: ${(err as Error).message}`,
        );
      }
      return;
    }

    // action.type === "advance_queue"
    const next = this.readyQueue.shift();
    if (next && !this.stopped) {
      await this.startPlayback(next);
    }
    // else: gap until the next narrative arrives + synthesises.
  }

  private async sendPreload(narration: NarrationRecord): Promise<void> {
    const audioUrl = await getStorage().getPublicUrl(narration.audioKey);
    const cue: PreloadCue = {
      type: "preload",
      narrationId: narration.id,
      narrativeId: narration.narrativeId,
      audioUrl,
      durationMs: narration.durationMs,
    };
    // preload carries no batchEntryIds — reveal still happens on the
    // eventual `play` cue's audio-end, driven by the richer play payload.
    this.fanOut(cue);
  }

  /**
   * Fan out an externally-produced cue to every subscribed client. Used
   * by the broadcast runner for runner-side observations (currently
   * only `latency_sample`) that need to reach the moderator UI but
   * don't originate from the Kairos feed subscription. Matchroom
   * transforms drop non-`feed_entry` cues that aren't part of the
   * playback contract, so admin-only cues are naturally hidden from
   * viewers without per-cue suppression here.
   */
  broadcastCue(cue: LatencySampleCue): void {
    this.fanOut(cue);
  }

  /**
   * Patch a passage's revealedCanonical.illustration in-place when a
   * late-arriving image lands AFTER the passage was added. Emits
   * `passage_updated` so the matchroom can swap the image
   * mid-passage. The legacy `illustration` cue still fires alongside
   * (matchroom uses that path until Sub-piece 4c retires it).
   */
  private patchPassageIllustration(
    narrativeId: string,
    imageKey: string,
    imageUrl: string,
  ): void {
    const passage = this.passages.get(narrativeId);
    if (!passage) return;
    passage.revealedCanonical = {
      ...passage.revealedCanonical,
      illustration: { imageKey, imageUrl },
    };
    this.fanOut({
      type: "passage_updated",
      narrativeId,
      patch: { revealedCanonical: { illustration: { imageKey, imageUrl } } },
    });
  }

  /** Fan out to every subscribed client. Drops any client with a closed socket. */
  private fanOut(cue: ConductorCue): void {
    for (const entry of this.clients) {
      this.sendToClient(entry, cue);
    }
  }

  private sendToClient(entry: ClientEntry, cue: unknown): void {
    const payload = entry.transform ? entry.transform(cue) : cue;
    if (payload === null || payload === undefined) return;
    try {
      entry.ws.send(
        typeof payload === "string" ? payload : JSON.stringify(payload),
      );
    } catch {
      this.clients.delete(entry);
    }
  }
}

interface ClientEntry {
  ws: WsWebSocket;
  transform?: (cue: unknown) => unknown | null;
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}
