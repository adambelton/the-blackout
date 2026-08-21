import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeTierResults } from "../src/curation/curator.js";
import type { CurationContext } from "../src/curation/types.js";

/**
 * `mergeTierResults` adversarial coverage.
 *
 * The curator runs services in tiers; each tier produces a partial
 * `CurationContext` (the next state). `mergeTierResults` folds the
 * tier outputs back into the prior context. Subtle regression
 * classes the audit flagged ("mergeTierResults adversarial cases"):
 *
 *   - Conflicts append by DELTA only — re-folding a tier that
 *     produced N conflicts must not produce 2N entries.
 *   - `forceContextLed` is sticky-once-true (any tier wins).
 *   - Reference-equality short-circuits — a tier that returns the
 *     same array instance for `selectedEntries` shouldn't replace
 *     the merged value.
 *   - Empty results → prior pass-through.
 *   - Decisions shallow-merge across tiers; later tier overrides
 *     earlier on conflicting service keys.
 *
 * Pinning these now means later optimisations (parallel tiers,
 * single-pass merge) keep the same observable contract.
 */

function emptyContext(): CurationContext {
  return {
    selectedEntries: [],
    selectedAnnotations: [],
    decisions: {},
    conflicts: [],
    mode: "enrichment_led",
    triggerReason: "accumulation",
    pacing: { recommendedWordCount: 100, cadenceMs: 30_000 },
    maxContextTokens: 8_000,
    elapsedMs: 0,
  };
}

describe("mergeTierResults — empty / pass-through", () => {
  it("returns the prior unchanged when results is empty", () => {
    const prior = emptyContext();
    prior.summary = "untouched";
    const merged = mergeTierResults(prior, []);
    assert.equal(merged.summary, "untouched");
    assert.deepEqual(merged.decisions, {});
  });
});

describe("mergeTierResults — decisions are shallow-merged across tiers", () => {
  it("two tiers writing different service keys both land in merged decisions", () => {
    const prior = emptyContext();
    const tier1 = {
      ...emptyContext(),
      decisions: {
        priority: { serviceName: "priority", action: "1", entriesEmphasized: [], entriesRemoved: [] },
      },
    };
    const tier2 = {
      ...emptyContext(),
      decisions: {
        pacing: { serviceName: "pacing", action: "2", entriesEmphasized: [], entriesRemoved: [] },
      },
    };
    const merged = mergeTierResults(prior, [{ next: tier1 }, { next: tier2 }]);
    assert.ok("priority" in merged.decisions);
    assert.ok("pacing" in merged.decisions);
  });

  it("a later tier writing the same service key OVERRIDES the earlier", () => {
    const prior = emptyContext();
    const earlier = {
      ...emptyContext(),
      decisions: {
        priority: { serviceName: "priority", action: "first", entriesEmphasized: [], entriesRemoved: [] },
      },
    };
    const later = {
      ...emptyContext(),
      decisions: {
        priority: { serviceName: "priority", action: "second", entriesEmphasized: [], entriesRemoved: [] },
      },
    };
    const merged = mergeTierResults(prior, [{ next: earlier }, { next: later }]);
    assert.equal(merged.decisions.priority.action, "second");
  });
});

describe("mergeTierResults — conflicts append by DELTA only", () => {
  it("a tier that adds 1 new conflict on top of the prior's 2 produces 3 total — not 5", () => {
    const prior: CurationContext = {
      ...emptyContext(),
      conflicts: [
        {
          winner: { serviceName: "a", subjectId: "x" },
          loser: { serviceName: "b", subjectId: "x" },
          reason: "first",
        },
        {
          winner: { serviceName: "c", subjectId: "y" },
          loser: { serviceName: "d", subjectId: "y" },
          reason: "second",
        },
      ],
    };
    // tier returns prior's 2 + 1 NEW conflict (3 total in next.conflicts).
    // Merge must produce prior + delta = 3, not prior + next = 5.
    const next: CurationContext = {
      ...emptyContext(),
      conflicts: [
        ...prior.conflicts,
        {
          winner: { serviceName: "e", subjectId: "z" },
          loser: { serviceName: "f", subjectId: "z" },
          reason: "third",
        },
      ],
    };
    const merged = mergeTierResults(prior, [{ next }]);
    assert.equal(merged.conflicts.length, 3, "delta append, not full concat");
    assert.equal(merged.conflicts[2].reason, "third");
  });

  it("a tier that adds zero conflicts leaves the prior's conflicts list intact", () => {
    const prior: CurationContext = {
      ...emptyContext(),
      conflicts: [
        {
          winner: { serviceName: "a", subjectId: "x" },
          loser: { serviceName: "b", subjectId: "x" },
          reason: "first",
        },
      ],
    };
    const next = { ...emptyContext(), conflicts: prior.conflicts };
    const merged = mergeTierResults(prior, [{ next }]);
    assert.equal(merged.conflicts.length, 1);
    assert.equal(merged.conflicts[0].reason, "first");
  });
});

describe("mergeTierResults — forceContextLed is sticky-once-true", () => {
  it("any tier setting forceContextLed=true wins over later tiers leaving it unset", () => {
    const prior = emptyContext();
    const setsTrue = { ...emptyContext(), forceContextLed: true };
    const leavesUnset = emptyContext();
    const merged = mergeTierResults(prior, [{ next: setsTrue }, { next: leavesUnset }]);
    assert.equal(merged.forceContextLed, true);
  });

  it("forceContextLed=false on a later tier does NOT clear an earlier tier's true", () => {
    const prior = emptyContext();
    const setsTrue = { ...emptyContext(), forceContextLed: true };
    const setsFalse = { ...emptyContext(), forceContextLed: false };
    const merged = mergeTierResults(prior, [{ next: setsTrue }, { next: setsFalse }]);
    assert.equal(merged.forceContextLed, true);
  });
});

describe("mergeTierResults — reference-equality short-circuits", () => {
  it("a tier that returns the SAME selectedEntries array instance doesn't replace the merged value", () => {
    const sharedEntries = [{ id: "e1" }];
    const prior: CurationContext = { ...emptyContext(), selectedEntries: sharedEntries as never };
    // Tier returns the same instance — the merge's reference equality
    // check (`next.selectedEntries !== prior.selectedEntries`) skips
    // the assignment. Pre-fix, this would have been a redundant
    // assignment; post-fix it's a no-op the test pins.
    const next: CurationContext = { ...emptyContext(), selectedEntries: sharedEntries as never };
    const merged = mergeTierResults(prior, [{ next }]);
    assert.equal(merged.selectedEntries, prior.selectedEntries);
  });

  it("a tier that returns a DIFFERENT instance updates the merged value even if contents match", () => {
    const a = [{ id: "e1" }];
    const b = [{ id: "e1" }];
    const prior: CurationContext = { ...emptyContext(), selectedEntries: a as never };
    const next: CurationContext = { ...emptyContext(), selectedEntries: b as never };
    const merged = mergeTierResults(prior, [{ next }]);
    assert.equal(merged.selectedEntries, b);
  });
});

describe("mergeTierResults — summary / arcPhase / pacing field-level updates", () => {
  it("summary update flows from the latest tier that changed it", () => {
    const prior = emptyContext();
    prior.summary = "prior text";
    const tier1 = { ...emptyContext(), summary: "first cycle's summary" };
    const tier2 = { ...emptyContext(), summary: "second cycle's summary" };
    const merged = mergeTierResults(prior, [{ next: tier1 }, { next: tier2 }]);
    assert.equal(merged.summary, "second cycle's summary");
  });

  it("arcPhase change in any tier propagates to the merged value", () => {
    const prior = emptyContext();
    prior.arcPhase = "rising";
    const tier1 = { ...emptyContext(), arcPhase: "climax" };
    const merged = mergeTierResults(prior, [{ next: tier1 }]);
    assert.equal(merged.arcPhase, "climax");
  });

  it("pacing change in any tier propagates", () => {
    const prior = emptyContext();
    const next = {
      ...emptyContext(),
      pacing: { recommendedWordCount: 75, cadenceMs: 45_000 },
    };
    const merged = mergeTierResults(prior, [{ next }]);
    assert.equal(merged.pacing.recommendedWordCount, 75);
    assert.equal(merged.pacing.cadenceMs, 45_000);
  });
});
