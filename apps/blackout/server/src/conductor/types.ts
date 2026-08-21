import type { TtsProvider } from "../lib/tts/index.js";
import type {
  BroadcastPhase,
  BroadcastStatusChangedCue,
  GameplayTransitionEventType,
  GenerationSkippedCue as SharedGenerationSkippedCue,
  PassageAddedCue,
  PassageAudioReadyCue,
  PassageSkippedCue,
  PassageStartedCue,
  PassageUpdatedCue,
} from "@blackout/shared";
import type { KairosFeedEntry } from "../lib/kairos.js";

export type { BroadcastPhase, GameplayTransitionEventType };

/**
 * Persisted narration — one row in `broadcast_narrations` plus the fields
 * the conductor needs at runtime. Immutable once created; the only field
 * that mutates is `playbackStartedAt` when the scheduler picks it up.
 */
export interface NarrationRecord {
  id: string;
  broadcastId: string;
  narrativeId: string;
  text: string;
  wordCount: number;
  audioKey: string;
  durationMs: number;
  voiceId: string;
  provider: TtsProvider;
  synthesizedAt: Date;
  playbackStartedAt: Date | null;
  /**
   * Kairos batch context — the full list of feed entries this
   * narration's cycle observed. Threaded into the `play` cue so the
   * matchroom can reveal staged events on audio-end. Kept in memory
   * only (not persisted) — it's a cache of Kairos state, not a
   * durable record.
   */
  batchEntryIds: string[];
  /**
   * Content-time anchor for the narration — the minute the narrator is
   * beginning from, derived from the earliest subject time in the
   * cycle's batch (server transforms at the seam). Threaded into the
   * `play` cue so the matchroom snaps the content clock to it as audio
   * starts. Null when no batch entry carried a numeric subject time
   * (e.g. pre-match). See `docs/vocabulary.md` § Time.
   */
  contentTime: number | null;
}

// BroadcastPhase is the conductor's FSM, declared once in
// `@blackout/shared` so the consumer-facing inspector + admin UIs
// can switch on it directly. Re-exported above; runtime semantics
// (transitions, what flows to Kairos in each phase) are owned here:
//
//   pre_ramp           — before activation; nothing happens
//   warming            — activation → kickoff. narrative_voice +
//                        narrative_context seeded; Kairos's empty-buffer
//                        accumulation cycles produce 1-2 scene-setters
//                        then fall silent (capped by
//                        `consecutiveEmptyCycles`).
//   live_first_half    — kickoff → halftime whistle. Entries flow.
//   halftime           — halftime whistle → second-half kickoff. One
//                        explicit generation (first-half reflection),
//                        then silence. No entries pushed.
//   live_second_half   — second-half kickoff → fulltime. Entries flow.
//   full_time_winddown — fulltime → broadcast completes. One explicit
//                        closing passage; when its audio ends, broadcast
//                        transitions to complete.
//   complete           — terminal. Matchroom shows post-match state.
//
// Transitions are triggered by Sportmonks event signals — the Blackout
// is the football-aware side; Kairos stays domain-agnostic. See
// docs/match-windows memory for the agreed product shape.

/**
 * Cue types emitted by the RoomConductor to subscribed clients
 * (matchroom + moderator WS connections).
 *
 * The server is the authoritative "now playing" clock. Clients compute
 * the correct playback offset from `(serverNow - playbackStartedAt)` on
 * every `play` and on the `currentPlay` field inside `connected`.
 */
/**
 * Every cue `RoomConductor.fanOut` is allowed to emit. Tightened from
 * an `unknown`-bearing escape hatch (the audit's WS-cue type-safety
 * gap, 2026-05-10) to a strict union — adding a new cue means adding
 * it here; missing entries fail tsc instead of silently flowing as
 * `unknown` to subscribers.
 *
 * Three groups:
 *
 *   1. Legacy playback cues (`PhaseCue`, `NarrativeCue`, `PreloadCue`,
 *      `PlayCue`, `IllustrationCue`) — still emitted alongside the
 *      bundle cues during the Sub-piece 4 migration.
 *
 *   2. Bundle cues, sourced from `@blackout/shared` so the matchroom
 *      and the conductor type the same wire shapes. Includes
 *      `passage_added` / `passage_audio_ready` / `passage_started` /
 *      `passage_skipped` / `passage_updated` / `broadcast_status_changed`.
 *
 *   3. Admin cues (`FeedEntryCue`, `LatencySampleCue`) — the
 *      moderator console reads these; the matchroom whitelist drops
 *      them in `matchroom-transform.ts`.
 *
 * `GenerationSkippedCue` is sourced from shared (the conductor's
 * earlier local declaration was a duplicate of the same shape; that
 * shadow is gone, the shared type is canonical).
 *
 * The legacy `ConnectedCue` declared below shadows the shared
 * Connected cue (different shape — `currentPlay` vs `currentPassage`).
 * That collision still stands; resolving it requires the moderator-
 * WS-typing work in a follow-up wave.
 */
export type ConductorCue =
  // Legacy playback cues (Sub-piece 4 migration in flight)
  | ConnectedCue
  | NarrativeCue
  | PreloadCue
  | PlayCue
  | PhaseCue
  | IllustrationCue
  // Bundle cues from shared
  | PassageAddedCue
  | PassageAudioReadyCue
  | PassageStartedCue
  | PassageSkippedCue
  | PassageUpdatedCue
  | BroadcastStatusChangedCue
  | SharedGenerationSkippedCue
  // Admin cues (moderator-only; matchroom-transform whitelist drops them)
  | FeedEntryCue
  | LatencySampleCue;

/**
 * Raw Kairos feed entry forwarded to subscribers verbatim. The
 * moderator console renders it; matchroom drops it via the
 * `matchroom-transform` whitelist (per `audio is canonical`).
 */
export interface FeedEntryCue {
  type: "feed_entry";
  entry: KairosFeedEntry;
}

/**
 * Calibration sample emitted by the broadcast runner whenever a
 * distillation event_claim matches a Sportmonks canonical event. The
 * EWMA update on `effectiveOffsetSeconds` happens in the runner;
 * this cue surfaces the raw observation to the moderator console for
 * inspection. Matchroom-transform drops it.
 */
export interface LatencySampleCue {
  type: "latency_sample";
  goalEventId: string;
  goalContentTime: string;
  goalPlayer: string | null;
  transcriptionText: string;
  transcriptionContentTime: string;
  transcriptionEndWallClock: number;
  rawDeltaSeconds: number;
  configuredOffsetSeconds: number;
  sourceName: string | null;
}

// `GameplayTransitionEventType` is re-exported above from shared —
// the matchroom needs to render synthetic phase entries in the event
// ribbon, so the type lives next to MatchEventType in shared. Runtime
// semantics (which phase each maps to, what the runner pushes) stay
// owned by the conductor's phase-logic module here.

/** Phase transition — matchroom UI uses it to swap placeholder copy. */
export interface PhaseCue {
  type: "phase";
  phase: BroadcastPhase;
  serverNow: number;
}

/** Initial state snapshot when a client connects. */
export interface ConnectedCue {
  type: "connected";
  broadcast: unknown; // Blackout broadcast row shape
  currentPlay: PlaySnapshot | null;
  phase: BroadcastPhase;
  serverNow: number;
}

/** A snapshot of what's currently playing — used for late joiners. */
export interface PlaySnapshot {
  narrationId: string;
  narrativeId: string;
  text: string;
  wordCount: number;
  audioUrl: string;
  durationMs: number;
  playbackStartedAt: number;
  batchEntryIds?: string[];
  contentTime?: number | null;
}

/**
 * A new narrative landed (text propagation — independent of audio).
 * Nested shape matches the existing Kairos WS payload so moderator and
 * matchroom clients read `msg.narrative.text`, `msg.narrative.covers`
 * etc. `narrationId` is null when ttsEnabled is off for the broadcast.
 *
 * `batchEntryIds` is the full set of feed entries that fed this
 * generation's context. Consumers use it for reveal-gating — the
 * matchroom stages events and reveals them when the corresponding
 * narration finishes playing.
 */
export interface NarrativeCue {
  type: "narrative";
  narrative: {
    id: string;
    narrationId: string | null;
    text: string;
    wordCount: number;
    generatedAt: string;
    /**
     * Per-cover `charOffset` (when present) marks the position in
     * `text` where the generator anchored the reference — consumers
     * map `(charOffset / text.length) * audioDurationMs` to schedule
     * per-entry reveals ahead of audio-end. Absent offsets fall back
     * to the audio-end reveal contract via `batchEntryIds`.
     */
    covers?: Array<{ entryId: string; contentTime?: string; charOffset?: number }>;
    batchEntryIds?: string[];
    /**
     * Content-time anchor for this narration — the cycle's earliest
     * subject time, parsed-leading-int (server transforms at the
     * seam). Matchroom snaps the content clock to this as each
     * passage's audio starts — driven by the cycle, not by specific
     * revealed events. Null when no batch entry carried a numeric
     * subject time. See `docs/vocabulary.md` § Time.
     */
    contentTime?: number | null;
  };
}

/** Preload: audio for an upcoming clip is ready — start downloading. */
export interface PreloadCue {
  type: "preload";
  narrationId: string;
  narrativeId: string;
  audioUrl: string;
  durationMs: number;
}

/**
 * Play: start playing this clip now, at the given server-anchored
 * offset. `batchEntryIds` travels with the cue so the matchroom can
 * reveal staged events on audio-end for whichever cue they belong to.
 * `contentTime` is the minute the narrator is beginning from —
 * matchroom snaps the clock to it at audio start.
 */
export interface PlayCue {
  type: "play";
  narrationId: string;
  narrativeId: string;
  text: string;
  wordCount: number;
  audioUrl: string;
  durationMs: number;
  playbackStartedAt: number;
  serverNow: number;
  batchEntryIds?: string[];
  contentTime?: number | null;
}

/**
 * `GenerationSkippedCue` — sourced from `@blackout/shared` (was a
 * shadow declaration here previously; consolidated 2026-05-10).
 * Re-exported so existing consumers under `apps/blackout/server/src/conductor`
 * can keep their existing import paths.
 */
export type { GenerationSkippedCue } from "@blackout/shared";

/**
 * An illustration is ready for a specific narrative. Decoupled from
 * the `play` cue because image generation runs in parallel with TTS
 * synthesis and they finish in their own time — per the `audio is
 * canonical, visuals never block audio` rule. The matchroom
 * associates the image with its narrative; on the passage's audio
 * start, the image becomes visible. If a later passage's image
 * arrives first, it waits its turn.
 */
export interface IllustrationCue {
  type: "illustration";
  /** The Kairos narrative id this image belongs to — matches the
   * `narrativeId` on the corresponding `play` cue. */
  narrativeId: string;
  imageUrl: string;
}
