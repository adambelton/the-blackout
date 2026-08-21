import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normaliseTranscript,
  normalisePlayerName,
} from "../src/lib/name-normalise.js";

const roster = [
  "Kaoru Mitoma",
  "Danny Welbeck",
  "Robert Sánchez",
  "James Milner",
  "Jack Hinshelwood",
  "João Pedro",
  "Cole Palmer",
  "Enzo Fernández",
];

describe("normaliseTranscript", () => {
  it("preserves exact matches unchanged", () => {
    assert.equal(
      normaliseTranscript("Mitoma picks it up", roster),
      "Mitoma picks it up",
    );
  });

  it("fixes 1-edit typos on short (≤6 char) surnames", () => {
    assert.equal(
      normaliseTranscript("Welbek shoots and scores", roster),
      "Welbeck shoots and scores",
    );
  });

  it("fixes 2-edit typos on longer surnames", () => {
    assert.equal(
      normaliseTranscript("Hinshelwid delivers a cross", roster),
      "Hinshelwood delivers a cross",
    );
  });

  it("preserves trailing punctuation when substituting", () => {
    assert.equal(
      normaliseTranscript("it's Welbek, at thirty-five", roster),
      "it's Welbeck, at thirty-five",
    );
  });

  it("does not rewrite common English stopwords", () => {
    const input = "and then the crowd roared, but still nothing happened";
    assert.equal(normaliseTranscript(input, roster), input);
  });

  it("does not rewrite words shorter than 4 chars", () => {
    // "Li" could fuzzy-match a surname with 2 edits otherwise.
    assert.equal(
      normaliseTranscript("the ball goes to Li", roster),
      "the ball goes to Li",
    );
  });

  it("folds accents for matching; substitutes canonical form with accents", () => {
    // "Sanchez" without the acute should match "Sánchez" and be
    // rewritten to the accented form.
    assert.equal(
      normaliseTranscript("Sanchez saves it", roster),
      "Sánchez saves it",
    );
  });

  it("empty roster is a no-op", () => {
    assert.equal(
      normaliseTranscript("Mitoma picks it up", []),
      "Mitoma picks it up",
    );
  });

  it("empty text is a no-op", () => {
    assert.equal(normaliseTranscript("", roster), "");
  });

  it("preserves whitespace runs", () => {
    assert.equal(
      normaliseTranscript("  Mitoma  on the ball  ", roster),
      "  Mitoma  on the ball  ",
    );
  });

  it("does not over-correct when word is not roster-similar", () => {
    // "Paper" — 5 chars, not close to any roster surname. Leave alone.
    assert.equal(
      normaliseTranscript("He takes the Paper seriously", roster),
      "He takes the Paper seriously",
    );
  });

  it("handles multiple replacements in one line", () => {
    assert.equal(
      normaliseTranscript("Welbek finds Mitomar on the wing", roster),
      "Welbeck finds Mitoma on the wing",
    );
  });
});

describe("normalisePlayerName", () => {
  it("returns the input unchanged when already canonical", () => {
    assert.equal(
      normalisePlayerName("Danny Welbeck", roster),
      "Danny Welbeck",
    );
  });

  it("rewrites a registered-name variant to the canonical full name", () => {
    // "Daniel Welbeck" on events → "Danny Welbeck" on lineups.
    assert.equal(
      normalisePlayerName("Daniel Welbeck", roster),
      "Danny Welbeck",
    );
  });

  it("folds accents on the input surname when matching", () => {
    // Sportmonks sometimes strips the acute on exported names.
    assert.equal(
      normalisePlayerName("Roberto Sanchez", roster),
      "Robert Sánchez",
    );
  });

  it("tolerates 1-edit distance on the surname", () => {
    assert.equal(
      normalisePlayerName("D. Welbek", roster),
      "Danny Welbeck",
    );
  });

  it("returns the input when no surname match exists", () => {
    assert.equal(
      normalisePlayerName("Lionel Messi", roster),
      "Lionel Messi",
    );
  });

  it("empty roster is a no-op", () => {
    assert.equal(normalisePlayerName("Daniel Welbeck", []), "Daniel Welbeck");
  });

  it("empty input is a no-op", () => {
    assert.equal(normalisePlayerName("", roster), "");
  });
});
