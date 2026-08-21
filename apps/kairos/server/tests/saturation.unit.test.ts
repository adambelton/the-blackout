import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SaturationResolver } from "../src/curation/services/saturation-resolver.js";
import { ContextCurator } from "../src/curation/services/context-curator.js";
import { StubLLMClient } from "../src/llm/stub.js";
import type {
  EnrichmentAnnotation,
  ServiceSpec,
} from "../src/enrichment/types.js";
import type { CurationContext } from "../src/curation/types.js";
import type { RecentCycleSnapshot } from "../src/curation/recent-cycles.js";

const SPEC: ServiceSpec = {
  serviceName: "saturation_resolver",
  serviceType: "curation",
  eventProfileName: "sporting_event",
  version: "0.1.0",
  status: "experimental",
  spec: {},
};

function annotation(overrides: Partial<EnrichmentAnnotation> = {}): EnrichmentAnnotation {
  return {
    serviceName: "momentum",
    subjectId: "subj-west-ham",
    subjectLabel: "West Ham United",
    meaning: {
      expressed: { direction: "falling", intensity: "moderate" },
      unexpressed: { direction: "falling", intensity: "moderate" },
      acknowledged: null,
      basis: "territorial collapse continues",
    },
    informedBy: ["entry-1"],
    ...overrides,
  };
}

function cycleSnapshot(
  cycleId: string,
  annotations: EnrichmentAnnotation[],
  prose: string | null = null,
): RecentCycleSnapshot {
  return { cycleId, triggeredAt: Date.now(), annotations, prose };
}

function context(overrides: Partial<CurationContext> = {}): CurationContext {
  return {
    selectedEntries: [],
    selectedAnnotations: [],
    decisions: {},
    conflicts: [],
    triggerReason: "accumulation",
    pacing: { recommendedWordCount: 120, cadenceMs: 30_000 },
    elapsedMs: 0,
    estimatedWpm: null,
    serviceLastSurfacedAt: {},
    recentCycles: [],
    ...overrides,
  };
}

function payload(narrativeContext: CurationContext["recentCycles"] extends infer _ ? [] : never = []) {
  return {
    broadcastId: "b1",
    entries: [],
    annotations: [],
    fromTimestamp: 0,
    toTimestamp: 0,
    narrativeContext: narrativeContext as [],
  };
}

describe("SaturationResolver", () => {
  it("shortcircuits when there are no annotations", async () => {
    const llm = new StubLLMClient([]);
    const resolver = new SaturationResolver(SPEC, llm);
    const ctx = context({
      selectedAnnotations: [],
      recentCycles: [cycleSnapshot("c0", [annotation()])],
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(llm.calls.length, 0);
    assert.equal(result.decisions.saturation_resolver?.action, "no candidates or no history");
    assert.equal(result.conflicts.length, 0);
  });

  it("shortcircuits when there is no recent history", async () => {
    const llm = new StubLLMClient([]);
    const resolver = new SaturationResolver(SPEC, llm);
    const ctx = context({
      selectedAnnotations: [annotation()],
      recentCycles: [],
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(llm.calls.length, 0);
    assert.equal(result.decisions.saturation_resolver?.action, "no candidates or no history");
    assert.equal(result.conflicts.length, 0);
  });

  it("emits a synthetic conflict with the locked reading when the LLM flags a subject as saturated", async () => {
    const lockedReading = { direction: "falling", intensity: "moderate" };
    const ann = annotation({
      meaning: {
        expressed: lockedReading,
        unexpressed: { direction: "falling", intensity: "high" },
        acknowledged: null,
        basis: "fourth restatement of the same collapse",
      },
    });

    const llm = new StubLLMClient([
      {
        text: "",
        toolCalls: [
          {
            name: "report_saturation",
            input: {
              saturated: [
                {
                  serviceName: "momentum",
                  subjectId: "subj-west-ham",
                  reason: "territorial collapse has been narrated four times in a row",
                },
              ],
              forceContextLed: false,
              rationale: "one subject saturated, others still fresh",
            },
          },
        ],
      },
    ]);
    const resolver = new SaturationResolver(SPEC, llm);

    const ctx = context({
      selectedAnnotations: [ann],
      recentCycles: [
        cycleSnapshot("c-3", [annotation({ subjectLabel: "West Ham (t-3)" })], "West Ham pinned, 15%"),
        cycleSnapshot("c-2", [annotation({ subjectLabel: "West Ham (t-2)" })], "West Ham pinned, 12%"),
        cycleSnapshot("c-1", [annotation({ subjectLabel: "West Ham (t-1)" })], "West Ham pinned, 100%"),
      ],
    });

    const result = await resolver.curate(payload(), ctx);
    assert.equal(llm.calls.length, 1);
    assert.equal(result.conflicts.length, 1);

    const conflict = result.conflicts[0];
    assert.equal(conflict.loser.serviceName, "momentum");
    assert.equal(conflict.loser.subjectId, "subj-west-ham");
    assert.ok(conflict.reason.includes("[saturation]"));
    // Replacement prefers expressed so the curator's KILLED_WITH_REPLACEMENT
    // path locks the service's state to the already-narrated baseline.
    assert.deepEqual(conflict.replacementReading, lockedReading);
    // forceContextLed stays falsy — only one subject was saturated, the
    // cycle still has fresh material to lead with.
    assert.ok(!result.forceContextLed);
  });

  it("sets forceContextLed=true when the LLM says every annotation is saturated", async () => {
    const llm = new StubLLMClient([
      {
        text: "",
        toolCalls: [
          {
            name: "report_saturation",
            input: {
              saturated: [
                { serviceName: "momentum", subjectId: "subj-west-ham", reason: "restatement" },
              ],
              forceContextLed: true,
              rationale: "every annotation restates the last passage",
            },
          },
        ],
      },
    ]);
    const resolver = new SaturationResolver(SPEC, llm);

    const ctx = context({
      selectedAnnotations: [annotation()],
      recentCycles: [cycleSnapshot("c-1", [annotation()], "same passage")],
    });

    const result = await resolver.curate(payload(), ctx);
    assert.equal(result.forceContextLed, true);
    assert.ok(
      result.decisions.saturation_resolver?.action.includes("pivoting to context_led"),
      "action should name the pivot decision",
    );
  });

  it("preserves a prior service's forceContextLed when this cycle isn't saturated", async () => {
    // A hypothetical prior service has already set forceContextLed=true;
    // saturation reporting nothing fresh shouldn't unset it. The merge
    // rule is "true wins" — pivot decisions only widen, never narrow.
    const llm = new StubLLMClient([
      {
        text: "",
        toolCalls: [
          {
            name: "report_saturation",
            input: {
              saturated: [],
              forceContextLed: false,
              rationale: "nothing saturated",
            },
          },
        ],
      },
    ]);
    const resolver = new SaturationResolver(SPEC, llm);
    const ctx = context({
      selectedAnnotations: [annotation()],
      recentCycles: [cycleSnapshot("c-1", [annotation()])],
      forceContextLed: true,
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(result.forceContextLed, true);
  });

  it("tolerates a null or malformed LLM response", async () => {
    const llm = new StubLLMClient([
      {
        text: "",
        toolCalls: [{ name: "report_saturation", input: {} }],
      },
    ]);
    const resolver = new SaturationResolver(SPEC, llm);
    const ctx = context({
      selectedAnnotations: [annotation()],
      recentCycles: [cycleSnapshot("c-1", [annotation()])],
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(result.conflicts.length, 0);
    assert.equal(result.decisions.saturation_resolver?.action, "no saturation report");
  });
});

describe("ContextCurator (suppression block — formerly ContextResonanceResolver)", () => {
  function patternsEchoesAnn(
    subjectId: string,
    echoes: string[],
    label = "brief-echoed pattern",
  ): EnrichmentAnnotation {
    return {
      serviceName: "patterns_echoes",
      subjectId,
      subjectLabel: label,
      meaning: {
        expressed: null,
        unexpressed: {
          description: "pattern",
          occurrences: 2,
          weight: "moderate",
          echoesContextEntryIds: echoes,
        },
        acknowledged: null,
        basis: "live evidence echoes the brief",
      },
      informedBy: ["entry-1"],
    };
  }

  it("shortcircuits when there are no patterns_echoes candidates", async () => {
    const resolver = new ContextCurator(SPEC, new StubLLMClient([]));
    const ctx = context({
      selectedAnnotations: [annotation()], // momentum, not patterns_echoes
      recentCycles: [cycleSnapshot("c-1", [patternsEchoesAnn("p-1", ["id:ctx-1"])])],
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(result.decisions.context_curator?.action, "no patterns_echoes candidates or no history");
    assert.equal(result.conflicts.length, 0);
  });

  it("shortcircuits when there is no recent history", async () => {
    const resolver = new ContextCurator(SPEC, new StubLLMClient([]));
    const ctx = context({
      selectedAnnotations: [patternsEchoesAnn("p-1", ["id:ctx-1"])],
      recentCycles: [],
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(result.decisions.context_curator?.action, "no patterns_echoes candidates or no history");
  });

  it("emits no conflicts when the current cycle's echoes do not overlap recent echoes", async () => {
    const resolver = new ContextCurator(SPEC, new StubLLMClient([]));
    const ctx = context({
      selectedAnnotations: [patternsEchoesAnn("p-1", ["id:ctx-fresh"])],
      recentCycles: [
        cycleSnapshot("c-1", [patternsEchoesAnn("p-2", ["id:ctx-other"])]),
      ],
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(result.decisions.context_curator?.action, "no stale echoes");
    assert.equal(result.conflicts.length, 0);
  });

  it("suppresses a stale echo by filtering the fragment id from the replacement reading", async () => {
    const staleId = "id:ctx-mavropanos";
    const freshId = "id:ctx-other";

    const resolver = new ContextCurator(SPEC, new StubLLMClient([]));
    const ctx = context({
      selectedAnnotations: [patternsEchoesAnn("p-setpiece", [staleId, freshId])],
      recentCycles: [
        // The stale id was echoed 3 cycles ago.
        cycleSnapshot("c-3", [patternsEchoesAnn("p-setpiece-old", [staleId])]),
        cycleSnapshot("c-2", []),
        cycleSnapshot("c-1", []),
      ],
    });
    const result = await resolver.curate(payload(), ctx);
    assert.equal(result.conflicts.length, 1);

    const conflict = result.conflicts[0];
    assert.equal(conflict.loser.serviceName, "patterns_echoes");
    assert.equal(conflict.loser.subjectId, "p-setpiece");
    assert.ok(conflict.reason.includes("[context-curator/echo]"));

    // Replacement keeps the pattern alive but drops the recently-used
    // fragment id. The fresh id survives.
    const replacement = conflict.replacementReading as { echoesContextEntryIds: string[] };
    assert.deepEqual(replacement.echoesContextEntryIds, [freshId]);
  });

  it("records every stale fragment in the suppression meta", async () => {
    const stale1 = "id:ctx-a";
    const stale2 = "id:ctx-b";

    const resolver = new ContextCurator(SPEC, new StubLLMClient([]));
    const ctx = context({
      selectedAnnotations: [patternsEchoesAnn("p-1", [stale1, stale2])],
      recentCycles: [
        cycleSnapshot("c-1", [patternsEchoesAnn("old", [stale1, stale2])]),
      ],
    });
    const result = await resolver.curate(payload(), ctx);
    const meta = result.decisions.context_curator?.meta as {
      suppressed: Array<{ subjectId: string; fragments: string[] }>;
    };
    assert.deepEqual(meta.suppressed, [{ subjectId: "p-1", fragments: [stale1, stale2] }]);
  });

  it("ignores non-patterns_echoes annotations in the recent window", async () => {
    const resolver = new ContextCurator(SPEC, new StubLLMClient([]));
    // A character_arcs annotation with an echoesContextEntryIds-shaped
    // field should NOT count as a recent echo — only patterns_echoes
    // carries fragment id claims.
    const arcsLike: EnrichmentAnnotation = {
      serviceName: "character_arcs",
      subjectId: "char-1",
      subjectLabel: "Some character",
      meaning: {
        expressed: null,
        unexpressed: { echoesContextEntryIds: ["id:ctx-leak"] },
        acknowledged: null,
        basis: "spurious",
      },
      informedBy: [],
    };
    const ctx = context({
      selectedAnnotations: [patternsEchoesAnn("p-1", ["id:ctx-leak"])],
      recentCycles: [cycleSnapshot("c-1", [arcsLike])],
    });
    const result = await resolver.curate(payload(), ctx);
    // Non-patterns_echoes annotations in history contribute nothing to
    // the recently-echoed set, so the resolver shortcircuits with the
    // empty-window signal rather than reaching the stale-check step.
    assert.equal(result.decisions.context_curator?.action, "no recent echoes in window");
    assert.equal(result.conflicts.length, 0);
  });
});
