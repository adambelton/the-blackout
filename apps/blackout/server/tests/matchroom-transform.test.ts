import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { matchroomTransform, toViewerEntry } from "../src/ws/matchroom-transform.js";

const goalEntry = {
  id: "e1",
  source: "match_events",
  data: {
    eventType: "GOAL",
    content: "Haaland scores",
    player: "Erling Haaland",
    team: { side: "away", name: "Manchester City" },
    minute: 23,
  },
  timestamp: 1_000,
  created_at: "2026-04-22T20:00:00.000Z",
};

describe("matchroomTransform — viewer-side cue whitelist", () => {
  it("passes the bundle-driven cues through unchanged (Sub-piece 4d — sole contract)", () => {
    for (const type of [
      "connected",
      "generation_skipped",
      "passage_added",
      "passage_audio_ready",
      "passage_started",
      "passage_skipped",
      "passage_updated",
      "broadcast_status_changed",
    ]) {
      const cue = { type, payload: 1 };
      assert.equal(
        matchroomTransform(cue),
        cue,
        `${type} should reach matchroom clients`,
      );
    }
  });

  it("drops the legacy cues — moderator still receives them, matchroom does not (Sub-piece 4d)", () => {
    // The matchroom no longer reads these; legacy cue traffic stays
    // on the moderator path. Server still emits them (dual-emit
    // window over until the cue producers retire too); the
    // matchroom whitelist filters them out so listeners don't waste
    // bandwidth or parse cycles.
    for (const type of ["feed_entry", "narrative", "play", "preload", "phase", "illustration"]) {
      assert.equal(
        matchroomTransform({ type, payload: 1 }),
        null,
        `${type} should NOT reach matchroom clients`,
      );
    }
  });

  it("drops latency_sample (operator-only diagnostic)", () => {
    const cue = {
      type: "latency_sample",
      goalContentTime: "23",
      rawDeltaSeconds: 28.4,
      configuredOffsetSeconds: 30,
      sourceName: "TalkSPORT",
    };
    assert.equal(matchroomTransform(cue), null);
  });

  it("drops unknown cue types — defaults to safe even for future runner observations", () => {
    // The whitelist is the wall — if a new operator-only cue lands
    // and someone forgets to add a transform branch, it must default
    // to "drop" rather than "leak to viewers". This test pins that
    // contract.
    assert.equal(
      matchroomTransform({ type: "future_runner_observation", payload: 1 }),
      null,
    );
  });

  it("returns the input as-is for non-object inputs (defensive — kept from prior behaviour)", () => {
    assert.equal(matchroomTransform(null), null);
    assert.equal(matchroomTransform("string"), "string");
    assert.equal(matchroomTransform(42), 42);
  });
});

describe("toViewerEntry — feed-entry reshape (still used by buildBroadcastView)", () => {
  it("projects a match_events entry into the viewer DTO", () => {
    const result = toViewerEntry(goalEntry);
    assert.ok(result);
    assert.equal(result.id, "e1");
    assert.equal(result.eventType, "GOAL");
    assert.equal(result.isGoal, true);
    assert.equal(result.teamName, "Manchester City");
    assert.equal(result.player, "Erling Haaland");
  });

  it("returns null for non-match_events sources", () => {
    assert.equal(
      toViewerEntry({ ...goalEntry, source: "transcription" }),
      null,
    );
  });

  it("returns null for pressure / zone signal entries", () => {
    for (const eventType of ["PRESSURE_UPDATE", "ZONE_ENTRY", "ZONE_MIDDLE"]) {
      const entry = { ...goalEntry, data: { ...goalEntry.data, eventType } };
      assert.equal(toViewerEntry(entry), null, `${eventType} should not reach viewers`);
    }
  });
});
