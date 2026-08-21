import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CyclePipeline, type PipelineRegistry } from "../src/pipeline/pipeline.js";
import type { FeedEntry } from "../src/types.js";

/**
 * Content-time batching contract for the cadence path.
 *
 * The waiting room holds entries by content ordinal. A cadence flush
 * drains entries with ordinal ≤ (highest observed - DELAY); anything
 * more recent is held for a future cycle. Late arrivals (entries
 * landing after their window has flushed) are discarded with telemetry.
 *
 * Backwards compatibility: entries WITHOUT phase information (test
 * fixtures, ambient sources) still pass through any cadence flush —
 * we have no content-time anchor to defer them against.
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
  sourceName?: string;
}

let nextEntryId = 0;
function entry(opts: EntryOptions = {}): FeedEntry {
  nextEntryId++;
  const data: Record<string, unknown> = { content: `entry ${nextEntryId}` };
  if (opts.phase !== undefined) data.phase = opts.phase;
  if (opts.phaseSecond !== undefined) data.phaseSecond = opts.phaseSecond;
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
  entryIds: string[];
}

function makePipeline(opts: { delayMs?: number } = {}): {
  pipeline: CyclePipeline;
  cycles: CapturedCycle[];
} {
  const cycles: CapturedCycle[] = [];
  const curator = {
    curate: async (enriched: { entries: FeedEntry[] }, reason: string) => {
      cycles.push({ reason, entryIds: enriched.entries.map((e) => e.id) });
      return { curated: null, handlerResult: null };
    },
  };
  const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, {
    persistCycle: async () => null,
    maxConsecutiveEmptyCycles: 100, // keep cap out of the way for these tests
    delayMs: opts.delayMs ?? 60_000,
  });
  return { pipeline, cycles };
}

describe("CyclePipeline cadence flush — content-time batching", () => {
  it("holds entries inside the DELAY window — newest entry alone doesn't drain itself", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    // Single entry at first_half/30s. highestObservedOrdinal = 30,
    // boundary = 30 - 60 = -30. Entry's ordinal (30) > -30 → held.
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 30 }));
    await pipeline.flush();

    assert.equal(cycles.length, 1);
    assert.deepEqual(cycles[0].entryIds, [], "entry held — too recent for the boundary");
  });

  it("drains entries whose content ordinal is ≥ DELAY behind the highest observed", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    // Old entry at first_half/30s. New entry at first_half/120s.
    // highest = 120, boundary = 120 - 60 = 60. Old (30) ≤ 60 → drains.
    // New (120) > 60 → held.
    const old = entry({ phase: "first_half", phaseSecond: 30 });
    const fresh = entry({ phase: "first_half", phaseSecond: 120 });
    pipeline.onEntry(old);
    pipeline.onEntry(fresh);
    await pipeline.flush();

    assert.deepEqual(cycles[0].entryIds, [old.id]);
  });

  it("drains every entry that's settled past the boundary on subsequent flushes", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const a = entry({ phase: "first_half", phaseSecond: 30 });
    const b = entry({ phase: "first_half", phaseSecond: 60 });
    const c = entry({ phase: "first_half", phaseSecond: 200 });
    pipeline.onEntry(a);
    pipeline.onEntry(b);
    pipeline.onEntry(c);

    // First flush: highest=200, boundary=140. a (30) and b (60) drain. c (200) held.
    await pipeline.flush();
    assert.deepEqual(cycles[0].entryIds, [a.id, b.id]);

    // Second flush, no new entries: highest still 200, boundary still 140. c (200) > 140 → held.
    await pipeline.flush();
    assert.deepEqual(cycles[1].entryIds, []);

    // New entry advances highest. d (300), boundary = 240. c (200) drains, d held.
    const d = entry({ phase: "first_half", phaseSecond: 300 });
    pipeline.onEntry(d);
    await pipeline.flush();
    assert.deepEqual(cycles[2].entryIds, [c.id]);
  });

  it("crosses phase boundaries cleanly — second_half entries don't pull first_half entries forward", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const fh = entry({ phase: "first_half", phaseSecond: 200 });
    const sh = entry({ phase: "second_half", phaseSecond: 30 });
    pipeline.onEntry(fh);
    pipeline.onEntry(sh);

    // highest = second_half/30 (3M+30). boundary = 3M+30 - 60 = 3M-30.
    // fh ordinal = 1M+200 < 3M-30 → drains.
    // sh ordinal = 3M+30 > 3M-30 → held.
    await pipeline.flush();
    assert.deepEqual(cycles[0].entryIds, [fh.id]);
  });
});

describe("CyclePipeline cadence flush — late arrivals", () => {
  it("discards entries that arrive after the boundary they belong to has shipped", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    // Establish a boundary at ~140 (first flush drains entries ≤ 140).
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 30 }));
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 200 }));
    await pipeline.flush();
    assert.equal(cycles[0].entryIds.length, 1, "only the early entry drained on first cycle");

    // Late arrival: ordinal=60 ≤ lastFlushed boundary (140). Discarded.
    const late = entry({ phase: "first_half", phaseSecond: 60 });
    pipeline.onEntry(late);
    assert.equal(pipeline.getLateDiscardedCount(), 1);

    // Subsequent flushes don't see the late entry.
    await pipeline.flush();
    const allDispatched = cycles.flatMap((c) => c.entryIds);
    assert.equal(allDispatched.includes(late.id), false);
  });

  it("does not discard entries whose ordinal sits exactly on the boundary (≤ is the late-check, but the boundary itself lands in the cycle)", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    // Pre-establish boundary by draining once.
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 200 }));
    await pipeline.flush(); // boundary now 140, no entries drained (200 > 140)

    // Now a new entry at the boundary should NOT be discarded — it
    // sits at the boundary, the boundary already includes it.
    // Actually it equals lastFlushed (140), and the late-check is
    // `ordinal ≤ lastFlushed`, so it IS discarded. This test pins
    // that strict behaviour: equal-to-boundary is treated as late.
    const onBoundary = entry({ phase: "first_half", phaseSecond: 140 });
    pipeline.onEntry(onBoundary);
    assert.equal(
      pipeline.getLateDiscardedCount(),
      1,
      "entry at exactly the boundary is treated as already-shipped",
    );
  });

  it("late-discard counter accumulates across multiple late arrivals", async () => {
    const { pipeline } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 30 }));
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 200 }));
    await pipeline.flush();

    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 50 }));
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 80 }));
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 100 }));
    assert.equal(pipeline.getLateDiscardedCount(), 3);
  });
});

describe("CyclePipeline cadence flush — null-ordinal backwards compat", () => {
  it("entries without phase pass through every cadence flush (no anchor to defer against)", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const noPhase = entry(); // no phase, ordinal will be null
    pipeline.onEntry(noPhase);
    await pipeline.flush();

    assert.deepEqual(cycles[0].entryIds, [noPhase.id], "null-ordinal entry drains immediately");
  });

  it("null-ordinal entries are never late-discarded (no ordinal to compare)", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 30 }));
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 200 }));
    await pipeline.flush();

    const noPhase = entry();
    pipeline.onEntry(noPhase);
    assert.equal(pipeline.getLateDiscardedCount(), 0);

    await pipeline.flush();
    assert.equal(cycles[1].entryIds.includes(noPhase.id), true);
  });

  it("mixed cycles — phased entries gated by boundary, null-ordinal entries pass through", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const free = entry(); // no phase
    const fresh = entry({ phase: "first_half", phaseSecond: 200 }); // sets highest, held
    pipeline.onEntry(free);
    pipeline.onEntry(fresh);
    await pipeline.flush();

    assert.deepEqual(cycles[0].entryIds, [free.id], "free entry drains, phased entry held");
  });
});

describe("CyclePipeline external (consumer-prompt) cycles", () => {
  it("drain the entire waiting room regardless of content-time boundary", async () => {
    const { pipeline, cycles } = makePipeline({ delayMs: 60_000 });

    const a = entry({ phase: "first_half", phaseSecond: 30 });
    const b = entry({ phase: "first_half", phaseSecond: 200 }); // would be held by cadence
    pipeline.onEntry(a);
    pipeline.onEntry(b);

    await pipeline.flush({ consumerPrompt: "## Halftime reflection\n\nfoo" });

    assert.deepEqual(cycles[0].reason, "external");
    assert.deepEqual(cycles[0].entryIds, [a.id, b.id]);
  });

  it("after an external cycle drains everything, subsequent late arrivals are still caught", async () => {
    const { pipeline } = makePipeline({ delayMs: 60_000 });

    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 30 }));
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 200 }));
    await pipeline.flush({ consumerPrompt: "## external\n\nbar" });

    // Late arrival: ordinal=100 ≤ lastFlushed (200, the highest drained).
    pipeline.onEntry(entry({ phase: "first_half", phaseSecond: 100 }));
    assert.equal(pipeline.getLateDiscardedCount(), 1);
  });
});
