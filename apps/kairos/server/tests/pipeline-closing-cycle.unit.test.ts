import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import {
  CyclePipeline,
  type FlushTrigger,
  type PipelineCycleRecord,
  type PipelineRegistry,
} from "../src/pipeline/pipeline.js";
import type { EnrichedPayload } from "../src/enrichment/types.js";
import type { FeedEntry } from "../src/types.js";

/**
 * Closing-cycle boundary contract.
 *
 * When an entry carries a `closingExtensionSeconds: number` marker on
 * its data payload, the pipeline pins the next closing cycle's drain
 * end at `entry.ordinal + extensionSeconds`. Wall-clock dispatch
 * target is `delayMs + extensionSeconds * 1000` from observation.
 *
 * Cadence cycles before that point continue to dispatch normally with
 * their natural boundary — the marker doesn't suppress cadence, just
 * pins one specific cycle's end. A force timer ensures dispatch even
 * if no further cadence ticks land in time (silent post-boundary
 * window).
 *
 * Tests use `mock.timers` to avoid wall-clock waits.
 */

function fakeRegistry(): PipelineRegistry {
  return {
    getEnrichmentServices: () => [],
    persistEnrichmentStates: async () => {},
    getSnapshots: () => [],
  };
}

interface EntryOptions {
  phase?: string;
  phaseSecond?: number;
  eventType?: string;
  closingExtensionSeconds?: number;
  closingPrompt?: string;
  sourceName?: string;
}

let nextEntryId = 0;
function entry(opts: EntryOptions = {}): FeedEntry {
  nextEntryId++;
  const data: Record<string, unknown> = { content: `entry ${nextEntryId}` };
  if (opts.phase !== undefined) data.phase = opts.phase;
  if (opts.phaseSecond !== undefined) data.phaseSecond = opts.phaseSecond;
  if (opts.eventType !== undefined) data.eventType = opts.eventType;
  if (opts.closingExtensionSeconds !== undefined) {
    data.closingExtensionSeconds = opts.closingExtensionSeconds;
  }
  if (opts.closingPrompt !== undefined) {
    data.closingPrompt = opts.closingPrompt;
  }
  return {
    id: `e${nextEntryId}`,
    broadcastId: "b1",
    sourceId: "s1",
    sourceName: opts.sourceName ?? "match_events",
    sourceType: "event",
    timestamp: Date.now(),
    data,
    enrichmentTags: [],
  };
}

interface CapturedCycle {
  reason: string;
  trigger: FlushTrigger;
  entryIds: string[];
  drainBoundary: number | undefined;
  consumerPrompt: string | undefined;
}

function makePipeline(opts: { delayMs?: number; flushIntervalMs?: number; maxConsecutiveEmptyCycles?: number } = {}): {
  pipeline: CyclePipeline;
  cycles: CapturedCycle[];
} {
  const cycles: CapturedCycle[] = [];
  // Curator captures the enriched payload (entries + drainBoundary)
  // when curate runs. persistCycle runs after the curator inside the
  // pipeline's runCycle and supplies the flushTrigger; we patch it
  // onto the most-recently-pushed cycle entry.
  const curator = {
    curate: async (enriched: EnrichedPayload, reason: string, consumerPrompt?: string) => {
      cycles.push({
        reason,
        trigger: "cadence",
        entryIds: enriched.entries.map((e) => e.id),
        drainBoundary: enriched.drainBoundaryOrdinal,
        consumerPrompt,
      });
      return { curated: null, handlerResult: null };
    },
  };
  const persistCycle = async (row: PipelineCycleRecord) => {
    const last = cycles[cycles.length - 1];
    if (last) last.trigger = row.flushTrigger;
    return null;
  };
  const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, {
    persistCycle,
    maxConsecutiveEmptyCycles: opts.maxConsecutiveEmptyCycles ?? 100,
    delayMs: opts.delayMs ?? 60_000,
    flushIntervalMs: opts.flushIntervalMs ?? 45_000,
  });
  return { pipeline, cycles };
}

describe("CyclePipeline closing-cycle — pinning the boundary", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("an entry with closingExtensionSeconds=15 dispatches a closing cycle at T + delayMs + 15_000ms", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const fhGoal = entry({ phase: "first_half", phaseSecond: 720, eventType: "GOAL" });
    pipeline.onEntry(fhGoal);
    const halftime = entry({
      phase: "halftime",
      phaseSecond: 0,
      eventType: "HALFTIME",
      closingExtensionSeconds: 15,
    });
    pipeline.onEntry(halftime);

    assert.equal(cycles.length, 0, "no cycle before the dispatch target");

    mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(cycles.length, 0, "still nothing at T+60s — extension hasn't elapsed");

    mock.timers.tick(15_500); // +15s extension + 100ms grace + slack
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].reason, "accumulation");
    assert.equal(cycles[0].trigger, "closing");
    // Both 1H goal and HT entry are inside the boundary (halftime + 15 = 2_000_015).
    assert.deepEqual(cycles[0].entryIds.sort(), [fhGoal.id, halftime.id].sort());
    assert.equal(cycles[0].drainBoundary, 2_000_015, "drain boundary pinned at whistle + 15s");
  });

  it("any extension value works — 0 dispatches at the boundary itself, 30 extends further", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 0, closingExtensionSeconds: 30 }));

    mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(cycles.length, 0);

    mock.timers.tick(30_500); // +30s extension
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].drainBoundary, 2_000_030);
  });

  it("an entry without closingExtensionSeconds doesn't pin anything", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    // Plain GOAL — no marker. Cadence isn't running (start() not called),
    // so no cycles fire even after time advances.
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 720, eventType: "GOAL" }));

    mock.timers.tick(120_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(cycles.length, 0);
  });

  it("the trigger entry itself lands in the closing cycle", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const halftime = entry({
      phase: "halftime",
      phaseSecond: 0,
      closingExtensionSeconds: 15,
    });
    pipeline.onEntry(halftime);

    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0].entryIds, [halftime.id]);
  });

  it("threads closingPrompt through as the closing cycle's consumer-prompt", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({
      phase: "halftime",
      phaseSecond: 0,
      closingExtensionSeconds: 15,
      closingPrompt: "Narrate to the whistle as the final beat.",
    }));

    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].trigger, "closing");
    assert.equal(cycles[0].consumerPrompt, "Narrate to the whistle as the final beat.");
  });

  it("closing cycle has no consumer-prompt when the trigger entry omits closingPrompt", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({
      phase: "halftime",
      phaseSecond: 0,
      closingExtensionSeconds: 15,
    }));

    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cycles.length, 1);
    assert.equal(cycles[0].consumerPrompt, undefined);
  });
});

describe("CyclePipeline closing-cycle — cadence interaction during the wait", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("cadence dispatches normal pre-whistle cycles while the wait is open (natural boundary < whistle)", async () => {
    // The marker pins ONE cycle's end. Cadence ticks before that cycle
    // dispatch normally with their natural boundary, draining
    // pre-whistle content as it ripens. This is the user's
    // "cadence dispatches on schedule" principle.
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000, flushIntervalMs: 30_000 });

    // Push pre-whistle content + the closing marker.
    const earlyContent = entry({ phase: "first_half", phaseSecond: 600 });
    pipeline.onEntry(earlyContent);
    pipeline.onEntry(entry({
      phase: "halftime",
      phaseSecond: 0,
      closingExtensionSeconds: 15,
    }));

    pipeline.start();

    // First cadence tick at +30s: naturalBoundary = 2_000_000 - 60 = 1_999_940.
    // Whistle ordinal = 2_000_000. naturalBoundary < whistle, so dispatch.
    // Drains entries ≤ 1_999_940 — earlyContent (ordinal 1_000_600) qualifies; HT held.
    mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(cycles.length >= 1, "cadence dispatched a pre-whistle cycle");
    const preWhistle = cycles.find((c) => c.entryIds.includes(earlyContent.id));
    assert.ok(preWhistle, "earlyContent drained on the pre-whistle cadence cycle");
    assert.equal(preWhistle!.trigger, "cadence");

    // Closing dispatches at +75s with the pinned boundary.
    mock.timers.tick(50_000);
    await pipeline.waitForIdle();
    await new Promise((r) => setImmediate(r));
    await pipeline.waitForIdle();
    const closing = cycles.find((c) => c.trigger === "closing");
    assert.ok(closing, "closing cycle dispatched");
    assert.equal(closing!.drainBoundary, 2_000_015);
  });

  it("a cadence tick whose natural boundary would cross the whistle is skipped — closing fires on its target instead", async () => {
    // Force a tick whose natural boundary >= whistle by pushing a
    // post-whistle entry that advances highestObservedOrdinal past
    // (whistle + delay). The cadence tick should then SKIP rather
    // than draining past the whistle on its own.
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000, flushIntervalMs: 30_000 });

    pipeline.onEntry(entry({
      phase: "halftime",
      phaseSecond: 0,
      closingExtensionSeconds: 15,
    }));
    // Post-whistle entry at phaseSecond=80 — ordinal 2_000_080. Natural
    // boundary at next tick = 2_000_080 - 60 = 2_000_020 > whistle (2_000_000).
    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 80 }));

    pipeline.start();

    // Cadence tick at +30s would naturally drain past the whistle.
    // Should be skipped.
    mock.timers.tick(30_000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(
      cycles.filter((c) => c.trigger === "cadence").length,
      0,
      "cadence skipped — natural boundary would cross whistle but closing target hasn't arrived",
    );

    // Closing fires at +75s.
    mock.timers.tick(50_000);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const closing = cycles.find((c) => c.trigger === "closing");
    assert.ok(closing);
    assert.equal(closing!.drainBoundary, 2_000_015);
  });

  it("after the closing dispatches, cadence resumes normally", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000, flushIntervalMs: 30_000 });

    pipeline.onEntry(entry({
      phase: "halftime",
      phaseSecond: 0,
      closingExtensionSeconds: 15,
    }));
    pipeline.start();

    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const closingCount = cycles.filter((c) => c.trigger === "closing").length;
    assert.equal(closingCount, 1);

    // After closing, push another marker — cadence + new closing should still work.
    pipeline.onEntry(entry({
      phase: "second_half",
      phaseSecond: 2700,
      eventType: "FULL_TIME",
      closingExtensionSeconds: 15,
    }));

    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const closingAfter = cycles.filter((c) => c.trigger === "closing").length;
    assert.equal(closingAfter, 2, "second closing fires after first one resolved");
  });
});

describe("CyclePipeline closing-cycle — most-recent boundary wins", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("a second closing marker arriving during the wait overrides the first", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 0, closingExtensionSeconds: 15 }));
    mock.timers.tick(30_000);

    pipeline.onEntry(entry({ phase: "full_time", phaseSecond: 0, closingExtensionSeconds: 15 }));

    // Original HT-anchored timer should be cancelled; new FT-anchored
    // timer fires 75s after the second observation.
    mock.timers.tick(45_500); // total 75500 from HT, only 45500 from FT
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(cycles.length, 0, "first timer cancelled — second timer not yet ripe");

    mock.timers.tick(30_500); // now +75500 from FT
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(cycles.length, 1, "closing dispatches at the more-recent boundary's target");
  });
});

describe("CyclePipeline closing-cycle — late arrivals", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("entries with ordinal ≤ closing boundary arriving after the closing dispatch are late-discarded", async () => {
    const { pipeline } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 0, closingExtensionSeconds: 15 }));
    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // Late-arriving 1H commentary — first_half ordinals are below the
    // halftime + 15 boundary, so this entry is late.
    const late = entry({ phase: "first_half", phaseSecond: 2900 });
    pipeline.onEntry(late);

    assert.equal(pipeline.getLateDiscardedCount(), 1);
  });
});

describe("CyclePipeline closing-cycle — consumer-prompt sequencing", () => {
  beforeEach(() => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
  });
  afterEach(() => {
    mock.timers.reset();
  });

  it("defers a consumer-prompt cycle that arrives while a closing is pending", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const fhContent = entry({ phase: "first_half", phaseSecond: 2700 });
    pipeline.onEntry(fhContent);
    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 0, closingExtensionSeconds: 15 }));

    // Conductor fires HALFTIME_REFLECTION_PROMPT immediately on phase
    // observation. Without deferral, this would drainAll and steal the
    // closing-1H content from under the closing dispatch.
    const reflectPromise = pipeline.flush({ consumerPrompt: "halftime reflection" });

    await new Promise((r) => setImmediate(r));
    assert.equal(cycles.length, 0, "consumer-prompt cycle is deferred — no cycles dispatched yet");

    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cycles.length, 2);
    assert.equal(cycles[0].trigger, "closing", "closing cycle ran first");
    assert.ok(cycles[0].entryIds.includes(fhContent.id), "closing cycle includes 1H content");
    assert.equal(cycles[1].trigger, "consumer_prompt", "consumer-prompt cycle ran second as the reflection");
    assert.deepEqual(cycles[1].entryIds, [], "reflection cycle is empty (closing already drained)");

    const reflectResult = await reflectPromise;
    assert.ok(reflectResult);
    assert.deepEqual(reflectResult!.entries, []);
  });

  it("a non-consumer-prompt flush() is NOT deferred while a closing is pending", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 0, closingExtensionSeconds: 15 }));

    await pipeline.flush();
    assert.equal(cycles.length, 1, "manual cadence flush runs immediately");
    assert.equal(cycles[0].trigger, "cadence");
  });

  it("a second consumer-prompt during the wait overrides the first (most recent wins)", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 0, closingExtensionSeconds: 15 }));

    const firstPromise = pipeline.flush({ consumerPrompt: "first prompt" });
    const secondPromise = pipeline.flush({ consumerPrompt: "second prompt" });

    const firstResult = await firstPromise;
    assert.equal(firstResult, null, "first deferred prompt resolves null when overridden");

    mock.timers.tick(75_500);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(cycles.length, 2);
    assert.equal(cycles[1].trigger, "consumer_prompt");

    const secondResult = await secondPromise;
    assert.ok(secondResult);
  });

  it("stop() releases any deferred consumer-prompt promise", async () => {
    const { pipeline } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "halftime", phaseSecond: 0, closingExtensionSeconds: 15 }));
    const reflectPromise = pipeline.flush({ consumerPrompt: "halftime reflection" });

    pipeline.stop();
    const result = await reflectPromise;
    assert.equal(result, null);
  });
});
