/**
 * Matchroom passage + WS cue contract for the bundle-driven reveal
 * architecture (Design A — `docs/matchroom-reveal-architecture-scoping.md`).
 *
 * A Passage is the wire-format bundle: the Kairos narrative's text +
 * audio metadata + server-anchored playback timing + the per-passage
 * canonical bundle (revealedCanonical + revealingCanonical) the
 * matchroom walks against audio playback to produce visible state.
 *
 * Lifecycle on the client (live mode):
 *
 *   passage_added         bundle materialises; audio/playback null
 *   passage_audio_ready   audio populated; client warms cache
 *   passage_started       playback populated; THIS is currentPassage
 *   (audio.onended fires client-side; current → revealed)
 *   passage_added (next)  the next passage materialises ...
 *
 * `passage_completed` is intentionally NOT a cue — local
 * `audio.onended` is the source of truth for "current passage's
 * audio ended" (server can't anticipate it precisely; client-side
 * timing is what listeners experience).
 *
 * For TTS-disabled broadcasts, audio + playback never populate;
 * `passage_added` is the only event per passage. Reveals fold into
 * the next passage's revealedCanonical at receipt of the next
 * `passage_added`. The very last passage of a TTS-disabled broadcast
 * loses its tail revealing — TTS-disabled is testing-only and the
 * reflection passage carries no revealing state, so the loss is
 * benign.
 */

import type { Broadcast } from "./broadcast.js";
import type { CanonicalState, RevealingCanonical } from "./canonical-state.js";

export interface Passage {
  /** Kairos generation id — stable across the passage's lifetime;
   * the dedupe key for client-side state. */
  narrativeId: string;
  /** broadcast_narrations row id once synthesis completes; null
   * before that, and on TTS-disabled broadcasts. */
  narrationId: string | null;
  /** Anchor-stripped prose (what gets read aloud / displayed). */
  text: string;
  wordCount: number;
  /** ISO timestamp from Kairos. */
  generatedAt: string;
  /** Populated by `passage_audio_ready`. Null until then. */
  audio: { url: string; durationMs: number } | null;
  /** Populated by `passage_started`. Server-anchored — every client
   * computes the same audio offset from `serverNow - startedAt`.
   * Null in replay mode (client owns its own playback offset). */
  playback: { startedAt: number; serverNow: number } | null;
  revealedCanonical: CanonicalState;
  revealingCanonical: RevealingCanonical;
}

// ---------------------------------------------------------------------------
// WS cues — server → matchroom client
// ---------------------------------------------------------------------------

/**
 * Connection snapshot. `currentPassage` is populated when a passage
 * is in flight (post-`passage_started`, pre-audio-end). Late joiners
 * read `currentPassage.revealedCanonical` immediately to render the
 * room's current state, then walk `currentPassage.revealingCanonical`
 * markers from the live audio offset.
 *
 * `revealedPassages` is intentionally absent from this contract:
 * live late-joiners don't need passage history (today's matchroom
 * already only shows passages whose play fired in this session).
 * Replay mode reads the full passage list from `GET /broadcasts/:id`
 * archive instead of streaming WS cues.
 */
export interface ConnectedCue {
  type: "connected";
  broadcast: Broadcast;
  currentPassage: Passage | null;
  serverNow: number;
}

/**
 * A new passage materialises on the client — the bundle exists but
 * audio synthesis is in flight (or not happening, for TTS-disabled
 * broadcasts). The client stages it for display when
 * `passage_started` arrives.
 */
export interface PassageAddedCue {
  type: "passage_added";
  passage: Passage;
}

/**
 * TTS synthesis finished — the audio URL + duration are known.
 * Client may pre-load the bytes ahead of `passage_started` so the
 * swap is gap-free.
 */
export interface PassageAudioReadyCue {
  type: "passage_audio_ready";
  narrativeId: string;
  narrationId: string;
  audio: { url: string; durationMs: number };
}

/**
 * Server has anchored audio start for this passage. Client moves it
 * into currentPassage and starts the marker walk. The previously-
 * current passage is moved into the client's revealed list (or simply
 * forgotten — late joiners don't need history).
 */
export interface PassageStartedCue {
  type: "passage_started";
  narrativeId: string;
  narrationId: string;
  audio: { url: string; durationMs: number };
  playback: { startedAt: number; serverNow: number };
}

/**
 * Synthesis failed for this narrative. Client drops the passage from
 * any local queue. The conductor's running state has already absorbed
 * the revealings (advance happens at narrative compose time, not
 * synthesis success), so the next passage's revealedCanonical
 * includes them — events aren't swallowed; they appear at the start
 * of the next passage instead of at the failed passage's audio markers.
 */
export interface PassageSkippedCue {
  type: "passage_skipped";
  narrativeId: string;
  reason: string;
}

/**
 * Patch update for an already-emitted passage. Currently used for
 * late-arriving illustrations (image generation can finish after
 * audio has started). Reserved for any field that can mutate after
 * `passage_added`.
 */
export interface PassageUpdatedCue {
  type: "passage_updated";
  narrativeId: string;
  patch: { revealedCanonical?: Partial<CanonicalState> };
}

/**
 * Broadcast lifecycle status changed. The matchroom uses this to
 * flip into replay mode on `complete` (refetches GET /broadcasts/:id
 * to get the archive). Carries terminal status changes that don't
 * arise from a passage's revealing — admin force-completes,
 * post-FT auto-complete after the closing reflection's audio ends.
 */
export interface BroadcastStatusChangedCue {
  type: "broadcast_status_changed";
  status: "live" | "complete";
  serverNow: number;
}

/**
 * Pipeline signal — Kairos refused to generate (e.g. rate limit).
 * Unchanged from the legacy contract; informational for the operator
 * console, ignored by the matchroom.
 */
export interface GenerationSkippedCue {
  type: "generation_skipped";
  reason: string;
  retryAfterMs?: number;
  triggerReason?: string;
}

/** The full union of WS cues the matchroom client receives in the
 * bundle-driven contract. */
export type MatchroomCue =
  | ConnectedCue
  | PassageAddedCue
  | PassageAudioReadyCue
  | PassageStartedCue
  | PassageSkippedCue
  | PassageUpdatedCue
  | BroadcastStatusChangedCue
  | GenerationSkippedCue;
