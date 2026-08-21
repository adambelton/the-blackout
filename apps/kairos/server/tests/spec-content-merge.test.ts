import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  loadBaselineSections,
  mergeBaselineWithSpec,
  readEnrichmentSpec,
  type EnrichmentBaselineSections,
} from "../src/enrichment/baseline-loader.js";
import {
  loadBaselineSections as loadCurationBaseline,
  mergeBaselineWithSpec as mergeCurationBaseline,
  type CurationBaselineSections,
} from "../src/curation/baseline-loader.js";
import type { EnrichmentSpecContent } from "../src/enrichment/spec-types.js";
import type { CurationSpecContent } from "../src/curation/spec-types.js";
import { assembleSectionedPrompt } from "../src/narrative/spec-types.js";
import {
  sportingEventMomentumV1,
  sportingEventTensionConflictV1,
  sportingEventThemesV1,
  sportingEventCharacterArcsV1,
  sportingEventCharacterRelationshipsV1,
  sportingEventPatternsEchoesV1,
} from "../src/db/seed-data/sporting-event/enrichment/index.js";
import {
  sportingEventNarrativeArcV1,
  sportingEventPriorityV1,
  sportingEventNarrativeGapV1,
  sportingEventBroadcastSummaryV1,
  sportingEventSaturationResolverV1,
  sportingEventContextCuratorV1,
  sportingEventConflictResolverV1,
} from "../src/db/seed-data/sporting-event/curation/index.js";

/**
 * Merge-contract guard for the prompts-as-content lift — the
 * `<service>.baseline.md` (profile-agnostic, in code) composed with the
 * resolved `service_specs` row (per-domain elaboration, in the DB)
 * section-by-section under matching `## Header` markers.
 *
 * The K6.3 plumbing (`enrichment/` + `curation/baseline-loader.ts`)
 * shipped without this guard; the commit deferred merge-contract tests
 * to "land service-by-service". K6.5+ finished the per-service content
 * lifts, so this now pins both the generic merge mechanics AND a smoke
 * across every shipped `sporting_event` spec: a typo'd header in any
 * `.md` would otherwise throw at activation in prod, not here, and
 * content placed under a section the baseline lacks would vanish
 * silently — both caught below.
 *
 * The *text* of the spec content is editorial — pinned by editorial
 * review, not byte-equality. These tests pin the SHAPE.
 */

// ── enrichment merge mechanics (fixtures) ──────────────────────────────

const ENRICHMENT_FIXTURE_BASELINE: EnrichmentBaselineSections = {
  concept: "Baseline concept body.",
  subjectGuidance: "Baseline subject body.",
  readingGuidance: "Baseline reading body.",
  briefExtractionGuidance: "Baseline extraction body.",
  briefInitializationGuidance: "Baseline init body.",
};

describe("enrichment mergeBaselineWithSpec — section interleave", () => {
  it("appends profile content after the baseline body in the matching section", () => {
    const merged = mergeBaselineWithSpec(ENRICHMENT_FIXTURE_BASELINE, {
      serviceInstructions: "## Reading shape\n\nProfile reading elaboration.",
    });
    assert.equal(
      merged.readingGuidance,
      "Baseline reading body.\n\nProfile reading elaboration.",
    );
  });

  it("leaves sections the spec does not touch as baseline-only", () => {
    const merged = mergeBaselineWithSpec(ENRICHMENT_FIXTURE_BASELINE, {
      serviceInstructions: "## Reading shape\n\nProfile reading elaboration.",
    });
    assert.equal(merged.concept, "Baseline concept body.");
    assert.equal(merged.subjectGuidance, "Baseline subject body.");
    assert.equal(merged.briefExtractionGuidance, "Baseline extraction body.");
  });

  it("returns the baseline unchanged when spec is null", () => {
    assert.deepEqual(mergeBaselineWithSpec(ENRICHMENT_FIXTURE_BASELINE, null), ENRICHMENT_FIXTURE_BASELINE);
  });

  it("throws when the spec carries a section the baseline has no counterpart for", () => {
    assert.throws(
      () =>
        mergeBaselineWithSpec(ENRICHMENT_FIXTURE_BASELINE, {
          serviceInstructions: "## Bogus section\n\nbody with no baseline home.",
        }),
      /no matching baseline section/i,
    );
  });
});

describe("readEnrichmentSpec — spec-row content extraction", () => {
  it("lifts serviceInstructions from a populated row", () => {
    assert.deepEqual(readEnrichmentSpec({ serviceInstructions: "## Reading shape\n\nbody." }), {
      serviceInstructions: "## Reading shape\n\nbody.",
    });
  });

  it("returns null for the placeholder row (so the assembler renders baseline alone)", () => {
    assert.equal(readEnrichmentSpec({ placeholder: true }), null);
    assert.equal(readEnrichmentSpec({ serviceInstructions: "   " }), null);
    assert.equal(readEnrichmentSpec(null), null);
  });
});

// ── curation merge mechanics (fixtures) ────────────────────────────────

const CURATION_FIXTURE_BASELINE: CurationBaselineSections = {
  concept: "Baseline concept body.",
  taskGuidance: "Baseline task body.",
  briefExtractionGuidance: "Baseline extraction body.",
};

describe("curation mergeBaselineWithSpec — section interleave", () => {
  it("appends profile content after the baseline body in the matching section", () => {
    const merged = mergeCurationBaseline(CURATION_FIXTURE_BASELINE, {
      serviceInstructions: "## Task\n\nProfile task elaboration.",
    });
    assert.equal(merged.taskGuidance, "Baseline task body.\n\nProfile task elaboration.");
    assert.equal(merged.concept, "Baseline concept body.");
  });

  it("returns the baseline unchanged when spec is null", () => {
    assert.deepEqual(mergeCurationBaseline(CURATION_FIXTURE_BASELINE, null), CURATION_FIXTURE_BASELINE);
  });

  it("throws when the spec carries a section outside the curation header set", () => {
    assert.throws(
      () =>
        mergeCurationBaseline(CURATION_FIXTURE_BASELINE, {
          serviceInstructions: "## Reading shape\n\nenrichment-only section, not a curation one.",
        }),
      /no matching baseline section/i,
    );
  });
});

// ── one deep per-service check: append-not-replace on real content ─────

describe("themes v1 sporting_event content — appended, not substituted", () => {
  const baseline = loadBaselineSections(
    new URL("../src/enrichment/services/themes.baseline.md", import.meta.url),
  );

  it("keeps the baseline reading body and appends the sporting-event weight calibration after it", () => {
    const merged = mergeBaselineWithSpec(baseline, readEnrichmentSpec(sportingEventThemesV1));
    assert.match(merged.readingGuidance, /how much of the story this theme is carrying/);
    assert.match(merged.readingGuidance, /weight tracks how close a theme sits to the contest/);
    assert.match(merged.briefExtractionGuidance, /the latest chapter of a rivalry/);
  });
});

// ── broad smoke: every shipped sporting_event spec assembles ───────────

const ENRICHMENT_SPECS: Array<{ name: string; baseline: string; spec: EnrichmentSpecContent; sample: string }> = [
  { name: "momentum", baseline: "momentum", spec: sportingEventMomentumV1, sample: "a side carrying form into the match" },
  { name: "tension_conflict", baseline: "tension-conflict", spec: sportingEventTensionConflictV1, sample: "clashes between teams" },
  { name: "themes", baseline: "themes", spec: sportingEventThemesV1, sample: "weight tracks how close a theme sits to the contest" },
  { name: "character_arcs", baseline: "character-arcs", spec: sportingEventCharacterArcsV1, sample: "the talisman a side leans on" },
  { name: "character_relationships", baseline: "character-relationships", spec: sportingEventCharacterRelationshipsV1, sample: "the defender marking him" },
  { name: "patterns_echoes", baseline: "patterns-echoes", spec: sportingEventPatternsEchoesV1, sample: "a set-piece routine that threatens each time" },
];

const CURATION_SPECS: Array<{ name: string; baseline: string; spec: CurationSpecContent; sample: string }> = [
  { name: "narrative_arc", baseline: "narrative-arc", spec: sportingEventNarrativeArcV1, sample: "a goal that turns the game" },
  { name: "priority", baseline: "priority", spec: sportingEventPriorityV1, sample: "a tactical shift that explains a goal" },
  { name: "narrative_gap", baseline: "narrative-gap", spec: sportingEventNarrativeGapV1, sample: "the callback clock is reset by decisive events" },
  { name: "broadcast_summary", baseline: "broadcast-summary", spec: sportingEventBroadcastSummaryV1, sample: "the state of the contest" },
  { name: "saturation_resolver", baseline: "saturation-resolver", spec: sportingEventSaturationResolverV1, sample: "the same side still pressing" },
  { name: "context_curator", baseline: "context-curator", spec: sportingEventContextCuratorV1, sample: "a brief thread activates when the live game touches it" },
  { name: "conflict_resolver", baseline: "conflict-resolver", spec: sportingEventConflictResolverV1, sample: "the strongest evidence available" },
];

describe("shipped sporting_event enrichment specs assemble against their baselines", () => {
  for (const { name, baseline, spec, sample } of ENRICHMENT_SPECS) {
    it(`${name}: no header drift + profile content lands in the merged sections`, () => {
      const loaded = loadBaselineSections(
        new URL(`../src/enrichment/services/${baseline}.baseline.md`, import.meta.url),
      );
      // mergeBaselineWithSpec throws on header drift; reaching the
      // assertion means every spec header matched a baseline section.
      const merged = mergeBaselineWithSpec(loaded, spec);
      assert.ok(
        JSON.stringify(merged).includes(sample),
        `expected ${name} profile content ("${sample}") in the merged sections — it was dropped (section absent from the baseline?)`,
      );
    });
  }
});

describe("shipped sporting_event curation specs assemble against their baselines", () => {
  for (const { name, baseline, spec, sample } of CURATION_SPECS) {
    it(`${name}: no header drift + profile content lands in the merged sections`, () => {
      const loaded = loadCurationBaseline(
        new URL(`../src/curation/services/${baseline}.baseline.md`, import.meta.url),
      );
      const merged = mergeCurationBaseline(loaded, spec);
      assert.ok(
        JSON.stringify(merged).includes(sample),
        `expected ${name} profile content ("${sample}") in the merged sections — it was dropped (section absent from the baseline?)`,
      );
    });
  }
});

// ── eval sections are tolerated in the spec + excluded from the prompt ──

describe("eval sections do not leak into the assembled prompt", () => {
  const EVAL_SPEC = "## Eval — hard invariants\n- prose-must-not-match: /covering minutes/i";

  it("enrichment: a spec eval section neither throws nor appears in the merged prompt", () => {
    const merged = mergeBaselineWithSpec(ENRICHMENT_FIXTURE_BASELINE, {
      serviceInstructions: `## Reading shape\n\nProfile reading.\n\n${EVAL_SPEC}`,
    });
    assert.equal(merged.readingGuidance, "Baseline reading body.\n\nProfile reading.");
    assert.doesNotMatch(JSON.stringify(merged), /Eval — hard|prose-must-not-match|covering minutes/);
  });

  it("curation: a spec eval section neither throws nor appears in the merged prompt", () => {
    const merged = mergeCurationBaseline(CURATION_FIXTURE_BASELINE, {
      serviceInstructions: `## Task\n\nProfile task.\n\n${EVAL_SPEC}`,
    });
    assert.equal(merged.taskGuidance, "Baseline task body.\n\nProfile task.");
    assert.doesNotMatch(JSON.stringify(merged), /Eval — hard|prose-must-not-match|covering minutes/);
  });

  it("narrative: eval sections in baseline AND profile are excluded from the prompt, no throw", () => {
    const baseline = "## Concept\n\nBase concept.\n\n## Eval — hard invariants\n- tool-was-called";
    const profile = `## Concept\n\nProfile concept.\n\n${EVAL_SPEC}`;
    const prompt = assembleSectionedPrompt(baseline, profile);
    assert.match(prompt, /## Concept\n\nBase concept\.\n\nProfile concept\./);
    assert.doesNotMatch(prompt, /Eval — hard|tool-was-called|prose-must-not-match/);
  });
});
