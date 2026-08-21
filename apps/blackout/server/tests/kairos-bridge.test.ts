import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signalFor } from "../src/lib/kairos-bridge.js";

/**
 * Pure helpers from `kairos-bridge.ts`. The full activation/completion
 * orchestration is integration-test territory (mocking kairos client +
 * DB + conductor + broadcast-runner) and is deferred until those
 * subsystems are extracted enough to test in isolation.
 *
 * What this file pins now: `signalFor` — the per-passage TTS pacing
 * threshold that decides whether to ask Kairos to slow down, speed
 * up, or hold pace. Mis-bucketing here flips the model's prose
 * length the wrong way.
 */

describe("signalFor — TTS pacing thresholds", () => {
  // Targets are 140 wpm (lower) and 200 wpm (upper) — Hemingway-voiced
  // narration at narrator pace. These are pinned at the call site
  // (kairos-bridge.ts:273) and feed Kairos's pacing service.

  it("on_track when wpm sits inside [140, 200]", () => {
    assert.equal(signalFor(140), "on_track");
    assert.equal(signalFor(160), "on_track");
    assert.equal(signalFor(180), "on_track");
    assert.equal(signalFor(200), "on_track");
  });

  it("speed_up when wpm is below 140 (narrator falling behind)", () => {
    assert.equal(signalFor(139), "speed_up");
    assert.equal(signalFor(100), "speed_up");
    assert.equal(signalFor(0), "speed_up");
  });

  it("slow_down when wpm is above 200 (narrator outrunning the action)", () => {
    assert.equal(signalFor(201), "slow_down");
    assert.equal(signalFor(220), "slow_down");
    assert.equal(signalFor(500), "slow_down");
  });

  it("threshold boundaries are inclusive at 140 and 200", () => {
    // Sub-bucketing: 140 = on_track (not speed_up), 200 = on_track
    // (not slow_down). Off-by-one in either direction would cause the
    // pacing service to oscillate around the boundary.
    assert.equal(signalFor(140), "on_track");
    assert.equal(signalFor(200), "on_track");
    assert.equal(signalFor(139.999), "speed_up");
    assert.equal(signalFor(200.001), "slow_down");
  });
});
