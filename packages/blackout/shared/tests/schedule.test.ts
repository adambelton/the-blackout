import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { collectScheduleBlockers } from "../types/schedule.js";
import type { Broadcast } from "../types/broadcast.js";

function broadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "b1",
    homeTeam: "Burnley",
    awayTeam: "Manchester City",
    competition: "Premier League",
    matchDate: "2026-05-02T14:00:00.000Z",
    status: "draft",
    matchBrief: "Two clubs walking different paths.",
    fixtureId: 12345,
    radioSourceId: "radio-1",
    ttsVoiceId: "voice-uuid-1",
    ttsEnabled: true,
    createdAt: "2026-05-02T13:00:00.000Z",
    updatedAt: "2026-05-02T13:00:00.000Z",
    ...overrides,
  } as Broadcast;
}

describe("collectScheduleBlockers", () => {
  it("returns an empty list when every prereq is satisfied", () => {
    assert.deepEqual(collectScheduleBlockers(broadcast()), []);
  });

  it("flags an empty match brief", () => {
    assert.deepEqual(collectScheduleBlockers(broadcast({ matchBrief: "" })), [
      "match brief is empty",
    ]);
    assert.deepEqual(collectScheduleBlockers(broadcast({ matchBrief: "   " })), [
      "match brief is empty",
    ]);
    assert.deepEqual(collectScheduleBlockers(broadcast({ matchBrief: undefined })), [
      "match brief is empty",
    ]);
  });

  it("flags a missing fixture", () => {
    assert.deepEqual(collectScheduleBlockers(broadcast({ fixtureId: null })), [
      "fixture not set",
    ]);
  });

  it("flags a missing radio source", () => {
    assert.deepEqual(collectScheduleBlockers(broadcast({ radioSourceId: null })), [
      "radio source not set",
    ]);
  });

  it("flags TTS enabled with no voice selected", () => {
    assert.deepEqual(
      collectScheduleBlockers(broadcast({ ttsEnabled: true, ttsVoiceId: undefined })),
      ["TTS is enabled but no voice is selected"],
    );
  });

  it("does not flag TTS when disabled with no voice", () => {
    assert.deepEqual(
      collectScheduleBlockers(broadcast({ ttsEnabled: false, ttsVoiceId: undefined })),
      [],
    );
  });

  it("returns every blocker when multiple prereqs are missing", () => {
    const blockers = collectScheduleBlockers(
      broadcast({ matchBrief: "", fixtureId: null, radioSourceId: null, ttsEnabled: true, ttsVoiceId: undefined }),
    );
    assert.equal(blockers.length, 4);
    assert.ok(blockers.includes("match brief is empty"));
    assert.ok(blockers.includes("fixture not set"));
    assert.ok(blockers.includes("radio source not set"));
    assert.ok(blockers.includes("TTS is enabled but no voice is selected"));
  });
});
