import type { BroadcastPhase, TeamSide } from "./broadcast.js";
import type { CanonicalEventType } from "./events.js";
import { parseMatchTime } from "./match-time.js";

/**
 * Per-passage canonical-state contract for the matchroom reveal
 * architecture (Design A, 2026-05-03 cluster — `docs/live-test-2026-05-03.md`,
 * `docs/matchroom-reveal-architecture-scoping.md`).
 *
 * The matchroom UI is driven by a single visible-state derivation:
 *
 *   visibleState = revealedCanonical + markers in revealingCanonical
 *                                       whose charOffset has been crossed
 *                                       by audio playback
 *
 * `revealedCanonical` is the snapshot at a passage's audio-start —
 * every fact already past its anchor, safe to render immediately.
 * `revealingCanonical` is what THIS passage will reveal during its
 * audio, with each delta carrying the prose char position at which it
 * fires. The chain invariant guarantees consistency:
 *
 *   passage[N+1].revealedCanonical
 *     === apply(passage[N].revealedCanonical, passage[N].revealingCanonical)
 *
 * Live mode: server-anchored playback offset feeds the marker walk.
 * Replay: the client's local `audio.currentTime` feeds the same walk.
 * One mechanism, two consumers.
 */

/** A match event rendered in canonical form. Mirrors the matchroom
 * ribbon's needs without leaking Kairos's raw entry shape. Sourced
 * from a `match_events` Kairos entry via the conductor. */
export interface CanonicalEvent {
  id: string;
  eventType: CanonicalEventType;
  player: string | null;
  relatedPlayer: string | null;
  team: TeamSide | null;
  teamName: string | null;
  /** Content-time anchor — the match-minute the matchroom shows for
   * this event. The Blackout server transforms Kairos's subject-time
   * data into content time at the seam. See `docs/vocabulary.md` § Time. */
  contentTime?: string;
  minute: number | null;
  extraMinute: number | null;
  isGoal: boolean;
}

/** Snapshot of the matchroom's visible state at a single instant.
 * Composed by the conductor at passage-compose time and by the client
 * each render frame as markers are crossed. */
export interface CanonicalState {
  score: { home: number; away: number };
  phase: BroadcastPhase;
  /** Server-emitted content-minute string ("47", "45+3"), null
   * pre-match. The cycle's content-time anchor as it'll be displayed
   * to the listener — see `docs/vocabulary.md` § Time. The client
   * formats the display label by combining this with the visible
   * phase: `halftime → "HT"`, `full_time_winddown | complete → "FT"`,
   * else `${contentMinute}'`. */
  contentMinute: string | null;
  /** Sorted by parsed content time ascending. */
  events: CanonicalEvent[];
  /** Currently displayed image. Carried forward across passages on
   * `hold` decisions; replaced on `generate` / `pool` decisions.
   *
   * `imageKey` is the storage-layer key (e.g. R2 object key) and is
   * the durable reference. `imageUrl` is a freshly-resolved
   * (and presigned, for R2) public URL — it has a short TTL and
   * MUST be re-resolved at every consumer-facing read site
   * (`buildBroadcastView`, late-joiner snapshots), the same pattern
   * the audio path uses. Never trust an `imageUrl` read from the DB
   * verbatim — it is allowed to be stale, only the imageKey is
   * authoritative. */
  illustration: { imageKey: string; imageUrl: string } | null;
  /** Reserved (Q6 in the scoping doc). Always null for this cluster.
   * Closes the contract so a future lineup channel doesn't reshape
   * `CanonicalState`. */
  lineup: null;
}

/** A reveal delta — the new value plus the prose char position at
 * which the matchroom should apply it. `charOffset` omitted means
 * reveal at audio-end (matches today's "in batch but not cited"
 * fallback for events). */
export interface RevealingMarker<T> {
  value: T;
  charOffset?: number;
}

/**
 * Per-passage reveal deltas. Each field is present only when the
 * passage reveals that channel.
 *
 * Score and contentMinute are deliberately not included as channels:
 *   - Score is a client-side projection over goal events as they
 *     reveal — server stays the source of truth (the goal events are
 *     server-authored), the client just runs `score = base +
 *     count(goals revealed so far)`.
 *   - contentMinute snaps at passage start (revealedCanonical) and
 *     rarely changes mid-passage. The display label flips
 *     automatically when phase changes via the projection rule.
 */
export interface RevealingCanonical {
  events?: RevealingMarker<CanonicalEvent>[];
  phase?: RevealingMarker<BroadcastPhase>;
}

// ---------------------------------------------------------------------------
// State composition operations
// ---------------------------------------------------------------------------
//
// Pure state transformations on the canonical-state shapes. Used by:
//  - The conductor at narrative-compose time, to fold each passage's
//    revealing forward into the running canonical state so the next
//    passage's `revealedCanonical` is correct.
//  - The matchroom client + render pipeline, to project visible state
//    from a passage by walking only the markers whose `charOffset` has
//    been crossed by the current audio offset.
//  - The backfill script, to recompose bundles for historical
//    broadcasts deterministically from existing data.
//
// The chain invariant these uphold:
//
//   passage[N+1].revealedCanonical
//     === applyRevealingCanonical(
//           passage[N].revealedCanonical,
//           passage[N].revealingCanonical,
//         )

/**
 * Initial canonical state for a fresh broadcast — the empty state
 * before any passage has revealed anything. Phase defaults to
 * `pre_ramp` (broadcast not yet activated); callers can pass a
 * different phase for warming / mid-broadcast recovery scenarios.
 */
export function emptyCanonicalState(phase: BroadcastPhase = "pre_ramp"): CanonicalState {
  return {
    score: { home: 0, away: 0 },
    phase,
    contentMinute: null,
    events: [],
    illustration: null,
    lineup: null,
  };
}

/**
 * Apply every reveal in `revealing` to `state`, returning a new
 * state. Pure — neither argument is mutated.
 *
 *   - Events: each `revealing.events[i].value` is added to the
 *     running events list (deduped by id, defensive against repeated
 *     folds). Goals project score forward as they're added — this is
 *     the server's role-of-truth: the score reflects the goal
 *     events that have been revealed, no separate score channel.
 *   - Phase: replaces the running phase if a marker is present.
 *
 * Events are kept sorted by parsed content time ascending so the
 * matchroom ribbon's order matches the server's view. Within equal
 * minutes, the existing event order is preserved (stable insertion).
 */
export function applyRevealingCanonical(
  state: CanonicalState,
  revealing: RevealingCanonical,
): CanonicalState {
  let { score, events, illustration, phase, contentMinute, lineup } = state;

  if (revealing.events && revealing.events.length > 0) {
    const seen = new Set(events.map((e) => e.id));
    let merged = events;
    let scoreHome = score.home;
    let scoreAway = score.away;
    let didMerge = false;
    for (const marker of revealing.events) {
      const e = marker.value;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!didMerge) {
        merged = [...events];
        didMerge = true;
      }
      merged.push(e);
      if (e.isGoal) {
        if (e.team === "home") scoreHome += 1;
        else if (e.team === "away") scoreAway += 1;
      }
    }
    if (didMerge) {
      // Sort by parsed contentTime ascending — undefined contentTime
      // (legitimate for events without a content-time anchor, e.g.
      // pre-match seeding) sinks to -Infinity, sorting first.
      merged.sort((a, b) => {
        const am = parseMatchTime(a.contentTime);
        const bm = parseMatchTime(b.contentTime);
        if (am !== bm) return am - bm;
        return 0;
      });
      events = merged;
      if (scoreHome !== score.home || scoreAway !== score.away) {
        score = { home: scoreHome, away: scoreAway };
      }
    }
  }

  if (revealing.phase) {
    phase = revealing.phase.value;
  }

  return { score, events, illustration, phase, contentMinute, lineup };
}
