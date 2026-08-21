import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleRunningSummary,
  extractNarrativeBlock,
  formatStateBlock,
} from "../src/narrative/summary.js";
import type { FeedEntry } from "../src/types.js";

const event = (
  overrides: Partial<FeedEntry> & { content?: string; subjectTime?: string },
): FeedEntry => {
  const { content, subjectTime, ...rest } = overrides;
  const data: Record<string, unknown> = {};
  if (content !== undefined) data.content = content;
  if (subjectTime !== undefined) data.subjectTime = subjectTime;
  return {
    id: "e1",
    broadcastId: "b1",
    sourceId: "s1",
    sourceName: "match_events",
    sourceType: "event",
    sourceCanonical: true,
    timestamp: 1_000,
    data,
    enrichmentTags: [],
    ...rest,
  };
};

describe("formatStateBlock", () => {
  it("returns empty when there are no canonical events (opening cycle)", () => {
    assert.equal(formatStateBlock([]), "");
  });

  it("renders one event with subjectTime + content under the canonical state header", () => {
    const out = formatStateBlock([
      event({ id: "g1", subjectTime: "6", content: "Haaland scores" }),
    ]);
    assert.equal(out, "Canonical state:\n- [6'] Haaland scores");
  });

  it("sorts by timestamp ascending so chronology is preserved across cycles", () => {
    const out = formatStateBlock([
      event({ id: "later", timestamp: 2_000, subjectTime: "12", content: "Cody booked" }),
      event({ id: "earlier", timestamp: 1_000, subjectTime: "6", content: "Haaland scores" }),
    ]);
    assert.equal(
      out,
      "Canonical state:\n- [6'] Haaland scores\n- [12'] Cody booked",
    );
  });

  it("omits the time prefix when an entry has no subjectTime", () => {
    const out = formatStateBlock([event({ content: "Kickoff" })]);
    assert.equal(out, "Canonical state:\n- Kickoff");
  });

  it("falls back to JSON-stringifying data when content is absent", () => {
    const e = event({});
    e.data = { eventType: "GOAL", player: "Haaland" };
    const out = formatStateBlock([e]);
    assert.match(out, /eventType.*GOAL/);
  });
});

describe("assembleRunningSummary", () => {
  it("glues state and narrative blocks with the narrative header", () => {
    const out = assembleRunningSummary(
      "Canonical state:\n- [6'] Haaland scores",
      "City lead through Haaland. The Etihad is quiet.",
    );
    assert.equal(
      out,
      "Canonical state:\n- [6'] Haaland scores\n\nNarrative arc:\nCity lead through Haaland. The Etihad is quiet.",
    );
  });

  it("omits state when empty (opening cycle, no canonical events yet)", () => {
    const out = assembleRunningSummary("", "Opening tone established.");
    assert.equal(out, "Narrative arc:\nOpening tone established.");
  });

  it("omits narrative when empty (Haiku call failed)", () => {
    const out = assembleRunningSummary("Canonical state:\n- [6'] Haaland scores", "");
    assert.equal(out, "Canonical state:\n- [6'] Haaland scores");
  });

  it("returns empty string when both blocks are empty (cold start)", () => {
    assert.equal(assembleRunningSummary("", ""), "");
  });

  it("trims surrounding whitespace on both blocks before gluing", () => {
    const out = assembleRunningSummary(
      "  Canonical state:\n- [6'] Goal  ",
      "  Arc carry  ",
    );
    assert.equal(out, "Canonical state:\n- [6'] Goal\n\nNarrative arc:\nArc carry");
  });
});

describe("extractNarrativeBlock", () => {
  it("returns the narrative text from an assembled summary", () => {
    const summary = assembleRunningSummary(
      "Canonical state:\n- [6'] Haaland scores",
      "Arc text here.",
    );
    assert.equal(extractNarrativeBlock(summary), "Arc text here.");
  });

  it("returns empty when the summary has no narrative section", () => {
    const summary = "Canonical state:\n- [6'] Haaland scores";
    assert.equal(extractNarrativeBlock(summary), "");
  });

  it("returns empty on an empty summary (cold start)", () => {
    assert.equal(extractNarrativeBlock(""), "");
  });

  it("does NOT include the canonical state when extracting", () => {
    // The whole point — Haiku must see only its own previous output,
    // never the templated state, so it doesn't try to preserve fact.
    const summary = assembleRunningSummary(
      "Canonical state:\n- [6'] Haaland scores\n- [12'] Cody booked",
      "Rising arc; the away pressure is the motif.",
    );
    const extracted = extractNarrativeBlock(summary);
    assert.doesNotMatch(extracted, /Canonical state/);
    assert.doesNotMatch(extracted, /Haaland/);
    assert.doesNotMatch(extracted, /Cody/);
    assert.equal(extracted, "Rising arc; the away pressure is the motif.");
  });

  it("survives a roundtrip — extract from a freshly-assembled summary equals the input narrative", () => {
    // Property: assembleRunningSummary then extractNarrativeBlock is
    // an identity on the narrative input (after trim). Pin it so a
    // future delimiter change keeps the contract intact.
    const narrative = "Multi-line\nnarrative text\nwith breaks.";
    const summary = assembleRunningSummary(
      formatStateBlock([event({ subjectTime: "6", content: "Goal" })]),
      narrative,
    );
    assert.equal(extractNarrativeBlock(summary), narrative);
  });
});
