import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PressurePipeline, type PressureSignal } from "../src/pipeline/pressure.js";

/**
 * Pressure-pipeline data-quality contracts surfaced during the
 * 2026-04-26 FA Cup semi-final.
 *
 * Two real bugs:
 *   1. Per-team `lastContentTime` was emitted with each pressure_update
 *      tick. When ball coordinates arrived out of order across teams,
 *      consecutive emits had non-monotonic minute stamps (28 regressions
 *      during the broadcast). Fix: pressure-tick emits `subjectTime: null`
 *      so the broadcast-runner stamps a global `getSubjectTime()` value.
 *   2. `attackingThirdShare = attackingThirdMsAccumulated / phaseDurationMs`
 *      reset both numerator and denominator on every zone re-entry, so
 *      share rounded toward 1.0 immediately after entry. 75% of values
 *      during the broadcast were stuck at 100%. Fix: phase clock anchors
 *      to the match phase and only resets via `phaseChanged()` (called
 *      from `setPeriod` on countsFrom transition or by external trigger).
 *      Per-attack counters still reset on zone re-entry.
 *
 * Tests drive emits deterministically via `_tickForTest()` — no real-
 * timer setInterval flakiness.
 */

interface ManualClock {
  now: () => number;
  advance: (ms: number) => void;
}

function manualClock(start = 1_000_000): ManualClock {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function harness() {
  const clock = manualClock();
  const signals: PressureSignal[] = [];
  const pipeline = new PressurePipeline({
    emitIntervalMs: 60_000, // irrelevant — we drive ticks manually
    warmupMs: 0,
    zoneCommitSamples: 1,
    now: clock.now,
  });
  pipeline.start((s) => signals.push(s));
  return { pipeline, clock, signals };
}

describe("PressurePipeline — pressure_update.subjectTime is always null", () => {
  it("emits null even after ball-position inputs supplied a subjectTime", () => {
    const { pipeline, clock, signals } = harness();
    pipeline.setPeriod({ countsFrom: 0 });

    // Two same-zone samples to commit the ball into home_attacking
    // (zoneCommitSamples plus the elif-then-else logic in
    // ingestBallPosition needs two samples to commit even at
    // zoneCommitSamples=1). Trends land AFTER commit so resetCounters
    // doesn't wipe them.
    pipeline.ingestBallPosition({ x: 0.8, y: 0.5, subjectTime: "5", wallClockMs: clock.now() });
    pipeline.ingestBallPosition({ x: 0.81, y: 0.5, subjectTime: "5", wallClockMs: clock.now() });
    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 1 });
    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 3 });

    clock.advance(30_000);
    pipeline.ingestBallPosition({ x: 0.85, y: 0.5, subjectTime: "6", wallClockMs: clock.now() });

    pipeline._tickForTest();
    pipeline.stop();

    const updates = signals.filter((s) => s.type === "pressure_update");
    assert.ok(updates.length > 0, "expected at least one pressure_update");
    for (const u of updates) {
      assert.equal(u.subjectTime, null, "pressure_update.subjectTime must be null (runner stamps global)");
    }
  });
});

describe("PressurePipeline — attackingThirdShare anchors to match phase", () => {
  it("does NOT reset accumulated time on zone re-entry within the same phase", () => {
    const { pipeline, clock, signals } = harness();
    pipeline.setPeriod({ countsFrom: 0 });

    // Sequence: home enters → 30s in third → leaves to middle for 30s →
    // re-enters → 10s in third.
    // Expected: ~40s in attacking third / ~70s phase ≈ 0.57 share.
    // Pre-fix: share would round toward 1.0 immediately after re-entry.

    pipeline.ingestBallPosition({ x: 0.8, y: 0.5, wallClockMs: clock.now() });
    clock.advance(30_000);
    pipeline.ingestBallPosition({ x: 0.8, y: 0.5, wallClockMs: clock.now() });
    pipeline.ingestBallPosition({ x: 0.5, y: 0.5, wallClockMs: clock.now() });
    clock.advance(30_000);
    pipeline.ingestBallPosition({ x: 0.5, y: 0.5, wallClockMs: clock.now() });
    pipeline.ingestBallPosition({ x: 0.85, y: 0.5, wallClockMs: clock.now() });
    clock.advance(10_000);
    pipeline.ingestBallPosition({ x: 0.85, y: 0.5, wallClockMs: clock.now() });

    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 1 });
    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 5 });

    pipeline._tickForTest();
    pipeline.stop();

    const updates = signals.filter((s) => s.type === "pressure_update" && s.team === "home");
    assert.ok(updates.length > 0, "expected a home pressure_update");
    const u = updates[updates.length - 1];
    if (u.type !== "pressure_update") return;
    assert.ok(
      u.attackingThirdShare < 0.95,
      `share must not be saturated after partial-phase territory; got ${u.attackingThirdShare}`,
    );
    assert.ok(
      u.attackingThirdShare > 0.4,
      `share should reflect ~40s of 70s in attacking third; got ${u.attackingThirdShare}`,
    );
  });

  it("does NOT saturate under rapid oscillation across the attacking third", () => {
    // Ball swings into and out of the attacking third repeatedly within
    // one phase (real-world: end-to-end play). Per-attack counters reset
    // on every entry, but phase-anchored accumulation must not. Saturation
    // would mean phase clock is being reset on each entry — the bug fixed
    // 2026-04-26 was 75% of values stuck at 100% under exactly this
    // pattern.
    const { pipeline, clock, signals } = harness();
    pipeline.setPeriod({ countsFrom: 0 });

    // Five swings into the attacking third — 5s in third, 10s in middle,
    // repeated. Total: 25s in third, 50s in middle → expected ~0.33.
    for (let i = 0; i < 5; i++) {
      pipeline.ingestBallPosition({ x: 0.85, y: 0.5, wallClockMs: clock.now() });
      clock.advance(5_000);
      pipeline.ingestBallPosition({ x: 0.85, y: 0.5, wallClockMs: clock.now() });
      pipeline.ingestBallPosition({ x: 0.5, y: 0.5, wallClockMs: clock.now() });
      clock.advance(10_000);
      pipeline.ingestBallPosition({ x: 0.5, y: 0.5, wallClockMs: clock.now() });
    }

    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 1 });
    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 5 });

    pipeline._tickForTest();
    pipeline.stop();

    const updates = signals.filter((s) => s.type === "pressure_update" && s.team === "home");
    assert.ok(updates.length > 0);
    const u = updates[updates.length - 1];
    if (u.type !== "pressure_update") return;
    // The bug being protected against is saturation at 1.0 — phase
    // clock resetting on every entry would round share toward 1.0
    // immediately. Anything < 0.95 means the phase clock survived
    // five entries.
    assert.ok(
      u.attackingThirdShare < 0.95,
      `rapid oscillation must not saturate; got ${u.attackingThirdShare}`,
    );
    assert.ok(
      u.attackingThirdShare > 0.1,
      `share should reflect real time in third; got ${u.attackingThirdShare}`,
    );
  });
});

describe("PressurePipeline — phaseChanged resets the phase clock", () => {
  it("resets phaseDurationSeconds when setPeriod sees countsFrom change", () => {
    const { pipeline, clock, signals } = harness();
    pipeline.setPeriod({ countsFrom: 0 }); // 1H

    pipeline.ingestBallPosition({ x: 0.8, y: 0.5, wallClockMs: clock.now() });
    clock.advance(30_000);
    pipeline.ingestBallPosition({ x: 0.8, y: 0.5, wallClockMs: clock.now() });

    // Phase boundary — countsFrom flips to 45 (2H).
    pipeline.setPeriod({ countsFrom: 45 });

    pipeline.ingestBallPosition({ x: 0.2, y: 0.5, wallClockMs: clock.now() });
    clock.advance(5_000);
    pipeline.ingestBallPosition({ x: 0.2, y: 0.5, wallClockMs: clock.now() });

    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 1 });
    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 2 });

    pipeline._tickForTest();
    pipeline.stop();

    const updates = signals.filter((s) => s.type === "pressure_update" && s.team === "home");
    assert.ok(updates.length > 0, "expected a home pressure_update in the second half");
    const u = updates[updates.length - 1];
    if (u.type !== "pressure_update") return;
    assert.ok(
      u.phaseDurationSeconds <= 10,
      `phaseDurationSeconds must reset on phase change; got ${u.phaseDurationSeconds}`,
    );
  });

  it("explicit phaseChanged() also resets, independent of setPeriod", () => {
    const { pipeline, clock, signals } = harness();
    pipeline.setPeriod({ countsFrom: 0 });

    pipeline.ingestBallPosition({ x: 0.8, y: 0.5, wallClockMs: clock.now() });
    clock.advance(60_000);
    pipeline.ingestBallPosition({ x: 0.8, y: 0.5, wallClockMs: clock.now() });

    // External operator/conductor trigger.
    pipeline.phaseChanged(clock.now());

    pipeline.ingestBallPosition({ x: 0.85, y: 0.5, wallClockMs: clock.now() });
    clock.advance(2_000);
    pipeline.ingestBallPosition({ x: 0.85, y: 0.5, wallClockMs: clock.now() });

    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 1 });
    pipeline.ingestTrend({ team: { side: "home", name: "Home" }, statName: "attacks", value: 2 });

    pipeline._tickForTest();
    pipeline.stop();

    const updates = signals.filter((s) => s.type === "pressure_update" && s.team === "home");
    assert.ok(updates.length > 0);
    const u = updates[updates.length - 1];
    if (u.type !== "pressure_update") return;
    assert.ok(
      u.phaseDurationSeconds <= 5,
      `phaseChanged() must reset the phase clock; got ${u.phaseDurationSeconds}s`,
    );
  });
});
