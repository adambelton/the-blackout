import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyCanonicalState } from "../types/canonical-state.js";
import type {
  Broadcast,
  MatchroomCue,
  Passage,
} from "../types/index.js";

/**
 * MatchroomCue cross-process contract.
 *
 * Cues serialize as JSON across the WS boundary. Two failure classes
 * worth catching here:
 *
 *   1. Discriminator drift — a new cue variant added to MatchroomCue
 *      without updating consumers. The exhaustive switch + Set-of-
 *      seen-discriminators below produces both a TS error AND a
 *      runtime assertion when this happens.
 *
 *   2. JSON-unsafe values sneaking into a cue (Date instances, Set,
 *      Map, functions, circular refs). All cue variants are walked
 *      through one round-trip; if a field's wire form drifts from
 *      its in-memory form, the deepEqual fails.
 *
 * What this file deliberately does NOT do: re-test JSON.parse /
 * JSON.stringify per variant. Eight separate `assert.deepEqual(
 * roundTrip(cue), cue)` calls were just exercising Node's JSON
 * implementation — collapsed into one walk over the variants.
 */

function broadcast(): Broadcast {
  return {
    id: "b1",
    homeTeam: "Forest",
    awayTeam: "Newcastle",
    competition: "Premier League",
    matchDate: "2026-05-10T14:00:00Z",
    status: "live",
  };
}

function passage(): Passage {
  return {
    narrativeId: "n1",
    narrationId: "nr1",
    text: "Forest break the deadlock.",
    wordCount: 4,
    generatedAt: "2026-05-10T14:32:00Z",
    audio: { url: "https://example/audio.mp3", durationMs: 12_000 },
    playback: { startedAt: 1_700_000_000_000, serverNow: 1_700_000_000_500 },
    revealedCanonical: emptyCanonicalState("live_first_half"),
    // Optional `phase` marker omitted (not `undefined`) — undefined
    // doesn't survive JSON.stringify, so the contract is "absent
    // means absent".
    revealingCanonical: { events: [] },
  };
}

const ALL_CUES: MatchroomCue[] = [
  { type: "connected", broadcast: broadcast(), currentPassage: null, serverNow: 0 },
  { type: "connected", broadcast: broadcast(), currentPassage: passage(), serverNow: 0 },
  { type: "passage_added", passage: passage() },
  {
    type: "passage_audio_ready",
    narrativeId: "n",
    narrationId: "nr",
    audio: { url: "u", durationMs: 1 },
  },
  {
    type: "passage_started",
    narrativeId: "n",
    narrationId: "nr",
    audio: { url: "u", durationMs: 1 },
    playback: { startedAt: 0, serverNow: 0 },
  },
  { type: "passage_skipped", narrativeId: "n", reason: "x" },
  { type: "passage_updated", narrativeId: "n", patch: {} },
  {
    type: "passage_updated",
    narrativeId: "n",
    patch: { revealedCanonical: { illustration: { imageKey: "k", imageUrl: "u" } } },
  },
  { type: "broadcast_status_changed", status: "live", serverNow: 0 },
  { type: "broadcast_status_changed", status: "complete", serverNow: 0 },
  { type: "generation_skipped", reason: "rate_limit" },
  {
    type: "generation_skipped",
    reason: "rate_limit",
    retryAfterMs: 30_000,
    triggerReason: "accumulation",
  },
];

describe("MatchroomCue — wire shape", () => {
  it("every variant is JSON-roundtrip-safe (no Date / Set / Map / undefined fields / circular refs)", () => {
    for (const cue of ALL_CUES) {
      // JSON.stringify throws on circulars; JSON.parse + deepEqual
      // catches Date/Set/Map drift and silent undefined drops.
      assert.deepEqual(
        JSON.parse(JSON.stringify(cue)),
        cue,
        `cue type=${cue.type} did not survive JSON round-trip`,
      );
    }
  });
});

describe("MatchroomCue — discriminator completeness", () => {
  it("every variant has a unique 'type' discriminator and the union covers them all", () => {
    const seen = new Set<string>();
    for (const c of ALL_CUES) {
      switch (c.type) {
        case "connected":
        case "passage_added":
        case "passage_audio_ready":
        case "passage_started":
        case "passage_skipped":
        case "passage_updated":
        case "broadcast_status_changed":
        case "generation_skipped": {
          seen.add(c.type);
          break;
        }
        default: {
          // Exhaustiveness check — adding a variant without updating
          // this switch produces a TS error here AND runtime failure.
          const _exhaustive: never = c;
          assert.fail(`unreachable: unknown cue type ${(_exhaustive as { type: string }).type}`);
        }
      }
    }
    assert.equal(seen.size, 8, "expected 8 distinct cue discriminators in MatchroomCue");
  });
});
