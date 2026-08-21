import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampMonotonicMinute, computeBatchEntries } from "../src/narrative/helpers.js";
import { filterPhantomCovers } from "../src/narrative/engine.js";
import type { FeedEntry } from "../src/types.js";

describe("clampMonotonicMinute", () => {
  it("passes null next through unchanged (consumer falls back to its own minute source)", () => {
    assert.equal(clampMonotonicMinute(null, 42), null);
    assert.equal(clampMonotonicMinute(null, null), null);
  });

  it("passes next through when floor is null (first cycle)", () => {
    assert.equal(clampMonotonicMinute(10, null), 10);
  });

  it("passes next through when it is at or above the floor", () => {
    assert.equal(clampMonotonicMinute(45, 40), 45);
    assert.equal(clampMonotonicMinute(40, 40), 40);
  });

  it("clamps upward when a late-arriving earlier-phase entry pulls the minute back", () => {
    assert.equal(clampMonotonicMinute(12, 45), 45);
  });
});

describe("computeBatchEntries — cycle batch carries the UI reveal contract", () => {
  // The batch is what the consumer's matchroom uses to decide what to
  // reveal at audio-end. Two filters: ambient sources never reveal
  // (they're presentation, not events); pre-cutoff entries belong to
  // a previous cycle's batch.

  function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
    return {
      id: "e1",
      broadcastId: "b1",
      sourceId: "s1",
      sourceName: "match_events",
      sourceType: "event",
      sourceCanonical: true,
      timestamp: 1_000,
      data: {},
      enrichmentTags: [],
      ...overrides,
    };
  }

  it("includes everything when sinceTimestamp is null (first cycle of broadcast)", () => {
    const out = computeBatchEntries(
      [entry({ id: "a" }), entry({ id: "b", timestamp: 2_000 })],
      null,
    );
    assert.deepEqual(out.map((e) => e.id), ["a", "b"]);
  });

  it("excludes entries at-or-before the cutoff (strict greater-than)", () => {
    // The cutoff equals the previous generation's triggeredAt — entries
    // stamped exactly at that moment belong to the prior cycle.
    const out = computeBatchEntries(
      [
        entry({ id: "before", timestamp: 100 }),
        entry({ id: "exactly", timestamp: 200 }),
        entry({ id: "after", timestamp: 300 }),
      ],
      200,
    );
    assert.deepEqual(out.map((e) => e.id), ["after"]);
  });

  it("excludes ambient sources regardless of timestamp", () => {
    // narrative_voice + narrative_context are activation seed material;
    // they never reveal as cycle observations.
    const out = computeBatchEntries(
      [
        entry({ id: "voice", sourceType: "narrative_voice", timestamp: 5_000 }),
        entry({ id: "context", sourceType: "narrative_context", timestamp: 5_000 }),
        entry({ id: "event", sourceType: "event", timestamp: 5_000 }),
      ],
      0,
    );
    assert.deepEqual(out.map((e) => e.id), ["event"]);
  });

  it("preserves order from the input array", () => {
    const out = computeBatchEntries(
      [
        entry({ id: "third", timestamp: 3_000 }),
        entry({ id: "first", timestamp: 1_000 }),
        entry({ id: "second", timestamp: 2_000 }),
      ],
      0,
    );
    assert.deepEqual(out.map((e) => e.id), ["third", "first", "second"]);
  });
});

describe("filterPhantomCovers — covers must reference entries in scope", () => {
  // The generator occasionally emits cover ids that weren't in its
  // context (model error, schema slip). Filtering is the contract that
  // protects the persisted record + the consumer's reveal mapping.

  it("accepts every cover whose entryId is in the allowed set", () => {
    const { accepted, phantomCount } = filterPhantomCovers(
      [{ entryId: "a" }, { entryId: "b" }],
      ["a", "b", "c"],
    );
    assert.equal(accepted.length, 2);
    assert.equal(phantomCount, 0);
  });

  it("strips covers whose entryId is not in the allowed set; counts them", () => {
    const { accepted, phantomCount } = filterPhantomCovers(
      [{ entryId: "real" }, { entryId: "phantom-1" }, { entryId: "phantom-2" }],
      ["real"],
    );
    assert.deepEqual(accepted.map((c) => c.entryId), ["real"]);
    assert.equal(phantomCount, 2);
  });

  it("preserves subjectTime + charOffset when present on accepted covers", () => {
    const { accepted } = filterPhantomCovers(
      [{ entryId: "a", subjectTime: "23'", charOffset: 47 }],
      ["a"],
    );
    assert.equal(accepted[0].subjectTime, "23'");
    assert.equal(accepted[0].charOffset, 47);
  });

  it("omits optional fields when the source cover doesn't carry them", () => {
    const { accepted } = filterPhantomCovers([{ entryId: "a" }], ["a"]);
    assert.equal(accepted[0].entryId, "a");
    assert.equal(accepted[0].subjectTime, undefined);
    assert.equal(accepted[0].charOffset, undefined);
  });

  it("handles an empty cover list (skipped cycle, no covers reported)", () => {
    const { accepted, phantomCount } = filterPhantomCovers([], ["a", "b"]);
    assert.equal(accepted.length, 0);
    assert.equal(phantomCount, 0);
  });

  it("handles an empty allowed set — every cover is phantom", () => {
    const { accepted, phantomCount } = filterPhantomCovers(
      [{ entryId: "a" }, { entryId: "b" }],
      [],
    );
    assert.equal(accepted.length, 0);
    assert.equal(phantomCount, 2);
  });
});
