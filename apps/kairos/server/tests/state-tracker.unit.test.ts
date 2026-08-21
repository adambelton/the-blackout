import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BroadcastStateTracker } from "../src/curation/state-tracker.js";
import type { ServiceRegistry } from "../src/registry.js";

// The tracker only calls registry.getSnapshots() via getServiceSnapshots,
// which these tests don't touch. A structural stub keeps them isolated.
const registry = { getSnapshots: () => [] } as unknown as ServiceRegistry;

describe("BroadcastStateTracker — estimated wpm", () => {
  it("returns null before any pacing signal has been recorded", () => {
    const tracker = new BroadcastStateTracker("b1", registry);
    assert.equal(tracker.getEstimatedWpm(), null);
  });

  it("seeds the estimate with the first reported wpm", () => {
    const tracker = new BroadcastStateTracker("b1", registry);
    tracker.recordPacingSignal({ signal: "on_track", wordsPerMinute: 160, receivedAt: 0 });
    assert.equal(tracker.getEstimatedWpm(), 160);
  });

  it("blends a nearby report via EMA (alpha=0.3) when within the per-sample step bound", () => {
    const tracker = new BroadcastStateTracker("b1", registry);
    tracker.recordPacingSignal({ signal: "on_track", wordsPerMinute: 150, receivedAt: 0 });
    // |160 - 150| = 10, inside the ±20 per-sample bound — no truncation.
    tracker.recordPacingSignal({ signal: "on_track", wordsPerMinute: 160, receivedAt: 1 });
    // 0.3 * 160 + 0.7 * 150 = 153
    assert.equal(tracker.getEstimatedWpm(), 153);
  });

  it("bounds a single outlier sample to WPM_STEP_MAX before the EMA blend", () => {
    const tracker = new BroadcastStateTracker("b1", registry);
    tracker.recordPacingSignal({ signal: "on_track", wordsPerMinute: 150, receivedAt: 0 });
    // A Hume clip with a long silent trailer reports 60 wpm. Clamped to
    // 80 by the min bound, then further bounded to 130 (150 − 20) before
    // blending. 0.3 * 130 + 0.7 * 150 = 144.
    tracker.recordPacingSignal({ signal: "slow_down", wordsPerMinute: 60, receivedAt: 1 });
    assert.equal(tracker.getEstimatedWpm(), 144);
  });

  it("tracks a real drift across consecutive samples despite the per-sample bound", () => {
    const tracker = new BroadcastStateTracker("b1", registry);
    tracker.recordPacingSignal({ signal: "on_track", wordsPerMinute: 150, receivedAt: 0 });
    // Narrator voice legitimately shifted to ~180 wpm. Each sample
    // steps the estimate up by α × WPM_STEP_MAX = 6, converging on 180
    // across a handful of cycles — the bound caps per-sample move, not
    // total drift.
    for (let i = 1; i <= 8; i++) {
      tracker.recordPacingSignal({ signal: "speed_up", wordsPerMinute: 180, receivedAt: i });
    }
    const wpm = tracker.getEstimatedWpm();
    assert.ok(wpm != null && wpm > 170, `expected estimate to climb toward 180 after consecutive samples, got ${wpm}`);
    assert.ok(wpm != null && wpm <= 180, `estimate must not exceed the sample value, got ${wpm}`);
  });

  it("clamps pathological reports into the 80–220 bound before the step-bound + blend", () => {
    const tracker = new BroadcastStateTracker("b1", registry);
    tracker.recordPacingSignal({ signal: "slow_down", wordsPerMinute: 400, receivedAt: 0 });
    // Clamped to 220 on seed.
    assert.equal(tracker.getEstimatedWpm(), 220);

    // Sample of 30 gets clamped to 80, then the per-sample bound caps
    // the move to 220 − 20 = 200 before the EMA. 0.3 * 200 + 0.7 * 220 = 214.
    tracker.recordPacingSignal({ signal: "speed_up", wordsPerMinute: 30, receivedAt: 1 });
    assert.equal(tracker.getEstimatedWpm(), 214);
  });
});
