import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isEvalHeader,
  parseHardInvariantLine,
  extractEvalCriteria,
  EVAL_HEADERS,
} from "../src/eval/spec-eval.js";
import { TASK_INSTRUCTIONS_BASELINE } from "../src/narrative/generator.js";
import { IMAGERY_INSTRUCTIONS_BASELINE } from "../src/narrative/imagery.js";
import { NARRATIVE_INSTRUCTIONS_BASELINE } from "../src/narrative/summary.js";
import {
  sportingEventGenerationV1,
  sportingEventImageryV1,
  sportingEventSummaryV1,
} from "../src/db/seed-data/sporting-event/index.js";

describe("isEvalHeader", () => {
  it("recognises the two eval headers (trimmed) and nothing else", () => {
    assert.equal(isEvalHeader(EVAL_HEADERS.hard), true);
    assert.equal(isEvalHeader(EVAL_HEADERS.soft), true);
    assert.equal(isEvalHeader("  Eval — hard invariants  "), true);
    assert.equal(isEvalHeader("Reading shape"), false);
    assert.equal(isEvalHeader("Eval"), false);
  });
});

describe("parseHardInvariantLine", () => {
  it("parses a regex directive into a usable RegExp", () => {
    const inv = parseHardInvariantLine("prose-must-not-match: /covering minutes/i");
    assert.equal(inv.kind, "prose-must-not-match");
    assert.ok(inv.kind !== "tool-was-called" && inv.pattern.test("…covering minutes 23–31…"));
    assert.ok(inv.kind !== "tool-was-called" && !inv.pattern.test("nothing here"));
  });

  it("ignores a trailing human gloss after the regex", () => {
    const inv = parseHardInvariantLine("prose-must-not-match: /\\b\\d{1,3}\\s?%/   (no telemetry numerals)");
    assert.ok(inv.kind === "prose-must-not-match" && inv.pattern.test("67% territory"));
  });

  it("handles escaped slashes inside the pattern", () => {
    const inv = parseHardInvariantLine("prose-must-match: /a\\/b/");
    assert.ok(inv.kind === "prose-must-match" && inv.pattern.test("a/b"));
  });

  it("parses a no-arg directive", () => {
    assert.equal(parseHardInvariantLine("tool-was-called").kind, "tool-was-called");
  });

  it("throws on an unknown directive", () => {
    assert.throws(() => parseHardInvariantLine("prose-should-be-nice: /x/"), /unknown directive/i);
  });

  it("throws when a regex directive is missing its /regex/ argument", () => {
    assert.throws(() => parseHardInvariantLine("prose-must-not-match: covering minutes"), /regex\/flags/i);
  });
});

describe("extractEvalCriteria", () => {
  const baseline = [
    "## Concept",
    "irrelevant prompt prose.",
    "",
    "## Eval — hard invariants",
    "- tool-was-called",
    "",
    "## Eval — soft notes",
    "- baseline reviewer note.",
  ].join("\n");

  const profile = [
    "## Concept",
    "more prompt prose.",
    "",
    "## Eval — hard invariants",
    "- prose-must-not-match: /covering minutes/i",
    "- prose-must-not-match: /the commentators? (say|tell)/i",
    "",
    "## Eval — soft notes",
    "- profile reviewer note.",
  ].join("\n");

  it("merges baseline-then-profile hard invariants and soft notes", () => {
    const criteria = extractEvalCriteria(baseline, profile);
    assert.deepEqual(criteria.hardInvariants.map((i) => i.kind), [
      "tool-was-called",
      "prose-must-not-match",
      "prose-must-not-match",
    ]);
    assert.deepEqual(criteria.softNotes, ["baseline reviewer note.", "profile reviewer note."]);
  });

  it("returns empty criteria when neither blob carries eval sections", () => {
    const criteria = extractEvalCriteria("## Concept\n\njust prose.", "## Concept\n\nmore prose.");
    assert.deepEqual(criteria, { hardInvariants: [], softNotes: [] });
  });

  it("tolerates a missing profile blob", () => {
    const criteria = extractEvalCriteria(baseline);
    assert.deepEqual(criteria.hardInvariants.map((i) => i.kind), ["tool-was-called"]);
    assert.deepEqual(criteria.softNotes, ["baseline reviewer note."]);
  });

  it("throws (loudly) on a malformed hard-invariant line in either blob", () => {
    const bad = "## Eval — hard invariants\n- bogus-directive: /x/";
    assert.throws(() => extractEvalCriteria(bad), /unknown directive/i);
  });
});

describe("shipped narrative eval sections parse against their baselines", () => {
  // Guards the authored `## Eval` content (baseline + spec) — a malformed
  // directive or regex in any of the six .md files throws here, not at a
  // live eval run.
  it("generation: baseline `tool-was-called` + the spec's prose contract", () => {
    const c = extractEvalCriteria(TASK_INSTRUCTIONS_BASELINE, sportingEventGenerationV1.taskInstructions);
    assert.ok(c.hardInvariants.some((i) => i.kind === "tool-was-called"), "expected tool-was-called from baseline");
    assert.ok(
      c.hardInvariants.filter((i) => i.kind === "prose-must-not-match").length >= 6,
      "expected the spec's prose-must-not-match contract",
    );
  });

  it("imagery: the spec's image-prompt contract parses", () => {
    const c = extractEvalCriteria(IMAGERY_INSTRUCTIONS_BASELINE, sportingEventImageryV1.imageryInstructions);
    assert.ok(c.hardInvariants.length >= 3);
    assert.ok(c.hardInvariants.every((i) => i.kind === "prose-must-not-match"));
  });

  it("summary: the spec's note contract parses", () => {
    const c = extractEvalCriteria(NARRATIVE_INSTRUCTIONS_BASELINE, sportingEventSummaryV1.summaryInstructions);
    assert.ok(c.hardInvariants.length >= 5);
    assert.ok(c.hardInvariants.every((i) => i.kind === "prose-must-not-match"));
  });
});
