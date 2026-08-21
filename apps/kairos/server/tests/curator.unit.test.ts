import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRemovals,
  buildBaselineDecisions,
  decideMode,
  determinePerAnnotationOutcome,
  reconcileBudget,
} from "../src/curation/curator.js";
import { FEEDBACK_OUTCOMES } from "../src/enrichment/types.js";
import type { EnrichmentAnnotation } from "../src/enrichment/types.js";
import type { ConflictResolution, CurationContext, CurationDecision } from "../src/curation/types.js";
import type { FeedEntry } from "../src/types.js";

function annotation(overrides: Partial<EnrichmentAnnotation> = {}): EnrichmentAnnotation {
  return {
    serviceName: "momentum",
    subjectId: "subj-overall",
    subjectLabel: "the scene",
    meaning: {
      expressed: null,
      unexpressed: { direction: "rising", intensity: "moderate" },
      acknowledged: null,
      basis: "test",
    },
    informedBy: ["entry-1"],
    ...overrides,
  };
}

describe("determinePerAnnotationOutcome", () => {
  it("returns KILLED when this (service, subject) pair lost a conflict", () => {
    const conflicts: ConflictResolution[] = [
      {
        winner: { serviceName: "tension_conflict", subjectId: "subj-stakes" },
        loser: { serviceName: "momentum", subjectId: "subj-overall" },
        reason: "stakes dominate",
      },
    ];
    const outcome = determinePerAnnotationOutcome(annotation(), {
      kept: new Set(["momentum::subj-overall"]),
      conflicts,
      emphasizedEntryIds: new Set(),
    });
    assert.equal(outcome, FEEDBACK_OUTCOMES.KILLED_WITH_REPLACEMENT);
  });

  it("returns IGNORED when the annotation was dropped by curation", () => {
    const outcome = determinePerAnnotationOutcome(annotation(), {
      kept: new Set(),
      conflicts: [],
      emphasizedEntryIds: new Set(),
    });
    assert.equal(outcome, FEEDBACK_OUTCOMES.IGNORED);
  });

  it("returns ACKNOWLEDGED when kept but not emphasised", () => {
    const outcome = determinePerAnnotationOutcome(annotation(), {
      kept: new Set(["momentum::subj-overall"]),
      conflicts: [],
      emphasizedEntryIds: new Set(["entry-999"]),
    });
    assert.equal(outcome, FEEDBACK_OUTCOMES.ACKNOWLEDGED);
  });

  it("returns DELIVERED_WITH_EMPHASIS when an informedBy entry was emphasised", () => {
    const outcome = determinePerAnnotationOutcome(
      annotation({ informedBy: ["entry-1", "entry-2"] }),
      {
        kept: new Set(["momentum::subj-overall"]),
        conflicts: [],
        emphasizedEntryIds: new Set(["entry-2"]),
      },
    );
    assert.equal(outcome, FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS);
  });

  it("conflict loss outranks emphasis", () => {
    const conflicts: ConflictResolution[] = [
      {
        winner: { serviceName: "tension_conflict", subjectId: "subj-stakes" },
        loser: { serviceName: "momentum", subjectId: "subj-overall" },
        reason: "stakes dominate",
      },
    ];
    const outcome = determinePerAnnotationOutcome(annotation(), {
      kept: new Set(["momentum::subj-overall"]),
      conflicts,
      emphasizedEntryIds: new Set(["entry-1"]),
    });
    assert.equal(outcome, FEEDBACK_OUTCOMES.KILLED_WITH_REPLACEMENT);
  });

  it("treats each subject independently — same service can have different outcomes per subject", () => {
    const a = annotation({ subjectId: "subj-liverpool" });
    const b = annotation({ subjectId: "subj-everton", informedBy: ["entry-x"] });
    const ctx = {
      kept: new Set(["momentum::subj-liverpool", "momentum::subj-everton"]),
      conflicts: [] as ConflictResolution[],
      emphasizedEntryIds: new Set(["entry-x"]),
    };
    assert.equal(determinePerAnnotationOutcome(a, ctx), FEEDBACK_OUTCOMES.ACKNOWLEDGED);
    assert.equal(determinePerAnnotationOutcome(b, ctx), FEEDBACK_OUTCOMES.DELIVERED_WITH_EMPHASIS);
  });
});

describe("decideMode — pendulum of generation modes", () => {
  // The pendulum (see product-decisions K19): every cycle generates,
  // only the *mode* shifts. These cases nail down how the mode is
  // resolved from the curation context after all services have run.

  function makeContext(overrides: Partial<CurationContext> = {}): CurationContext {
    return {
      selectedEntries: [],
      selectedAnnotations: [],
      decisions: {},
      conflicts: [],
      mode: "enrichment_led",
      triggerReason: "accumulation",
      pacing: { recommendedWordCount: 120, cadenceMs: 30_000 },
      elapsedMs: 0,
      estimatedWpm: null,
      serviceLastSurfacedAt: {},
      recentCycles: [],
      ...overrides,
    };
  }

  function priorityDecision(emphasised: string[]): CurationDecision {
    return {
      serviceName: "priority",
      action: `emphasised ${emphasised.length}`,
      entriesRemoved: [],
      entriesEmphasized: emphasised,
    };
  }

  it("returns action_led when priority has emphasised at least one entry", () => {
    const ctx = makeContext({
      selectedAnnotations: [],
      decisions: { priority: priorityDecision(["entry-1"]) },
    });
    assert.equal(decideMode(ctx), "action_led");
  });

  it("prefers action_led over enrichment_led even when annotations are present", () => {
    const ctx = makeContext({
      selectedAnnotations: [{} as EnrichmentAnnotation, {} as EnrichmentAnnotation],
      decisions: { priority: priorityDecision(["entry-1"]) },
    });
    assert.equal(decideMode(ctx), "action_led");
  });

  it("returns context_led when saturation set forceContextLed", () => {
    const ctx = makeContext({
      selectedAnnotations: [{} as EnrichmentAnnotation],
      forceContextLed: true,
      decisions: { priority: priorityDecision([]) },
    });
    assert.equal(decideMode(ctx), "context_led");
  });

  it("returns context_led when there are no annotations at all", () => {
    const ctx = makeContext({
      selectedAnnotations: [],
      decisions: { priority: priorityDecision([]) },
    });
    assert.equal(decideMode(ctx), "context_led");
  });

  it("returns enrichment_led when annotations exist but no priority emphasis and generation is allowed", () => {
    const ctx = makeContext({
      selectedAnnotations: [{} as EnrichmentAnnotation],
      decisions: { priority: priorityDecision([]) },
    });
    assert.equal(decideMode(ctx), "enrichment_led");
  });

  it("treats a missing priority decision as no emphasis (falls through to mode by annotations)", () => {
    // If priority service didn't run (isReady=false), its decision is
    // absent. Mode should fall through based on annotation presence.
    const ctx = makeContext({
      selectedAnnotations: [{} as EnrichmentAnnotation],
      decisions: {},
    });
    assert.equal(decideMode(ctx), "enrichment_led");
  });

  it("treats a missing priority decision + no annotations as context_led", () => {
    const ctx = makeContext({
      selectedAnnotations: [],
      decisions: {},
    });
    assert.equal(decideMode(ctx), "context_led");
  });

  it("returns action_led when emphasis comes from canonical_emphasis (auto-emphasis baseline)", () => {
    // The new auto-emphasis baseline declares its emphasis under
    // `canonical_emphasis` (not `priority`). decideMode must scan all
    // decisions for emphasis, not just the one named `priority`.
    const ctx = makeContext({
      selectedAnnotations: [],
      decisions: {
        canonical_emphasis: {
          serviceName: "canonical_emphasis",
          action: "auto-emphasised 1 canonical entries",
          entriesRemoved: [],
          entriesEmphasized: ["entry-card"],
        },
      },
    });
    assert.equal(decideMode(ctx), "action_led");
  });

  it("returns action_led when both canonical_emphasis AND LLM-priority emphasise", () => {
    const ctx = makeContext({
      selectedAnnotations: [{} as EnrichmentAnnotation],
      decisions: {
        canonical_emphasis: {
          serviceName: "canonical_emphasis",
          action: "auto",
          entriesRemoved: [],
          entriesEmphasized: ["entry-goal"],
        },
        priority: priorityDecision(["entry-arc-moment"]),
      },
    });
    assert.equal(decideMode(ctx), "action_led");
  });
});

describe("buildBaselineDecisions — auto-emphasis on canonical sources", () => {
  // Events are first-class facts. The source-level `canonical: true`
  // flag is the consumer's declaration "every entry from this source is
  // priority signal." The baseline emphasises every such entry before
  // any LLM-driven curation service runs, so cards / subs / gameplay
  // transitions can't be silently de-prioritised by Haiku judgment.
  // Pressure / texture entries (canonical=false) stay unemphasised
  // unless the priority service explicitly surfaces them.

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

  it("emphasises every canonical entry in the chunk", () => {
    const decisions = buildBaselineDecisions([
      entry({ id: "goal", sourceCanonical: true }),
      entry({ id: "card", sourceCanonical: true }),
      entry({ id: "kickoff", sourceCanonical: true }),
    ]);
    assert.deepEqual(decisions.canonical_emphasis?.entriesEmphasized, [
      "goal",
      "card",
      "kickoff",
    ]);
  });

  it("does NOT emphasise non-canonical entries (pressure, texture)", () => {
    const decisions = buildBaselineDecisions([
      entry({
        id: "pressure",
        sourceName: "match_pressure",
        sourceCanonical: false,
      }),
      entry({
        id: "trend",
        sourceName: "match_stats",
        sourceCanonical: false,
      }),
    ]);
    // No canonical entries → empty decisions object so the cycle's
    // mode falls through to enrichment_led / context_led naturally.
    assert.deepEqual(decisions, {});
  });

  it("emphasises only the canonical entries in a mixed chunk", () => {
    const decisions = buildBaselineDecisions([
      entry({ id: "card", sourceCanonical: true }),
      entry({
        id: "pressure",
        sourceName: "match_pressure",
        sourceCanonical: false,
      }),
      entry({ id: "sub", sourceCanonical: true }),
    ]);
    assert.deepEqual(decisions.canonical_emphasis?.entriesEmphasized, ["card", "sub"]);
  });

  it("returns empty decisions on an empty chunk (opening cycle, dead minutes)", () => {
    assert.deepEqual(buildBaselineDecisions([]), {});
  });

  it("composes with decideMode → action_led when canonical entries present", () => {
    const decisions = buildBaselineDecisions([
      entry({ id: "goal", sourceCanonical: true }),
    ]);
    const ctx: CurationContext = {
      selectedEntries: [],
      selectedAnnotations: [],
      decisions,
      conflicts: [],
      mode: "enrichment_led",
      triggerReason: "accumulation",
      pacing: { recommendedWordCount: 120, cadenceMs: 30_000 },
      maxContextTokens: 20_000,
      elapsedMs: 0,
      estimatedWpm: null,
      serviceLastSurfacedAt: {},
      recentCycles: [],
    };
    assert.equal(decideMode(ctx), "action_led");
  });
});

describe("applyRemovals — central removal authority with canonical guard", () => {
  // Services express "this entry is noise" via decisions[name].entriesRemoved.
  // The curator consolidates removals here so the canonical-never-evict
  // contract lives in one place — no service can bypass it by mutating
  // selectedEntries directly. These tests pin the contract: union the
  // removal set across every decision, silently drop canonical ids,
  // then cascade annotations whose informedBy fell out entirely.

  function plain(id: string, overrides: Partial<FeedEntry> = {}): FeedEntry {
    return {
      id,
      broadcastId: "b1",
      sourceId: "s1",
      sourceName: "match_pressure",
      sourceType: "event",
      sourceCanonical: false,
      timestamp: 1_000,
      data: {},
      enrichmentTags: [],
      ...overrides,
    };
  }

  function canonical(id: string, overrides: Partial<FeedEntry> = {}): FeedEntry {
    return plain(id, { sourceCanonical: true, sourceName: "match_events", ...overrides });
  }

  function makeContext(overrides: Partial<CurationContext> = {}): CurationContext {
    return {
      selectedEntries: [],
      selectedAnnotations: [],
      decisions: {},
      conflicts: [],
      mode: "enrichment_led",
      triggerReason: "accumulation",
      pacing: { recommendedWordCount: 120, cadenceMs: 30_000 },
      maxContextTokens: 20_000,
      elapsedMs: 0,
      estimatedWpm: null,
      cycleIntervalMs: 30_000,
      serviceLastSurfacedAt: {},
      recentCycles: [],
      ...overrides,
    };
  }

  function decision(name: string, removed: string[]): CurationDecision {
    return {
      serviceName: name,
      action: `removed ${removed.length}`,
      entriesRemoved: removed,
      entriesEmphasized: [],
    };
  }

  it("is a no-op when no decision lists any entriesRemoved", () => {
    const ctx = makeContext({ selectedEntries: [plain("a"), plain("b")] });
    const out = applyRemovals(ctx);
    assert.equal(out, ctx);
  });

  it("drops a non-canonical entry that any decision marks for removal", () => {
    const ctx = makeContext({
      selectedEntries: [plain("noise"), plain("keep")],
      decisions: { priority: decision("priority", ["noise"]) },
    });
    const out = applyRemovals(ctx);
    assert.deepEqual(out.selectedEntries.map((e) => e.id), ["keep"]);
  });

  it("never drops a canonical entry, even if a service marks it for removal", () => {
    // The principal failure F10 was about: priority service emitted a
    // canonical id in removeEntryIds and the entry vanished. With the
    // central guard, the canonical entry survives regardless.
    const ctx = makeContext({
      selectedEntries: [canonical("goal"), plain("noise")],
      decisions: { priority: decision("priority", ["goal", "noise"]) },
    });
    const out = applyRemovals(ctx);
    assert.ok(out.selectedEntries.some((e) => e.id === "goal"), "canonical survives");
    assert.ok(!out.selectedEntries.some((e) => e.id === "noise"), "non-canonical dropped");
  });

  it("unions entriesRemoved across every decision", () => {
    const ctx = makeContext({
      selectedEntries: [plain("a"), plain("b"), plain("c")],
      decisions: {
        priority: decision("priority", ["a"]),
        // Hypothetical second remover — applyRemovals is service-agnostic.
        narrative_arc: decision("narrative_arc", ["b"]),
      },
    });
    const out = applyRemovals(ctx);
    assert.deepEqual(out.selectedEntries.map((e) => e.id), ["c"]);
  });

  it("drops annotations whose informedBy ids were all removed; keeps those with at least one survivor", () => {
    const ctx = makeContext({
      selectedEntries: [plain("noise"), plain("keep")],
      selectedAnnotations: [
        annotation({ subjectId: "noise-only", informedBy: ["noise"] }),
        annotation({ subjectId: "keep-only", informedBy: ["keep"] }),
        annotation({ subjectId: "mixed", informedBy: ["noise", "keep"] }),
      ],
      decisions: { priority: decision("priority", ["noise"]) },
    });
    const out = applyRemovals(ctx);
    const subjectIds = out.selectedAnnotations.map((a) => a.subjectId);
    assert.ok(!subjectIds.includes("noise-only"), "annotation with all sources removed is dropped");
    assert.ok(subjectIds.includes("keep-only"), "untouched annotation stays");
    assert.ok(subjectIds.includes("mixed"), "annotation with at least one surviving source stays");
  });

  it("is a no-op when the only removal target was canonical (set empties after the guard)", () => {
    const ctx = makeContext({
      selectedEntries: [canonical("goal"), plain("keep")],
      decisions: { priority: decision("priority", ["goal"]) },
    });
    const out = applyRemovals(ctx);
    assert.equal(out, ctx);
  });
});

describe("reconcileBudget", () => {
  // Each entry's content is a filler string; at 4 chars/token + 20
  // overhead chars, a `"x".repeat(120)` entry costs ~35 tokens.
  function entry(overrides: Partial<FeedEntry> = {}): FeedEntry {
    return {
      id: "e1",
      broadcastId: "b1",
      sourceId: "s1",
      sourceName: "match_pressure",
      sourceType: "event",
      sourceCanonical: false,
      timestamp: 1_000,
      data: {},
      enrichmentTags: [],
      ...overrides,
    };
  }

  function makeContext(entries: FeedEntry[], maxContextTokens = 20_000): CurationContext {
    return {
      selectedEntries: entries,
      selectedAnnotations: [],
      decisions: {},
      conflicts: [],
      mode: "enrichment_led",
      triggerReason: "accumulation",
      pacing: { recommendedWordCount: 120, cadenceMs: 30_000 },
      maxContextTokens,
      elapsedMs: 0,
      estimatedWpm: null,
      serviceLastSurfacedAt: {},
      recentCycles: [],
    };
  }

  it("is a no-op when the total cost is within budget", () => {
    const ctx = makeContext([
      entry({ id: "a", data: { content: "short" } }),
      entry({ id: "b", data: { content: "also short" } }),
    ]);
    const out = reconcileBudget(ctx);
    assert.equal(out.selectedEntries.length, 2);
    assert.equal(out.decisions.budget_reconciler, undefined);
  });

  it("evicts lowest-priority entries to fit the budget", () => {
    // 10 plain entries at ~35 tokens each = ~350. Budget 100 forces
    // eviction of the oldest ~7 entries (newer-first within tier).
    const entries: FeedEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push(entry({ id: `e${i}`, timestamp: i * 1000, data: { content: "x".repeat(120) } }));
    }
    const ctx = makeContext(entries, 100);
    const out = reconcileBudget(ctx);
    assert.ok(
      out.selectedEntries.length < entries.length,
      "budget should force some eviction",
    );
    assert.ok(out.decisions.budget_reconciler, "records a decision");
    assert.ok(
      (out.decisions.budget_reconciler.entriesRemoved ?? []).length > 0,
      "records evicted ids",
    );
  });

  it("never evicts canonical entries, even over budget", () => {
    // One tiny canonical entry at timestamp 0 (oldest), plus 20 fillers
    // all newer. Budget tight enough that age-only eviction would drop
    // the canonical one; priority eviction must not.
    const entries: FeedEntry[] = [
      entry({
        id: "goal",
        sourceCanonical: true,
        timestamp: 0,
        data: { content: "GOAL — home team" },
      }),
    ];
    for (let i = 0; i < 20; i++) {
      entries.push(entry({ id: `e${i}`, timestamp: (i + 1) * 1000, data: { content: "x".repeat(120) } }));
    }
    const out = reconcileBudget(makeContext(entries, 200));
    assert.ok(
      out.selectedEntries.some((e) => e.id === "goal"),
      "canonical entry must survive budget trim",
    );
  });

  it("keeps priority-emphasised entries ahead of plain ones", () => {
    const entries: FeedEntry[] = [];
    for (let i = 0; i < 8; i++) {
      entries.push(entry({ id: `e${i}`, timestamp: i * 1000, data: { content: "x".repeat(200) } }));
    }
    const ctx = makeContext(entries, 120);
    // Priority flagged the OLDEST entry — plain tier would drop it first
    // (newer-first within tier), but the emphasis bump should keep it.
    ctx.decisions.priority = {
      serviceName: "priority",
      action: "emphasised e0",
      entriesRemoved: [],
      entriesEmphasized: ["e0"],
    };
    const out = reconcileBudget(ctx);
    assert.ok(
      out.selectedEntries.some((e) => e.id === "e0"),
      "emphasised entry should survive ahead of plain newer ones",
    );
  });

  it("drops annotations whose informedBy ids were all evicted", () => {
    const kept = entry({ id: "keep", timestamp: 10_000, data: { content: "short" } });
    const gone = entry({ id: "drop", timestamp: 1_000, data: { content: "x".repeat(200) } });
    const ctx = makeContext([kept, gone], 50);
    ctx.selectedAnnotations = [
      annotation({ subjectId: "kept-subj", informedBy: ["keep"] }),
      annotation({ subjectId: "dropped-subj", informedBy: ["drop"] }),
    ];
    const out = reconcileBudget(ctx);
    const subjectIds = out.selectedAnnotations.map((a) => a.subjectId);
    assert.ok(subjectIds.includes("kept-subj"), "annotation informed by surviving entry stays");
    assert.ok(!subjectIds.includes("dropped-subj"), "annotation informed only by evicted entries is dropped");
  });
});
