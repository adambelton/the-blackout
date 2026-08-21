import type { RadioSource, TeamSide } from "@blackout/shared";
import { assertLiveBroadcastEnv } from "../env.js";
import { stopRunnerIdsForShutdown } from "./runner-shutdown.js";
import * as kairos from "./kairos.js";
import { SOURCE, activateBroadcast, completeBroadcast } from "./kairos-bridge.js";
import { getBroadcast } from "./broadcasts.js";
import { getSourceById, recordObservation } from "./radio-sources.js";
import { SportmonksEventSource } from "../sources/sportmonks.js";
import { getRoomConductor } from "../conductor/index.js";
import { TRANSITION_FOR_PHASE } from "../conductor/phase-logic.js";
import type { BroadcastPhase } from "../conductor/types.js";
import { getRoster, getRosterDetails } from "./roster-registry.js";
import { normaliseTranscript, normalisePlayerName } from "./name-normalise.js";
import { TranscriptionPipeline } from "../pipeline/transcription.js";
import { PressurePipeline, type PressureSignal } from "../pipeline/pressure.js";
import {
  resolveCanonical,
  pruneExpired,
  findCanonicalForLateArrival,
  surnameKey,
  teamKey,
  type CanonicalEventEntry,
  type EventClass,
  type PendingClaim,
  type PendingTexture,
} from "./event-correlation.js";
import { ingestCanonicalEvent as runIngestCanonicalEvent } from "./canonical-event-ingest.js";
import { CommentaryDistillationBuffer } from "./distillation-buffer.js";
import type { AtmosphereOutput, EventClaimOutput, EventTextureOutput } from "./distiller.js";
import { applyCalibrationSample } from "./broadcast-subject-offset.js";
import { buildCanonicalLedgerSeed } from "./canonical-ledger-seed.js";
import { captureEvent } from "./telemetry.js";
import { randomUUID } from "node:crypto";

/** How many canonical events the distiller's recent-events context
 * block carries. Recent enough to keep the model from re-extracting
 * the same texture across overlapping chunks; bounded so the
 * cached prompt prefix stays cheap. */
const DISTILLER_RECENT_EVENTS_LIMIT = 8;

/** Periodic sweep cadence to release expired pending texture and
 * prune dead claims. Runs alongside the lifecycle watchdog. */
const CORRELATION_PRUNE_INTERVAL_MS = 30_000;

// Effective-offset constants and update helper live in
// `./effective-offset.ts` so the unit tests can import the formula
// without dragging in the runner's full dependency graph.

/**
 * The live broadcast runner — the thing that actually runs the sources
 * for a live broadcast. Drives the same source pipeline the moderator
 * WebSocket drives (Sportmonks polling, Deepgram transcription,
 * pressure derivation), but without a moderator client round-trip.
 *
 * Lifecycle is owned by `activateBroadcast` / `completeBroadcast` in
 * kairos-bridge: activation starts the runner, completion stops it.
 * The runner is not "automatic" — "activation" is the user action.
 * (Renamed from `AutoBroadcastRunner` on 2026-04-22; the old name
 * misleadingly implied optional/automated behaviour when in fact the
 * runner is the broadcast.)
 *
 * Registry API for operator debugging and lifecycle hooks:
 *   startBroadcastRunner(id)         — only called from activateBroadcast
 *   stopBroadcastRunner(id, opts)    — only called from completeBroadcast
 *                                      or the lifecycle watchdog
 *   getBroadcastRunnerStatus(id)     — inspect a running runner
 *   isBroadcastRunnerActive(id)      — registry membership check
 *
 * One runner per broadcastId. Restarting is a stop+start, not a
 * restart in place. Keeps the runner logic dead simple.
 */

// --- Registry ------------------------------------------------------------

const runners = new Map<string, BroadcastRunner>();

export function getBroadcastRunnerStatus(broadcastId: string): BroadcastRunnerStatus | null {
  const runner = runners.get(broadcastId);
  return runner ? runner.status() : null;
}

export function isBroadcastRunnerActive(broadcastId: string): boolean {
  return runners.has(broadcastId);
}

export async function startBroadcastRunner(broadcastId: string): Promise<BroadcastRunnerStatus> {
  if (runners.has(broadcastId)) {
    throw new Error(`Broadcast runner already running for ${broadcastId}`);
  }

  const runner = new BroadcastRunner(broadcastId);
  runners.set(broadcastId, runner);
  try {
    await runner.start();
  } catch (err) {
    runners.delete(broadcastId);
    throw err;
  }
  return runner.status();
}

/**
 * Stop the broadcast runner.
 *
 * `completeBroadcast` controls whether stopping the runner should also
 * flip the broadcast to `complete`. Defaults to `true` for operator
 * flows (watchdog, explicit "end broadcast now"). Callers *already*
 * inside the `completeBroadcast` chain pass `false` to avoid infinite
 * recursion through runner.stop → completeBroadcast → stopBroadcastRunner
 * → runner.stop.
 */
export async function stopBroadcastRunner(
  broadcastId: string,
  opts: { completeBroadcast?: boolean } = {},
): Promise<BroadcastRunnerStatus | null> {
  const runner = runners.get(broadcastId);
  if (!runner) return null;
  await runner.stop({ completeBroadcast: opts.completeBroadcast ?? true });
  runners.delete(broadcastId);
  return runner.status();
}

/**
 * Route a moderator-typed message into the runner's source pipeline.
 * Goes through the same `pushEntry` path as Sportmonks events and
 * transcription so the moderator's note gets the same phase anchoring,
 * conductor gate, and subjectTime offset (radio-anchored — moderators
 * react to what they JUST HEARD on the radio, not to wall-clock now).
 *
 * Returns false if no runner is active for this broadcast — caller
 * should surface "broadcast not live" to the moderator UI.
 */
export function pushModeratorMessageToRunner(
  broadcastId: string,
  text: string,
): boolean {
  const runner = runners.get(broadcastId);
  if (!runner) return false;
  runner.pushModeratorMessage(text);
  return true;
}

/**
 * Forward a binary audio chunk from the moderator's browser into the
 * runner's transcription pipeline. Returns false if no runner is
 * active — the moderator WS handler should drop the chunk silently in
 * that case (capture races activation; the first few hundred ms of
 * audio after pre-arming are expected to land before the runner is
 * registered).
 */
export function pushAudioChunkToRunner(
  broadcastId: string,
  chunk: Buffer,
): boolean {
  const runner = runners.get(broadcastId);
  if (!runner) return false;
  runner.pushAudioChunk(chunk);
  return true;
}

export async function stopAllBroadcastRunners(): Promise<void> {
  // Process shutdown — never mark the broadcast complete on its way
  // out. tsx watch restarts, SIGTERM during deploys, and graceful
  // shutdowns are *not* match-end signals; completion belongs to the
  // moderator's explicit action or the conductor's auto-complete on
  // full-time. Without `completeBroadcast: false` here, every restart
  // flips a live broadcast to `status: complete` and tells Kairos to
  // close its runtime — exactly the bug that bit the 2026-04-26 FA Cup
  // semi-final mid-broadcast. Helper extracted to `runner-shutdown.ts`
  // so the contract is unit-testable without the DB-bound module chain.
  await stopRunnerIdsForShutdown(Array.from(runners.keys()), stopBroadcastRunner);
}

// --- Runner --------------------------------------------------------------

export interface BroadcastRunnerStatus {
  broadcastId: string;
  kairosBroadcastId: string | null;
  startedAt: number;
  fixtureId: number | null;
  radioSourceName: string | null;
  stoppedAt: number | null;
  lastError: string | null;
}

class BroadcastRunner {
  private events = new SportmonksEventSource();
  private pressure = new PressurePipeline();
  private transcription: TranscriptionPipeline | null = null;
  private kairosBroadcastId: string | null = null;
  private fixtureId: number | null = null;
  private radioSource: RadioSource | null = null;
  private startedAt = Date.now();
  private stoppedAt: number | null = null;
  private lastError: string | null = null;
  private statusCheckTimer: ReturnType<typeof setInterval> | null = null;
  private correlationPruneTimer: ReturnType<typeof setInterval> | null = null;

  /** Three ledgers driving commentary-↔-canonical correlation. The
   * runner ingests Sportmonks events into `canonicalLedger`, the
   * distiller's outputs into `pendingClaims` / `pendingTextures`.
   * `event-correlation.ts::resolveCanonical` runs the matching when a
   * canonical lands; `pruneExpired` runs periodically. */
  private canonicalLedger: CanonicalEventEntry[] = [];
  private pendingClaims: PendingClaim[] = [];
  private pendingTextures: PendingTexture[] = [];

  /** Distillation pipeline. Buffers transcription, flushes every 12s
   * or reactively before each canonical event, routes the three output
   * classes via the callbacks installed in start(). */
  private distillationBuffer: CommentaryDistillationBuffer | null = null;

  /** Effective audio→canonical offset in seconds. Seeded from the
   * radio source's `defaultOffsetSeconds` at start(); updated on every
   * matched calibration sample via EWMA in `emitCalibrationSample`.
   * Subtracted from utterance wall-clocks (and moderator note times)
   * before they reach Kairos, so subjectTime tracks the real match
   * moment rather than the stream's late-by-seconds replay of it.
   * Read dynamically inside callback closures — do not capture. */
  private effectiveOffsetSeconds = 0;

  constructor(private broadcastId: string) {}

  async start(): Promise<void> {
    const broadcast = await getBroadcast(this.broadcastId);
    if (!broadcast) throw new Error(`Broadcast ${this.broadcastId} not found`);
    if (!broadcast.fixtureId) {
      throw new Error("Broadcast has no fixtureId — Sportmonks polling can't start");
    }
    if (!broadcast.radioSourceId) {
      throw new Error("Broadcast has no radioSourceId — set one in the studio before activating");
    }
    // Live-broadcast env vars are validated centrally in `env.ts`.
    // The runner still reads `DEEPGRAM_API_KEY` directly because the
    // transcription pipeline takes the value as an arg; the validator
    // guarantees it's present.
    assertLiveBroadcastEnv();
    const apiKey = process.env.DEEPGRAM_API_KEY!;

    const radioSource = await getSourceById(broadcast.radioSourceId);
    if (!radioSource) throw new Error(`Radio source ${broadcast.radioSourceId} not found`);
    this.radioSource = radioSource;
    this.fixtureId = broadcast.fixtureId;
    // Seed the effective offset from the radio source's configured
    // default. Calibration samples will refine it during the broadcast.
    this.effectiveOffsetSeconds = radioSource.defaultOffsetSeconds;

    // Activate both sides — Kairos seeds voice/context and flips to active,
    // Blackout flips to live. Throws if the author brief is empty (Kairos
    // rejects activation without narrative_voice content).
    const activated = await activateBroadcast(this.broadcastId);
    this.kairosBroadcastId = activated.kairosBroadcastId ?? null;
    if (!this.kairosBroadcastId) {
      throw new Error("Activation didn't populate kairosBroadcastId");
    }

    const broadcastId = this.broadcastId;

    // --- Distillation buffer --------------------------------------------
    // Sits between Deepgram and Kairos. Raw transcription utterances
    // accumulate here and flush through the distiller (12s timer or
    // reactively before canonical events). The narrator sees only the
    // distillation's structured output — atmosphere + event_texture
    // pushed to the match_action source — never the raw commentary.
    this.distillationBuffer = new CommentaryDistillationBuffer(
      {
        onAtmosphere: (output, observedAtMs) => this.handleAtmosphere(output, observedAtMs),
        onEventTexture: (output, observedAtMs) => this.handleEventTexture(output, observedAtMs),
        onEventClaim: (output, observedAtMs) => this.handleEventClaim(output, observedAtMs),
      },
      {
        getRecentCanonicalEvents: () =>
          this.canonicalLedger
            .slice(-DISTILLER_RECENT_EVENTS_LIMIT)
            .map((c) => `${c.eventClass}${c.playerLastName ? ` (${c.playerLastName})` : ""} @${c.subjectTime}`),
        getContentTimeAnchor: () => this.events.getSubjectTime() || null,
        getRosters: () => {
          const details = getRosterDetails(this.broadcastId);
          return {
            home: details?.homeRoster ?? [],
            away: details?.awayRoster ?? [],
            homeTeamName: details?.homeTeamName,
            awayTeamName: details?.awayTeamName,
          };
        },
      },
    );

    // --- Transcription --------------------------------------------------
    // Effective offset is read fresh on every utterance so calibration
    // updates take effect within the broadcast — capturing it once at
    // closure construction would freeze the seed value.
    this.transcription = new TranscriptionPipeline(apiKey, {
      onTranscript: ({ text, utteranceEndWallClock }) => {
        const anchorMs = utteranceEndWallClock - this.effectiveOffsetSeconds * 1000;
        // Normalise ASR garbles against the canonical roster before
        // the text reaches the distiller. No-op when the roster is
        // empty (pre-lineup-publication activations).
        const roster = getRoster(this.broadcastId);
        const normalised = normaliseTranscript(text, roster);
        // Forensic trail. Raw + normalised transcript lines are
        // ephemeral — the distillation buffer flushes them through
        // Haiku and discards them, and Kairos no longer sees the raw
        // text at all. Log here so the dev.log + production log
        // capture the input the distiller actually receives. Surfaced
        // during the 2026-04-26 FA Cup SF retro: when the distiller
        // emitted suspicious player names ("Euler Brand", "Vogel"), we
        // had no way to verify whether Deepgram had mis-heard or
        // Haiku had reached. The next live test will have a record.
        if (text !== normalised) {
          console.log(
            `[transcript:${this.broadcastId}] raw="${text}" → normalised="${normalised}" @${this.events.getSubjectTime() || "(no clock)"}`,
          );
        } else {
          console.log(
            `[transcript:${this.broadcastId}] "${text}" @${this.events.getSubjectTime() || "(no clock)"}`,
          );
        }
        // Buffer for distillation. Raw transcription no longer lands
        // on Kairos directly — it goes through the distiller, which
        // emits structured atmosphere / event_texture / event_claim
        // outputs that the runner routes onward. Calibration that
        // used to come from name-matching transcription against
        // recent goals (`correlateLatencySample`) now comes from the
        // distiller's event_claim outputs and works for every event
        // class, not just goals.
        this.distillationBuffer?.add(normalised, anchorMs);
      },
      onStatus: (status, message) => {
        if (status === "error") {
          this.lastError = message ?? "transcription error";
          console.error(`[broadcast-runner:${this.broadcastId}] transcription error: ${message}`);
        } else if (status === "streaming") {
          // Self-healing: once the stream is flowing again, clear any
          // prior error so the broadcasts-page indicator flips back to
          // green on the next 60s poll. Otherwise a transient drop stays
          // visible as an amber warning for the rest of the match.
          if (this.lastError) {
            console.log(
              `[broadcast-runner:${this.broadcastId}] transcription recovered — clearing lastError`,
            );
            this.lastError = null;
          }
        }
      },
    });
    await this.transcription.start();
    console.log(
      `[broadcast-runner:${this.broadcastId}] transcription armed for ${radioSource.name} (browser-capture mode, offset ${radioSource.defaultOffsetSeconds}s)`,
    );

    // --- Pressure -> match_pressure -------------------------------------
    // Pressure signals are contextual; they live on their own source so
    // the canonical flag on match_events only applies to real events
    // (goals, cards, subs). See kairos-bridge SOURCE comments.
    const emitPressureSignal = (signal: PressureSignal) => {
      const subjectTime = signal.subjectTime ?? this.events.getSubjectTime();
      const data = toPressureEventData(signal, subjectTime);
      if (!data) return;
      this.pushEntry(SOURCE.matchPressure, data, signal.wallClockMs);
    };

    const ingestStat = (data: Record<string, unknown>) => {
      this.pressure.setPeriod({ countsFrom: this.events.getCountsFrom() });

      if (data.kind === "ball_position") {
        if (typeof data.x !== "number" || typeof data.y !== "number") return;
        this.pressure.ingestBallPosition({
          x: data.x,
          y: data.y,
          minute: typeof data.minute === "number" ? data.minute : null,
          subjectTime: typeof data.subjectTime === "string" ? data.subjectTime : null,
          wallClockMs: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
        });
        return;
      }

      if (data.kind === "trend") {
        if (typeof data.value !== "number" || typeof data.statCode !== "string") return;
        const team = data.team as { side?: TeamSide; name?: string } | null | undefined;
        if (!team?.side) return;
        this.pressure.ingestTrend({
          team: { side: team.side, name: team.name },
          statName: data.statCode,
          value: data.value,
          minute: typeof data.minute === "number" ? data.minute : null,
          subjectTime: typeof data.subjectTime === "string" ? data.subjectTime : null,
        });
      }
    };

    this.pressure.start(emitPressureSignal);

    // --- Events ---------------------------------------------------------
    this.events.start({
      onEvent: (data) => {
        // Fire and forget — sportmonks.ts's onEvent contract is sync;
        // we run the async ingest in the background and let any errors
        // surface via the catch.
        void this.ingestCanonicalEvent(data).catch((err) =>
          console.error(
            `[broadcast-runner:${this.broadcastId}] canonical event ingest failed: ${(err as Error).message}`,
          ),
        );
      },
      onStat: (data) => ingestStat(data),
      onError: (msg) =>
        console.error(`[broadcast-runner:${this.broadcastId}] sportmonks error: ${msg}`),
      onKickoff: () => this.handlePhaseWhistle("live_first_half"),
      onHalftime: () => this.handlePhaseWhistle("halftime"),
      onSecondHalfKickoff: () => this.handlePhaseWhistle("live_second_half"),
      onFulltime: () => this.handlePhaseWhistle("full_time_winddown"),
    });
    // Reseed the events adapter's dedup state from whatever Kairos
    // already has for this broadcast. Without this, every fresh
    // runner re-pushes every Sportmonks event the adapter sees on
    // its first poll — produced 38 GOAL entries for a 2-goal match
    // across 4 restarts during the 2026-05-02 Ipswich-QPR test.
    //
    // Same fetch also seeds the canonicalLedger — without it, every
    // restart leaves the correlator empty, so commentary's KICKOFF /
    // GOAL claims keep expiring without canonical match (the
    // "[correlation] N claim(s) expired" log spam from the live
    // tests). Seeding restores the historical canonical events so
    // late-arriving commentary about old events can still
    // calibration-sample on them.
    try {
      const existing = await kairos.listBroadcastEntries(this.kairosBroadcastId, {
        source: SOURCE.matchEvents,
      });
      const existingRecords = existing.map((e) => e as Record<string, unknown>);
      this.events.seedFromExistingEntries(existingRecords);
      this.seedCanonicalLedgerFromExistingEntries(existingRecords);
    } catch (err) {
      console.warn(
        `[broadcast-runner:${this.broadcastId}] dedup reseed failed: ${(err as Error).message} — first poll will re-push everything`,
      );
    }

    await this.events.startPolling(this.fixtureId);
    console.log(
      `[broadcast-runner:${this.broadcastId}] polling fixture ${this.fixtureId}`,
    );

    // --- Lifecycle watchdog ---------------------------------------------
    // If the broadcast is flipped to `complete` externally (e.g. the user
    // marks it done via the moderator page or API), stop the sources.
    // Poll once a minute; cheap, and matches live-broadcast lifespan.
    this.statusCheckTimer = setInterval(() => {
      this.checkBroadcastLifecycle().catch((err) =>
        console.error(`[broadcast-runner:${this.broadcastId}] lifecycle check failed: ${(err as Error).message}`),
      );
    }, 60_000);

    // --- Correlation prune ----------------------------------------------
    // Sweep the correlation ledgers periodically: release pending
    // textures that aged out (push as standalone match_action), drop
    // pending claims that never matched (no-match telemetry), and
    // clear canonical entries that fell out of the longest window.
    this.correlationPruneTimer = setInterval(() => {
      this.runCorrelationPrune();
    }, CORRELATION_PRUNE_INTERVAL_MS);
  }

  /**
   * Push a source entry to Kairos with the runner's phase anchor stamped
   * onto the data. Mirrors what the moderator WS used to do — the
   * conductor's phase gate is consulted so non-ambient sources are
   * suppressed in quiet phases (warming, halftime, full_time_winddown).
   *
   * `atWallClockMs` lets historical-anchored entries (radio utterance
   * that ended N seconds ago) reflect the true match moment rather than
   * the moment of the push.
   */
  private pushEntry(
    source: string,
    data: Record<string, unknown>,
    atWallClockMs?: number,
  ): void {
    if (!this.kairosBroadcastId) return;
    const anchor = this.events.getSubjectPhaseAnchor(atWallClockMs);
    // subjectTime fallback: when the caller hasn't put one on the
    // data object (atmosphere + event_texture from the distiller
    // come through this path), derive it from the supplied wall-clock
    // anchor. Without this fallback distilled match_action entries
    // arrive at Kairos minute-less and the matchroom feed renders
    // them without a clock marker. Sportmonks events + moderator
    // notes already carry their own subjectTime; the spread keeps
    // those preserved.
    const dataContentTime =
      typeof data.subjectTime === "string" && data.subjectTime.length > 0
        ? data.subjectTime
        : null;
    const derivedContentTime =
      dataContentTime ?? this.events.getSubjectTime(atWallClockMs) ?? null;
    const stamped: Record<string, unknown> = {
      ...data,
      ...(derivedContentTime ? { subjectTime: derivedContentTime } : {}),
      phase: anchor.phase,
      ...(anchor.phaseSecond != null ? { phaseSecond: anchor.phaseSecond } : {}),
    };
    const conductor = getRoomConductor(this.broadcastId);
    if (conductor && !conductor.canPushFromSource(source, stamped)) return;
    kairos.pushEntry(this.kairosBroadcastId, { source, data: stamped }).catch((err) => {
      console.error(
        `[broadcast-runner:${this.broadcastId}] push to ${source} failed: ${(err as Error).message}`,
      );
    });
  }

  /**
   * Push a moderator-typed note. Anchored on `now - effective_offset` so
   * the stamped subjectTime matches the real match moment the moderator
   * was reacting to (they're typing in response to what they just heard
   * on the radio, which is itself offset-corrected). The effective
   * offset is the calibration-tuned value, not the static seed —
   * moderator notes ride the same correction as transcription. Normalised
   * against the roster so typos and short-form references resolve to
   * canonical spellings before Kairos sees them.
   */
  pushModeratorMessage(text: string): void {
    const anchorMs = Date.now() - this.effectiveOffsetSeconds * 1000;
    const subjectTime = this.events.getSubjectTime(anchorMs);
    const roster = getRoster(this.broadcastId);
    const normalised = normaliseTranscript(text, roster);
    this.pushEntry(
      SOURCE.moderator,
      { content: normalised, subjectTime },
      anchorMs,
    );
  }

  /**
   * Forward an audio chunk from the moderator's browser to the
   * Deepgram pipe. Called by the moderator WS handler when a binary
   * frame arrives. No-op until the transcription pipeline has been
   * armed (between activation and the first chunk arriving the
   * pipeline is open but has no audio); the pipeline itself handles
   * the post-stop / pre-open races.
   */
  pushAudioChunk(chunk: Buffer): void {
    this.transcription?.pushAudioChunk(chunk);
  }

  /**
   * Normalise any name-bearing fields on a Sportmonks event payload
   * against the roster before the entry is pushed to Kairos. Content
   * text is run through the token-level normaliser (catches garbles in
   * the formatted summary); the structured `player` and
   * `relatedPlayer` fields are reconciled to the canonical full-name
   * form so enrichment services see stable subject ids across events
   * and lineups.
   */
  private normaliseEventNames(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    const roster = getRoster(this.broadcastId);
    if (roster.length === 0) return data;

    const out: Record<string, unknown> = { ...data };
    if (typeof out.content === "string" && out.content.length > 0) {
      out.content = normaliseTranscript(out.content, roster);
    }
    if (typeof out.player === "string" && out.player.length > 0) {
      out.player = normalisePlayerName(out.player, roster);
    }
    if (typeof out.relatedPlayer === "string" && out.relatedPlayer.length > 0) {
      out.relatedPlayer = normalisePlayerName(out.relatedPlayer, roster);
    }
    return out;
  }

  /**
   * Sportmonks event arrived. Thin wrapper around the pure orchestrator
   * in `canonical-event-ingest.ts` — the orchestration contract
   * (flush distiller → build canonical → resolve → release textures →
   * emit calibration → push canonical) is pinned by tests over there;
   * this method just wires the runner's mutable state and dependencies
   * into it.
   */
  private async ingestCanonicalEvent(data: Record<string, unknown>): Promise<void> {
    const next = await runIngestCanonicalEvent(
      data,
      {
        canonicalLedger: this.canonicalLedger,
        pendingClaims: this.pendingClaims,
        pendingTextures: this.pendingTextures,
      },
      {
        flushDistiller: async () => {
          if (this.distillationBuffer) await this.distillationBuffer.flush();
        },
        buildCanonical: (d, ec) => this.buildCanonicalEntry(d, ec),
        pushEntry: (source, d, atMs) => this.pushEntry(source, d, atMs),
        emitCalibrationSample: (args) => this.emitCalibrationSample(args),
        normaliseEventNames: (d) => this.normaliseEventNames(d),
      },
    );
    this.canonicalLedger = next.canonicalLedger;
    this.pendingClaims = next.pendingClaims;
    this.pendingTextures = next.pendingTextures;
  }

  /** Sportmonks observed a phase whistle (KICKOFF / HALFTIME /
   * SECOND_HALF_KICKOFF / FULL_TIME). The runner is the single emitter
   * of synthetic phase-transition match_events entries: it pushes the
   * entry to Kairos (the conductor picks the transition up via its
   * normal feed subscription, same code path as replay) and mirrors
   * the same observation into the local correlator so commentary
   * claims for the whistle can match against it. */
  private handlePhaseWhistle(phase: BroadcastPhase): void {
    const transition = TRANSITION_FOR_PHASE[phase];
    if (!transition) return;

    // B1 fix (audit 2026-05-10): for stoppage-bearing transitions
    // (HALFTIME, FULL_TIME) the static map entry is the regular-time
    // floor (`"45"` / `"90"`); the actual subject time at the whistle
    // can be `"45+2"`, `"90+5"`, etc. Use the live subject-time
    // estimate when available so the entry's `subjectTime` reflects
    // the real moment the whistle blew. KICKOFF / SECOND_HALF_KICKOFF
    // keep the static literal — pre-kickoff timing isn't meaningful.
    const liveSubjectTime = this.events.getSubjectTime();
    const stoppageBearing =
      transition.eventType === "HALFTIME" || transition.eventType === "FULL_TIME";
    const subjectTime =
      stoppageBearing && liveSubjectTime ? liveSubjectTime : transition.subjectTime;

    if (this.kairosBroadcastId) {
      kairos
        .pushEntry(this.kairosBroadcastId, {
          source: SOURCE.matchEvents,
          data: {
            eventType: transition.eventType,
            content: transition.content,
            subjectTime,
            phase: transition.phase,
            // phaseSecond=0 anchors the entry exactly at the phase
            // boundary so its content ordinal matches the prior
            // phase's ceiling.
            phaseSecond: 0,
            // closingExtensionSeconds tells Kairos to pin the next
            // cycle's drain end at this entry's ordinal + extension —
            // captures post-whistle texture into the closing cycle.
            // Set only on HALFTIME / FULL_TIME transitions; KICKOFF /
            // SECOND_HALF_KICKOFF have no closure beat.
            ...(transition.closingExtensionSeconds !== undefined
              ? { closingExtensionSeconds: transition.closingExtensionSeconds }
              : {}),
            // closingPrompt frames the closing cycle's prose ("narrate
            // the dying moments chronologically"). Paired with the
            // extension; Kairos splices it into the cycle's generator
            // call as a consumer-prompt.
            ...(transition.closingPrompt !== undefined
              ? { closingPrompt: transition.closingPrompt }
              : {}),
            team: null,
            player: null,
            synthetic: true,
          },
        })
        .catch((err) => {
          console.warn(
            `[broadcast-runner:${this.broadcastId}] failed to push ${transition.eventType} entry: ${(err as Error).message}`,
          );
        });
    }

    const eventClass = transition.eventType as EventClass;
    const realWallClockMs = Date.now();
    const canonical: CanonicalEventEntry = {
      eventId: `phase:${eventClass.toLowerCase()}:${this.broadcastId}`,
      eventClass,
      playerLastName: null,
      teamKey: null,
      subjectTime: this.events.getSubjectTime() || "",
      realWallClockMs,
      addedAt: realWallClockMs,
    };
    this.canonicalLedger.push(canonical);

    const result = resolveCanonical(canonical, this.pendingClaims, this.pendingTextures);
    for (const release of result.textureReleases) {
      this.pushEntry(
        SOURCE.matchAction,
        {
          kind: "event_texture",
          content: release.content,
          eventClass: release.eventClass,
          parentSourceId: release.parentSourceId,
        },
        release.observedAtMs,
      );
    }
    if (result.matchedTextureIds.length > 0) {
      const matched = new Set(result.matchedTextureIds);
      this.pendingTextures = this.pendingTextures.filter((t) => !matched.has(t.textureId));
    }
    if (result.matchedClaimId) {
      this.pendingClaims = this.pendingClaims.filter(
        (c) => c.claimId !== result.matchedClaimId,
      );
    }
    if (result.sample) {
      this.emitCalibrationSample({
        eventClass: result.sample.eventClass,
        rawDeltaSeconds: result.sample.rawDeltaSeconds,
        canonicalEventId: result.sample.canonicalEventId,
        canonicalSubjectTime: canonical.subjectTime,
        canonicalPlayer: null,
      });
    }
  }

  /**
   * Seed the canonicalLedger from existing Kairos match_events entries.
   * Called once from `runner.start` alongside the source-side dedup
   * reseed. Without it, the correlator starts empty on every restart
   * and commentary claims for events that already happened (KICKOFF,
   * past GOALs) expire without matching against any canonical — which
   * is the "[correlation] N claim(s) expired" log spam observed in the
   * 2026-05-02 live test. Pure transform lives in
   * `lib/canonical-ledger-seed.ts` for testability.
   */
  private seedCanonicalLedgerFromExistingEntries(
    entries: Array<Record<string, unknown>>,
  ): void {
    const seeded = buildCanonicalLedgerSeed(entries, this.broadcastId);
    this.canonicalLedger.push(...seeded);
    console.log(
      `[broadcast-runner:${this.broadcastId}] canonical ledger seeded with ${seeded.length} entries from existing Kairos data`,
    );
  }

  /** Build a CanonicalEventEntry from a Sportmonks-shaped event
   * payload. Returns null when the event isn't correlatable
   * (missing minute, etc). Mirrors the legacy buildGoalWindowEntry
   * shape but for any EventClass. */
  private buildCanonicalEntry(
    data: Record<string, unknown>,
    eventClass: EventClass,
  ): CanonicalEventEntry | null {
    if (typeof data.minute !== "number") return null;
    const extra = typeof data.extraMinute === "number" ? data.extraMinute : null;
    const realWallClockMs = this.events.getBroadcastTimeForSubjectMinute(data.minute, extra);
    if (realWallClockMs == null) return null;

    const player = typeof data.player === "string" ? data.player : null;
    const team = typeof data.teamName === "string" ? data.teamName : null;
    const subjectTime =
      typeof data.subjectTime === "string" ? data.subjectTime : String(data.minute);
    const eventId =
      typeof data.sourceId === "number"
        ? String(data.sourceId)
        : String(data.sourceId ?? `evt:${eventClass}:${data.minute}`);

    return {
      eventId,
      eventClass,
      playerLastName: surnameKey(player),
      teamKey: teamKey(team),
      subjectTime,
      realWallClockMs,
      addedAt: Date.now(),
    };
  }

  // --- Distiller output handlers ---------------------------------------
  // Called by CommentaryDistillationBuffer's callbacks when a chunk
  // resolves into atmosphere / event_texture / event_claim. Atmosphere
  // pushes immediately; texture and claims try late-arrival
  // correlation against the canonical ledger first, falling back to
  // the pending ledgers when no canonical is in scope yet.

  private handleAtmosphere(output: AtmosphereOutput, observedAtMs: number): void {
    this.pushEntry(
      SOURCE.matchAction,
      { kind: "atmosphere", content: output.content },
      observedAtMs,
    );
  }

  private handleEventTexture(output: EventTextureOutput, observedAtMs: number): void {
    const playerLastName = surnameKey(output.eventHint.player);
    const tKey = teamKey(output.eventHint.team);

    const match = findCanonicalForLateArrival(
      {
        eventClass: output.eventHint.eventClass,
        playerLastName,
        teamKey: tKey,
        observedAtMs,
      },
      this.canonicalLedger,
    );

    if (match) {
      this.pushEntry(
        SOURCE.matchAction,
        {
          kind: "event_texture",
          content: output.content,
          eventClass: output.eventHint.eventClass,
          parentSourceId: match.eventId,
        },
        observedAtMs,
      );
      return;
    }

    this.pendingTextures.push({
      textureId: randomUUID(),
      content: output.content,
      eventHint: {
        eventClass: output.eventHint.eventClass,
        playerLastName,
        teamKey: tKey,
        minuteHint: output.eventHint.minuteHint ?? null,
      },
      observedAtMs,
      addedAt: Date.now(),
    });
  }

  private handleEventClaim(output: EventClaimOutput, observedAtMs: number): void {
    const playerLastName = surnameKey(output.player);
    const tKey = teamKey(output.team);

    const match = findCanonicalForLateArrival(
      {
        eventClass: output.eventClass,
        playerLastName,
        teamKey: tKey,
        observedAtMs,
      },
      this.canonicalLedger,
    );

    if (match) {
      const rawDeltaSeconds = (match.realWallClockMs - observedAtMs) / 1000;
      this.emitCalibrationSample({
        eventClass: output.eventClass,
        rawDeltaSeconds,
        canonicalEventId: match.eventId,
        canonicalSubjectTime: match.subjectTime,
        canonicalPlayer: match.playerLastName,
      });
      return;
    }

    this.pendingClaims.push({
      claimId: randomUUID(),
      eventClass: output.eventClass,
      playerLastName,
      teamKey: tKey,
      subjectTimeHint: output.subjectTimeHint ?? null,
      claimedAtMs: observedAtMs,
      addedAt: Date.now(),
    });
  }

  /** Common emission path for calibration samples produced by either
   * (a) a claim arriving and matching an existing canonical
   * (`findCanonicalForLateArrival`), or (b) a canonical arriving and
   * matching a pending claim (`resolveCanonical`). Drives the
   * conductor's `latency_sample` cue + the radio-source offset
   * calibration in `recordObservation`. */
  private emitCalibrationSample(args: {
    eventClass: EventClass;
    rawDeltaSeconds: number;
    canonicalEventId: string;
    canonicalSubjectTime: string;
    canonicalPlayer: string | null;
  }): void {
    const radioSourceName = this.radioSource?.name ?? null;
    const configuredOffsetSeconds = this.radioSource?.defaultOffsetSeconds ?? 0;

    // EWMA update on the effective offset (see `applyCalibrationSample`
    // for the formula + sign convention).
    const offsetBefore = this.effectiveOffsetSeconds;
    const offsetAfter = applyCalibrationSample(offsetBefore, args.rawDeltaSeconds);
    this.effectiveOffsetSeconds = offsetAfter;

    getRoomConductor(this.broadcastId)?.broadcastCue({
      type: "latency_sample",
      goalEventId: args.canonicalEventId,
      goalContentTime: args.canonicalSubjectTime,
      goalPlayer: args.canonicalPlayer,
      transcriptionText: `[${args.eventClass}]`,
      transcriptionContentTime: args.canonicalSubjectTime,
      transcriptionEndWallClock: Date.now(),
      rawDeltaSeconds: args.rawDeltaSeconds,
      configuredOffsetSeconds,
      sourceName: radioSourceName,
    });

    console.log(
      `[broadcast-runner:${this.broadcastId}] [latency] ${args.eventClass}@${args.canonicalSubjectTime} raw Δ ${args.rawDeltaSeconds.toFixed(1)}s (offset ${offsetBefore.toFixed(1)}s → ${offsetAfter.toFixed(1)}s; seed ${configuredOffsetSeconds}s)`,
    );

    // Drift instrumentation. Each calibration sample feeds the
    // per-broadcast distribution we use to tune Kairos's content-time
    // batching DELAY. Aggregating absDeltaSeconds across recent
    // broadcasts gives the histogram needed to set DELAY confidently:
    // if 99th percentile is <40s we can drop DELAY to 45s; if it's 60s
    // we should push to 75s. The current default is 60s with margin —
    // the design doc (`docs/design-problem-content-time-batching.md`)
    // tracks why.
    captureEvent({
      name: "calibration_sample",
      broadcastId: this.broadcastId,
      properties: {
        "calibration.eventClass": args.eventClass,
        "calibration.rawDeltaSeconds": args.rawDeltaSeconds,
        "calibration.absDeltaSeconds": Math.abs(args.rawDeltaSeconds),
        "calibration.configuredOffsetSeconds": configuredOffsetSeconds,
        "calibration.effectiveOffsetBefore": offsetBefore,
        "calibration.effectiveOffsetAfter": offsetAfter,
        "calibration.canonicalEventId": args.canonicalEventId,
        "calibration.canonicalSubjectTime": args.canonicalSubjectTime,
        "calibration.radioSourceName": radioSourceName,
      },
    });

    if (this.radioSource) {
      recordObservation(this.radioSource.id, args.rawDeltaSeconds).catch((err) =>
        console.warn(
          `[broadcast-runner:${this.broadcastId}] [latency] recordObservation failed: ${(err as Error).message}`,
        ),
      );
    }
  }

  /** Window-expiry sweep. Pending textures that aged out get released
   * to Kairos as standalone match_action (no parent). Pending claims
   * that aged out are dropped — that's the no-match telemetry signal:
   * either commentary anticipated incorrectly, or our event class
   * extraction was off. */
  private runCorrelationPrune(): void {
    const now = Date.now();
    const { expiredClaims, expiredTextures } = pruneExpired(
      this.pendingClaims,
      this.pendingTextures,
      this.canonicalLedger,
      now,
    );

    for (const t of expiredTextures) {
      // Texture aged out without finding a canonical match. The
      // distiller's eventClass tag was Haiku judgment ("commentary
      // sounded like a goal") that wasn't confirmed by Sportmonks. We
      // refuse to propagate the unverified event-class tag — that path
      // produced narrative #14's fictional Leeds equaliser during the
      // 2026-04-26 FA Cup SF: distilled "Euler Brand finished cleanly"
      // tagged eventClass=GOAL with no canonical GOAL to anchor it,
      // and the generator wrote 94 confident words about a goal that
      // never happened. Demote to plain atmosphere — the narrator
      // still gets the texture content, just not the misleading
      // event-class assertion.
      this.pushEntry(
        SOURCE.matchAction,
        {
          kind: "atmosphere",
          content: t.content,
          // No eventClass — uncorrelated tags must not survive into
          // the narrative input. No parentSourceId for the same reason.
        },
        t.observedAtMs,
      );
    }

    if (expiredClaims.length > 0) {
      console.log(
        `[broadcast-runner:${this.broadcastId}] [correlation] ${expiredClaims.length} claim(s) expired without canonical match: ${expiredClaims.map((c) => c.eventClass).join(", ")}`,
      );
    }
  }

  private async checkBroadcastLifecycle(): Promise<void> {
    const current = await getBroadcast(this.broadcastId);
    if (!current) return;
    if (current.status === "complete") {
      console.log(
        `[broadcast-runner:${this.broadcastId}] broadcast flipped to complete externally — stopping sources`,
      );
      // Don't re-complete on Kairos; it's already been done.
      await this.stop({ completeBroadcast: false });
      runners.delete(this.broadcastId);
    }
  }

  async stop(opts: { completeBroadcast: boolean }): Promise<void> {
    if (this.statusCheckTimer) {
      clearInterval(this.statusCheckTimer);
      this.statusCheckTimer = null;
    }
    if (this.correlationPruneTimer) {
      clearInterval(this.correlationPruneTimer);
      this.correlationPruneTimer = null;
    }
    this.events.stop();
    this.pressure.stop();
    this.transcription?.stop();
    this.transcription = null;
    this.distillationBuffer?.stop();
    this.distillationBuffer = null;

    if (opts.completeBroadcast) {
      try {
        await completeBroadcast(this.broadcastId);
      } catch (err) {
        console.error(
          `[broadcast-runner:${this.broadcastId}] complete failed: ${(err as Error).message}`,
        );
      }
    }

    this.stoppedAt = Date.now();
    console.log(`[broadcast-runner:${this.broadcastId}] stopped`);
  }

  status(): BroadcastRunnerStatus {
    return {
      broadcastId: this.broadcastId,
      kairosBroadcastId: this.kairosBroadcastId,
      startedAt: this.startedAt,
      fixtureId: this.fixtureId,
      radioSourceName: this.radioSource?.name ?? null,
      stoppedAt: this.stoppedAt,
      lastError: this.lastError,
    };
  }
}

// --- Helpers -------------------------------------------------------------

function toPressureEventData(
  signal: PressureSignal,
  subjectTime: string | null,
): Record<string, unknown> | null {
  if (signal.type === "zone_entry") {
    const teamLabel = signal.teamName ?? (signal.team === "home" ? "Home" : "Away");
    return {
      content: `[ZONE] ${teamLabel} into attacking third`,
      eventType: "ZONE_ENTRY",
      team: { side: signal.team, name: signal.teamName },
      subjectTime,
    };
  }

  if (signal.type === "zone_middle") {
    const fromLabel =
      signal.fromTeamName ??
      (signal.fromTeam ? (signal.fromTeam === "home" ? "Home" : "Away") : "Play");
    return {
      content: `[ZONE] ${fromLabel} back into middle third`,
      eventType: "ZONE_MIDDLE",
      team: signal.fromTeam
        ? { side: signal.fromTeam, name: signal.fromTeamName }
        : null,
      subjectTime,
    };
  }

  const teamLabel = signal.teamName ?? (signal.team === "home" ? "Home" : "Away");
  const parts: string[] = [
    `${Math.round(signal.attackingThirdShare * 100)}% territory`,
  ];
  if (signal.attacks) parts.push(`${signal.attacks} attacks`);
  if (signal.dangerousAttacks) parts.push(`${signal.dangerousAttacks} dangerous`);
  if (signal.shots) parts.push(`${signal.shots} shots`);
  if (signal.corners) parts.push(`${signal.corners} corners`);
  return {
    content: `[PRESSURE] ${teamLabel} (${signal.phaseDurationSeconds}s): ${parts.join(", ")}`,
    eventType: "PRESSURE_UPDATE",
    team: { side: signal.team, name: signal.teamName },
    subjectTime,
    pressure: {
      phaseDurationSeconds: signal.phaseDurationSeconds,
      attacks: signal.attacks,
      dangerousAttacks: signal.dangerousAttacks,
      shots: signal.shots,
      corners: signal.corners,
      attackingThirdShare: signal.attackingThirdShare,
    },
  };
}
