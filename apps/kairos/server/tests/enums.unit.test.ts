import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isBroadcastStatus, isSourceType } from "../src/db/enums.js";
import { isPacingSignal } from "../src/curation/types.js";

describe("runtime enum guards", () => {
  describe("isBroadcastStatus", () => {
    it("accepts every known value", () => {
      for (const value of ["pending", "active", "paused", "complete"]) {
        assert.equal(isBroadcastStatus(value), true, value);
      }
    });

    it("rejects case variants, unknown values, and non-strings", () => {
      assert.equal(isBroadcastStatus("ACTIVE"), false);
      assert.equal(isBroadcastStatus("running"), false);
      assert.equal(isBroadcastStatus(""), false);
      assert.equal(isBroadcastStatus(null), false);
      assert.equal(isBroadcastStatus(undefined), false);
      assert.equal(isBroadcastStatus(42), false);
    });
  });

  describe("isSourceType", () => {
    it("accepts every known value", () => {
      for (const value of ["event", "moderator", "narrative_context", "narrative_voice"]) {
        assert.equal(isSourceType(value), true, value);
      }
    });

    it("rejects unknown values and non-strings", () => {
      assert.equal(isSourceType("events"), false);
      assert.equal(isSourceType("narrativeVoice"), false);
      assert.equal(isSourceType(null), false);
      assert.equal(isSourceType({}), false);
    });
  });

  describe("isPacingSignal", () => {
    it("accepts every known value", () => {
      for (const value of ["slow_down", "speed_up", "on_track"]) {
        assert.equal(isPacingSignal(value), true, value);
      }
    });

    it("rejects unknown values and non-strings", () => {
      assert.equal(isPacingSignal("slowdown"), false);
      assert.equal(isPacingSignal("SLOW_DOWN"), false);
      assert.equal(isPacingSignal(""), false);
      assert.equal(isPacingSignal(null), false);
      assert.equal(isPacingSignal(0), false);
    });
  });
});
