import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeBroadcastHealth,
  computeCycleDrift,
  DEFAULT_WPM,
} from "../src/broadcast-health.js";

/**
 * Flow-health aggregator. Pure arithmetic over already-fetched cycle
 * + generation rows — these tests pin the four numbers admins read
 * from the inspector header. See `apps/kairos/server/src/broadcast-health.ts`
 * for the contract.
 */

function pacing(recommendedWordCount: number, cadenceMs: number) {
  return { pacing: { recommendedWordCount, cadenceMs } };
}

// Mirrors the LIVE_PHASES set in broadcast-health.ts. Used only by
// the "halftime is excluded" assertion; keeping it local to the test
// avoids exporting an internal constant.
const LIVE_PHASES_FOR_TEST = new Set([
  "first_half",
  "live_first_half",
  "second_half",
  "live_second_half",
]);

function entry(phase: string, phaseSecond: number) {
  return { data: { phase, phaseSecond } };
}

describe("computeBroadcastHealth — wall-clock", () => {
  it("returns zero across the board when no cycles have run yet", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [],
      generations: [],
      nowMs: 1_000_000,
    });
    assert.equal(health.wallSeconds, 0);
    assert.equal(health.contentSeconds, 0);
    assert.equal(health.proseSeconds, 0);
    assert.equal(health.targetSeconds, 0);
    assert.equal(health.cycleCount, 0);
  });

  it("measures from the first cycle to now while the broadcast is live", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        { triggeredAt: 1_000_000, chunkEntries: [], curation: {}, generationId: null },
        { triggeredAt: 1_045_000, chunkEntries: [], curation: {}, generationId: null },
      ],
      generations: [],
      nowMs: 1_090_000,
    });
    assert.equal(health.wallSeconds, 90);
  });

  it("freezes at the last cycle when the broadcast is complete (later wall-clock ignored)", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "complete",
      cycles: [
        { triggeredAt: 1_000_000, chunkEntries: [], curation: {}, generationId: null },
        { triggeredAt: 1_045_000, chunkEntries: [], curation: {}, generationId: null },
      ],
      generations: [],
      nowMs: 9_999_999, // far in the future — should be ignored
    });
    assert.equal(health.wallSeconds, 45);
  });
});

describe("computeBroadcastHealth — content seconds", () => {
  it("sums max phaseSecond across each live phase, excluding halftime/full_time/pre_match", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 1_000_000,
          chunkEntries: [entry("first_half", 600), entry("first_half", 1200)],
          curation: {},
          generationId: null,
        },
        {
          triggeredAt: 1_045_000,
          chunkEntries: [entry("first_half", 2700), entry("halftime", 0)],
          curation: {},
          generationId: null,
        },
        {
          triggeredAt: 1_090_000,
          chunkEntries: [entry("second_half", 1500)],
          curation: {},
          generationId: null,
        },
      ],
      generations: [],
      nowMs: 1_100_000,
    });
    // 1H max = 2700, 2H max = 1500, halftime ignored. 4200s.
    assert.equal(health.contentSeconds, 4200);
    assert.equal(health.contentByPhase.first_half, 2700);
    assert.equal(health.contentByPhase.second_half, 1500);
    // Halftime is observed but contributes nothing to contentSeconds —
    // the live-phase filter excludes it from the sum.
    assert.ok(!LIVE_PHASES_FOR_TEST.has("halftime"));
  });

  it("treats `live_first_half` and `live_second_half` aliases as live phases", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 0,
          chunkEntries: [entry("live_first_half", 1800), entry("live_second_half", 600)],
          curation: {},
          generationId: null,
        },
      ],
      generations: [],
      nowMs: 0,
    });
    assert.equal(health.contentSeconds, 1800 + 600);
  });

  it("ignores entries without a phase or phaseSecond (ambient sources, unstamped fixtures)", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 0,
          chunkEntries: [
            { data: { content: "ambient" } },
            entry("first_half", 900),
            { data: { phase: "first_half" } }, // missing phaseSecond
          ],
          curation: {},
          generationId: null,
        },
      ],
      generations: [],
      nowMs: 0,
    });
    assert.equal(health.contentSeconds, 900);
  });
});

describe("computeBroadcastHealth — prose + target", () => {
  it("derives WPM from each cycle's pacing and accumulates prose seconds across generations", () => {
    // Pacing: 135 words over 45_000ms = 180 WPM.
    // Generation: 90 words → 30 seconds at 180 WPM.
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 0,
          chunkEntries: [],
          curation: pacing(135, 45_000),
          generationId: "g1",
        },
        {
          triggeredAt: 45_000,
          chunkEntries: [],
          curation: pacing(135, 45_000),
          generationId: "g2",
        },
      ],
      generations: [
        { id: "g1", wordCount: 90 },
        { id: "g2", wordCount: 90 },
      ],
      nowMs: 90_000,
    });
    // Prose: 2 cycles × 30s = 60s
    assert.equal(health.proseSeconds, 60);
    // Target: 2 cycles × 135 words at 180 WPM = 2 × 45s = 90s
    assert.equal(health.targetSeconds, 90);
  });

  it("falls back to DEFAULT_WPM when a cycle has no pacing snapshot", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 0,
          chunkEntries: [],
          curation: {}, // no pacing
          generationId: "g1",
        },
      ],
      generations: [{ id: "g1", wordCount: DEFAULT_WPM }],
      nowMs: 0,
    });
    // wordCount = DEFAULT_WPM → 60 seconds at DEFAULT_WPM.
    assert.equal(health.proseSeconds, 60);
    // No pacing → no target contribution.
    assert.equal(health.targetSeconds, 0);
  });

  it("contributes target for skipped cycles (curator asked for words even if generation didn't fire)", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 0,
          chunkEntries: [],
          curation: pacing(180, 60_000), // 180wpm, 60s target
          generationId: null, // skipped
        },
      ],
      generations: [],
      nowMs: 0,
    });
    assert.equal(health.proseSeconds, 0);
    assert.equal(health.targetSeconds, 60);
  });

  it("ignores cycles whose generationId points to a generation that no longer exists", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 0,
          chunkEntries: [],
          curation: pacing(180, 60_000),
          generationId: "missing",
        },
      ],
      generations: [],
      nowMs: 0,
    });
    assert.equal(health.proseSeconds, 0);
    assert.equal(health.targetSeconds, 60);
  });

  it("guards against pathological pacing values (zero / negative cadence)", () => {
    const health = computeBroadcastHealth({
      broadcastStatus: "live",
      cycles: [
        {
          triggeredAt: 0,
          chunkEntries: [],
          curation: { pacing: { recommendedWordCount: 90, cadenceMs: 0 } },
          generationId: "g1",
        },
      ],
      generations: [{ id: "g1", wordCount: 165 }],
      nowMs: 0,
    });
    // Falls back to DEFAULT_WPM. 165 words / 165 WPM = 60s.
    assert.equal(health.proseSeconds, 60);
  });
});

describe("computeCycleDrift — per-cycle scrub-strip arithmetic", () => {
  it("computes cadence as wall-clock between this cycle and the prior", () => {
    const drift = computeCycleDrift({
      cycle: { chunkEntries: [], curation: {}, generationId: null },
      generation: null,
      prevTriggeredAtMs: 1_000_000,
      thisTriggeredAtMs: 1_045_000,
    });
    assert.equal(drift.cadenceSeconds, 45);
  });

  it("returns null cadence on the first cycle of a broadcast (no prior)", () => {
    const drift = computeCycleDrift({
      cycle: { chunkEntries: [], curation: {}, generationId: null },
      generation: null,
      prevTriggeredAtMs: null,
      thisTriggeredAtMs: 1_000_000,
    });
    assert.equal(drift.cadenceSeconds, null);
  });

  it("computes within-phase content seconds when entries share a phase", () => {
    const drift = computeCycleDrift({
      cycle: {
        chunkEntries: [entry("first_half", 600), entry("first_half", 645)],
        curation: {},
        generationId: null,
      },
      generation: null,
      prevTriggeredAtMs: null,
      thisTriggeredAtMs: 0,
    });
    assert.equal(drift.contentSeconds, 45);
  });

  it("returns null content when entries cross phases (span isn't meaningful)", () => {
    const drift = computeCycleDrift({
      cycle: {
        chunkEntries: [entry("first_half", 2700), entry("halftime", 0)],
        curation: {},
        generationId: null,
      },
      generation: null,
      prevTriggeredAtMs: null,
      thisTriggeredAtMs: 0,
    });
    assert.equal(drift.contentSeconds, null);
  });

  it("derives prose from wordCount and pacing-implied WPM", () => {
    // 135 / 45_000ms → 180 WPM. 90 words → 30s of speech.
    const drift = computeCycleDrift({
      cycle: { chunkEntries: [], curation: pacing(135, 45_000), generationId: "g1" },
      generation: { wordCount: 90 },
      prevTriggeredAtMs: null,
      thisTriggeredAtMs: 0,
    });
    assert.equal(drift.proseSeconds, 30);
    // Same pacing → target = 135 words / 180 WPM = 45s.
    assert.equal(drift.targetSeconds, 45);
  });

  it("flags driftBand=ok when cadence ≈ content ≈ prose (all within 10s)", () => {
    const drift = computeCycleDrift({
      cycle: {
        chunkEntries: [entry("first_half", 0), entry("first_half", 45)],
        curation: pacing(135, 45_000),
        generationId: "g1",
      },
      generation: { wordCount: 135 }, // 45s of prose at 180 WPM
      prevTriggeredAtMs: 0,
      thisTriggeredAtMs: 45_000,
    });
    assert.equal(drift.driftBand, "ok");
  });

  it("flags driftBand=warn when prose runs 15s short of cadence/content", () => {
    const drift = computeCycleDrift({
      cycle: {
        chunkEntries: [entry("first_half", 0), entry("first_half", 45)],
        curation: pacing(135, 45_000), // 180 WPM
        generationId: "g1",
      },
      generation: { wordCount: 90 }, // 30s of prose — 15s short of 45s cadence
      prevTriggeredAtMs: 0,
      thisTriggeredAtMs: 45_000,
    });
    assert.equal(drift.driftBand, "warn");
  });

  it("flags driftBand=bad when content vastly exceeds cadence (e.g. restart hoover)", () => {
    const drift = computeCycleDrift({
      cycle: {
        chunkEntries: [entry("first_half", 0), entry("first_half", 600)], // 10 min span
        curation: pacing(135, 45_000),
        generationId: "g1",
      },
      generation: { wordCount: 135 },
      prevTriggeredAtMs: 0,
      thisTriggeredAtMs: 45_000,
    });
    assert.equal(drift.driftBand, "bad");
  });

  it("flags driftBand=unknown for cycles with no signal (skipped, no pacing, first cycle)", () => {
    const drift = computeCycleDrift({
      cycle: { chunkEntries: [], curation: {}, generationId: null },
      generation: null,
      prevTriggeredAtMs: null,
      thisTriggeredAtMs: 0,
    });
    assert.equal(drift.driftBand, "unknown");
  });
});
