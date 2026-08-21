import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  OFFSET_EWMA_ALPHA,
  OFFSET_MAX_SECONDS,
  OFFSET_MIN_SECONDS,
  applyCalibrationSample,
} from "../src/lib/broadcast-subject-offset.js";

/**
 * Calibration loop — the EWMA update that closes the audio→canonical
 * timing gap during a broadcast.
 *
 * Existed in dead-loop form before 2026-05-10: `recordObservation`
 * wrote `lastObservedOffsetSeconds` to the radio_sources table on
 * every match, but no code path read it back. The seeded
 * `defaultOffsetSeconds` was the only value that ever reached
 * stamping. Three sources had 70 historical matches (last Δ −24s
 * and −67s vs seed of 45s) recorded but never applied.
 *
 * `applyCalibrationSample` is the single canonical update — anything
 * that mutates the effective offset must go through it. Pinning the
 * formula here means a regression in the math is caught the next
 * time someone rounds α or flips a sign.
 */

describe("applyCalibrationSample — EWMA arithmetic", () => {
  it("negative delta (audio behind canonical) grows the offset", () => {
    // Audio LINE observed AFTER the canonical wall-clock means we're
    // subtracting too LITTLE — the effective offset is too small.
    // Need to grow it. With α=0.3 and Δ=-10: 30 - 0.3*(-10) = 33.
    assert.equal(applyCalibrationSample(30, -10), 33);
  });

  it("positive delta (audio ahead of canonical) shrinks the offset", () => {
    // Audio LINE observed BEFORE the canonical wall-clock means we're
    // subtracting too MUCH. Shrink. 30 - 0.3*20 = 24.
    assert.equal(applyCalibrationSample(30, 20), 24);
  });

  it("zero delta leaves the offset unchanged", () => {
    assert.equal(applyCalibrationSample(45, 0), 45);
  });

  it(`clamps to [${OFFSET_MIN_SECONDS}, ${OFFSET_MAX_SECONDS}] seconds`, () => {
    // Would-be result -28: clamped up to 0.
    assert.equal(applyCalibrationSample(2, 100), OFFSET_MIN_SECONDS);
    // Would-be result 130: clamped down to 120.
    assert.equal(applyCalibrationSample(115, -50), OFFSET_MAX_SECONDS);
  });

  it("converges toward the true offset (with realistic Δ feedback)", () => {
    // The signed convention: Δ = canonical_wall_clock − claim_observedAtMs
    // = (real_action_time + sportmonks_lag) − (real_action_time + audio_delay − currentOffset)
    // = sportmonks_lag − audio_delay + currentOffset
    // = currentOffset − (audio_delay − sportmonks_lag)
    // = currentOffset − TRUE_OFFSET
    //
    // That feedback makes the EWMA a stable contraction toward
    // TRUE_OFFSET. Simulating Δ as a constant (no feedback) would
    // produce runaway, which is precisely what an earlier draft of
    // this test got wrong — keeping the simulation honest is part of
    // what's being pinned here.
    const TRUE_OFFSET = 55;
    let offset = 30;
    for (let i = 0; i < 50; i++) {
      const observedDelta = offset - TRUE_OFFSET;
      offset = applyCalibrationSample(offset, observedDelta);
    }
    assert.ok(
      Math.abs(offset - TRUE_OFFSET) < 0.5,
      `expected EWMA to converge near ${TRUE_OFFSET}, got ${offset}`,
    );
  });

  it("a single outlier shifts the offset by exactly α × |Δ|", () => {
    // Locks the step size — if α drifts to 0.5, this catches it.
    const before = 45;
    const delta = -20;
    const after = applyCalibrationSample(before, delta);
    assert.equal(after - before, OFFSET_EWMA_ALPHA * (-delta));
  });

  it("ten alternating ±20 samples leave the offset within ~5s of the start", () => {
    // Catches: alpha too aggressive (oscillation amplitude grows).
    let offset = 45;
    for (let i = 0; i < 10; i++) {
      offset = applyCalibrationSample(offset, i % 2 === 0 ? -20 : 20);
    }
    assert.ok(
      Math.abs(offset - 45) < 5,
      `alternating samples should not drive a runaway oscillation; ended at ${offset}`,
    );
  });
});

describe("calibration loop — write-then-read contract", () => {
  // Note on coverage: the dead-loop bug (writes that nobody reads)
  // can't be caught by a pure-function test. The structural
  // protection now in place: `applyCalibrationSample` is the single
  // export that returns the new offset, and `BroadcastRunner.
  // emitCalibrationSample` is the single caller that mutates
  // `effectiveOffsetSeconds` from its result. Anything that updates
  // the offset goes through this function — review checklist for
  // changes to broadcast-runner.ts: any new write site should be
  // suspect, any existing read site (transcription anchor, moderator
  // anchor) reading from a different field is a regression.

  it("the formula's fixed-point is the seed offset when Δ averages to zero", () => {
    // If calibration samples average to zero (the radio is correctly
    // calibrated), the effective offset should stay at the seed.
    // Catches: an additive bias in the formula.
    let offset = 30;
    for (let i = 0; i < 20; i++) {
      offset = applyCalibrationSample(offset, i % 2 === 0 ? -10 : 10);
    }
    assert.ok(
      Math.abs(offset - 30) < 1,
      `zero-mean samples should leave offset near seed; got ${offset}`,
    );
  });
});
