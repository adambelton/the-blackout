import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractAnchors } from "../src/narrative/anchors.js";

describe("extractAnchors", () => {
  it("returns the input unchanged when no anchors are present", () => {
    const r = extractAnchors("No anchors at all — just prose.");
    assert.equal(r.stripped, "No anchors at all — just prose.");
    assert.deepEqual(r.anchors, []);
  });

  it("extracts a single anchor and records its offset in the stripped text", () => {
    const r = extractAnchors("And then {{ref:e_123}}Welbeck slices across.");
    assert.equal(r.stripped, "And then Welbeck slices across.");
    assert.deepEqual(r.anchors, [{ entryId: "e_123", charOffset: 9 }]);
  });

  it("extracts multiple anchors in order", () => {
    const r = extractAnchors(
      "Welbeck {{ref:e_1}}slots it home. The crowd {{ref:e_2}}erupts.",
    );
    assert.equal(r.stripped, "Welbeck slots it home. The crowd erupts.");
    assert.deepEqual(r.anchors, [
      { entryId: "e_1", charOffset: 8 },
      { entryId: "e_2", charOffset: 33 },
    ]);
  });

  it("handles an anchor at the very start", () => {
    const r = extractAnchors("{{ref:e_1}}Kickoff. The ball rolls.");
    assert.equal(r.stripped, "Kickoff. The ball rolls.");
    assert.deepEqual(r.anchors, [{ entryId: "e_1", charOffset: 0 }]);
  });

  it("handles an anchor at the very end", () => {
    const r = extractAnchors("The final whistle. {{ref:e_1}}");
    assert.equal(r.stripped, "The final whistle. ");
    assert.deepEqual(r.anchors, [
      { entryId: "e_1", charOffset: "The final whistle. ".length },
    ]);
  });

  it("collapses the double space that opens up around a spaced anchor", () => {
    // "word {{ref:e_1}} word" — a space on each side. After strip the
    // naive output would be "word  word" (two spaces). We collapse
    // to one and rescale the offset to point at the joining position.
    const r = extractAnchors("word {{ref:e_1}} word");
    assert.equal(r.stripped, "word word");
    // Offset sits between the two words (on or at the single space).
    assert.equal(r.anchors.length, 1);
    assert.equal(r.anchors[0].entryId, "e_1");
    assert.ok(r.anchors[0].charOffset >= 4 && r.anchors[0].charOffset <= 5);
  });

  it("supports UUID-shaped entry ids", () => {
    const id = "2ba37f1c-6c31-4b7b-9bb3-cfe08c5a6e8d";
    const r = extractAnchors(`Start {{ref:${id}}}end.`);
    assert.equal(r.stripped, "Start end.");
    assert.deepEqual(r.anchors, [{ entryId: id, charOffset: 6 }]);
  });

  it("allows the same entryId to appear twice, keeping both anchors", () => {
    const r = extractAnchors(
      "{{ref:e_1}}First mention. And then {{ref:e_1}}again.",
    );
    assert.equal(r.stripped, "First mention. And then again.");
    assert.deepEqual(r.anchors, [
      { entryId: "e_1", charOffset: 0 },
      { entryId: "e_1", charOffset: 24 },
    ]);
  });

  it("preserves trailing punctuation position after stripping", () => {
    const r = extractAnchors("Comma {{ref:e_1}}, then a clause.");
    assert.equal(r.stripped, "Comma , then a clause.");
    // Offset lands where the stripped anchor used to be.
    assert.equal(r.anchors[0].entryId, "e_1");
    assert.equal(r.anchors[0].charOffset, "Comma ".length);
  });

  it("treats a malformed anchor (no id) as prose and does not extract", () => {
    // The regex requires non-whitespace after `ref:` — an empty id
    // doesn't match, so the text stays as-is.
    const r = extractAnchors("Broken {{ref:}} anchor still in text.");
    assert.equal(r.stripped, "Broken {{ref:}} anchor still in text.");
    assert.deepEqual(r.anchors, []);
  });
});
