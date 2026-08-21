import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  subjectOrdinal,
  subjectOrdinalForEntry,
  readClosingExtension,
  readClosingPrompt,
  PHASE_ORDINAL_STRIDE,
} from "../src/pipeline/subject-time.js";
import type { FeedEntry } from "../src/types.js";

/**
 * Pure ordinal helpers. The pipeline's content-time batching keys
 * every dispatch decision on the ordinal these helpers compute.
 */

describe("subjectOrdinal", () => {
  it("orders phases monotonically: pre_match < first_half < halftime < second_half < full_time", () => {
    const ordinals = [
      subjectOrdinal("pre_match", 0),
      subjectOrdinal("first_half", 0),
      subjectOrdinal("halftime", 0),
      subjectOrdinal("second_half", 0),
      subjectOrdinal("full_time", 0),
    ];
    for (let i = 1; i < ordinals.length; i++) {
      assert.ok(ordinals[i]! > ordinals[i - 1]!, `${ordinals[i]} > ${ordinals[i - 1]}`);
    }
  });

  it("uses stride 1_000_000 between phases", () => {
    const a = subjectOrdinal("first_half", 0);
    const b = subjectOrdinal("halftime", 0);
    assert.equal(b! - a!, PHASE_ORDINAL_STRIDE);
  });

  it("adds phaseSecond within a phase", () => {
    const a = subjectOrdinal("first_half", 30);
    const b = subjectOrdinal("first_half", 90);
    assert.equal(b! - a!, 60);
  });

  it("first-half stoppage stays before second-half start (stride is comfortable)", () => {
    // 1H stoppage can reach 7+ minutes (420s). 2H starts at phaseSecond 0.
    // Stride of 1M makes the inequality safe by orders of magnitude.
    const stoppage = subjectOrdinal("first_half", 7 * 60);
    const secondHalf = subjectOrdinal("second_half", 0);
    assert.ok(secondHalf! > stoppage!);
  });

  it("treats 'live_first_half' and 'first_half' identically (consumer's BroadcastPhase vs Kairos's data.phase)", () => {
    assert.equal(
      subjectOrdinal("live_first_half", 30),
      subjectOrdinal("first_half", 30),
    );
    assert.equal(
      subjectOrdinal("live_second_half", 30),
      subjectOrdinal("second_half", 30),
    );
  });

  it("treats 'full_time_winddown', 'full_time', 'complete' identically", () => {
    const a = subjectOrdinal("full_time", 0);
    const b = subjectOrdinal("full_time_winddown", 0);
    const c = subjectOrdinal("complete", 0);
    assert.equal(a, b);
    assert.equal(b, c);
  });

  it("returns null for unknown phase", () => {
    assert.equal(subjectOrdinal("postponed", 0), null);
    assert.equal(subjectOrdinal("", 0), null);
  });

  it("returns null for non-string phase", () => {
    assert.equal(subjectOrdinal(undefined, 0), null);
    assert.equal(subjectOrdinal(null, 0), null);
    assert.equal(subjectOrdinal(42, 0), null);
  });

  it("treats missing or non-numeric phaseSecond as 0 within a known phase", () => {
    assert.equal(subjectOrdinal("first_half", undefined), subjectOrdinal("first_half", 0));
    assert.equal(subjectOrdinal("first_half", null), subjectOrdinal("first_half", 0));
    assert.equal(subjectOrdinal("first_half", "30"), subjectOrdinal("first_half", 0));
    assert.equal(subjectOrdinal("first_half", NaN), subjectOrdinal("first_half", 0));
  });
});

describe("subjectOrdinalForEntry", () => {
  function entry(data: Record<string, unknown> | null | undefined): FeedEntry {
    return {
      id: "e1",
      broadcastId: "b1",
      sourceId: "s1",
      sourceName: "match_events",
      sourceType: "event",
      sourceCanonical: false,
      timestamp: Date.now(),
      data: data as Record<string, unknown>,
      enrichmentTags: [],
    };
  }

  it("extracts the ordinal from a stamped entry's data payload", () => {
    const e = entry({ phase: "first_half", phaseSecond: 720, eventType: "GOAL" });
    assert.equal(subjectOrdinalForEntry(e), subjectOrdinal("first_half", 720));
  });

  it("returns null when data is missing", () => {
    const e = entry(undefined);
    assert.equal(subjectOrdinalForEntry(e), null);
  });

  it("returns null when data lacks phase", () => {
    const e = entry({ content: "atmosphere", phaseSecond: 30 });
    assert.equal(subjectOrdinalForEntry(e), null);
  });

  it("returns null when phase is unrecognised", () => {
    const e = entry({ phase: "warmup", phaseSecond: 30 });
    assert.equal(subjectOrdinalForEntry(e), null);
  });
});

describe("readClosingExtension", () => {
  function entry(data: Record<string, unknown> | undefined): FeedEntry {
    return {
      id: "e1",
      broadcastId: "b1",
      sourceId: "s1",
      sourceName: "match_events",
      sourceType: "event",
      sourceCanonical: false,
      timestamp: Date.now(),
      data: data as Record<string, unknown>,
      enrichmentTags: [],
    };
  }

  it("returns the consumer's extension value when present", () => {
    assert.equal(readClosingExtension(entry({ closingExtensionSeconds: 15 })), 15);
    assert.equal(readClosingExtension(entry({ closingExtensionSeconds: 30 })), 30);
  });

  it("returns 0 when the consumer explicitly stamps zero (boundary at the entry itself)", () => {
    assert.equal(readClosingExtension(entry({ closingExtensionSeconds: 0 })), 0);
  });

  it("returns null when the marker is absent — the common case", () => {
    assert.equal(readClosingExtension(entry({ eventType: "GOAL" })), null);
    assert.equal(readClosingExtension(entry({})), null);
  });

  it("returns null when data is missing entirely", () => {
    assert.equal(readClosingExtension(entry(undefined)), null);
  });

  it("returns null for malformed values (non-number, NaN, infinite, negative)", () => {
    assert.equal(readClosingExtension(entry({ closingExtensionSeconds: "15" })), null);
    assert.equal(readClosingExtension(entry({ closingExtensionSeconds: NaN })), null);
    assert.equal(readClosingExtension(entry({ closingExtensionSeconds: Infinity })), null);
    assert.equal(readClosingExtension(entry({ closingExtensionSeconds: -1 })), null);
  });

  it("doesn't enumerate event types — neutrality is the point", () => {
    // Unlike the previous recognizePhaseTransition, this reader doesn't
    // know about HALFTIME / FULL_TIME / KICKOFF. Any entry that carries
    // the marker triggers the closing-cycle mechanism, regardless of
    // whether it's a football phase or a courtroom recess or whatever.
    assert.equal(
      readClosingExtension(entry({ eventType: "RECESS_START", closingExtensionSeconds: 30 })),
      30,
    );
  });
});

describe("readClosingPrompt", () => {
  function entry(data: Record<string, unknown> | undefined): FeedEntry {
    return {
      id: "e1",
      broadcastId: "b1",
      sourceId: "s1",
      sourceName: "match_events",
      sourceType: "event",
      sourceCanonical: false,
      timestamp: Date.now(),
      data: data as Record<string, unknown>,
      enrichmentTags: [],
    };
  }

  it("returns the consumer's framing text when present", () => {
    assert.equal(
      readClosingPrompt(entry({ closingPrompt: "Narrate to the whistle." })),
      "Narrate to the whistle.",
    );
  });

  it("trims surrounding whitespace", () => {
    assert.equal(
      readClosingPrompt(entry({ closingPrompt: "\n  prompt  \n" })),
      "prompt",
    );
  });

  it("returns null when the field is absent — the common case", () => {
    assert.equal(readClosingPrompt(entry({ closingExtensionSeconds: 15 })), null);
    assert.equal(readClosingPrompt(entry({})), null);
  });

  it("returns null when data is missing entirely", () => {
    assert.equal(readClosingPrompt(entry(undefined)), null);
  });

  it("returns null for malformed values (non-string, empty after trim)", () => {
    assert.equal(readClosingPrompt(entry({ closingPrompt: 42 })), null);
    assert.equal(readClosingPrompt(entry({ closingPrompt: "" })), null);
    assert.equal(readClosingPrompt(entry({ closingPrompt: "   " })), null);
  });
});
