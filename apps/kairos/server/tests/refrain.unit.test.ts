import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatRefrainStatus } from "../src/narrative/refrain.js";

describe("formatRefrainStatus", () => {
  it("returns empty when no refrains are configured", () => {
    assert.equal(formatRefrainStatus(undefined, [], null), "");
    assert.equal(formatRefrainStatus([], [], null), "");
  });

  it("returns empty when refrains exist but none have been used yet", () => {
    const out = formatRefrainStatus(
      [{ phrase: "Eleven years", maxPerPhase: 3 }],
      [{ output: "Nothing relevant here.", phase: "first_half" }],
      "first_half",
    );
    assert.equal(out, "");
  });

  it("reports per-phase usage when under budget", () => {
    const out = formatRefrainStatus(
      [{ phrase: "Eleven years", maxPerPhase: 3 }],
      [
        { output: "Eleven years since it last felt this way.", phase: "first_half" },
        { output: "Something else entirely.", phase: "first_half" },
      ],
      "first_half",
    );
    assert.match(out, /Refrain usage so far/);
    assert.match(out, /"Eleven years", used 1\/3 this first_half/);
  });

  it("emits an explicit halt when the per-phase cap is hit", () => {
    const priors = Array.from({ length: 4 }, (_, i) => ({
      output: `Cycle ${i} — eleven years is the refrain today.`,
      phase: "first_half",
    }));
    const out = formatRefrainStatus(
      [{ phrase: "eleven years", maxPerPhase: 3 }],
      priors,
      "first_half",
    );
    assert.match(out, /do not use again this phase/);
  });

  it("case-insensitive match across passages", () => {
    const out = formatRefrainStatus(
      [{ phrase: "still nil", maxPerPhase: 2 }],
      [
        { output: "Still Nil. The score hasn't moved.", phase: "first_half" },
        { output: "And still nil at the break.", phase: "first_half" },
      ],
      "first_half",
    );
    assert.match(out, /used 2\/2 this first_half/);
    assert.match(out, /do not use again this phase/);
  });

  it("reports total usage when maxTotal is set", () => {
    const out = formatRefrainStatus(
      [{ phrase: "Portman Road", maxTotal: 5 }],
      [
        { output: "Portman Road hums.", phase: "first_half" },
        { output: "Portman Road roars. Portman Road waits.", phase: "second_half" },
      ],
      "second_half",
    );
    assert.match(out, /3\/5 total/);
  });

  it("scopes per-phase count by phase tag, not global count", () => {
    const out = formatRefrainStatus(
      [{ phrase: "ghost goal", maxPerPhase: 2 }],
      [
        { output: "A ghost goal in the first.", phase: "first_half" },
        { output: "Another ghost goal in the first.", phase: "first_half" },
        { output: "One more ghost goal now.", phase: "second_half" },
      ],
      "second_half",
    );
    // 1 use in current phase (second_half), NOT 3 total.
    assert.match(out, /used 1\/2 this second_half/);
  });
});
