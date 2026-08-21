import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/narrative/generator.js";
import { buildImagerySystemPrompt } from "../src/narrative/imagery.js";
import { buildSummarySystemPrompt } from "../src/narrative/summary.js";
import {
  assembleSectionedPrompt,
  type GenerationSpecContent,
  type ImagerySpecContent,
  type SummarySpecContent,
} from "../src/narrative/spec-types.js";

/**
 * Regression guard on the assembled prompts for `sporting_event` v1.
 * Each surface composes a profile-agnostic baseline in code with the
 * service-spec's profile content via matching `## Section` headers.
 *
 * These tests pin the SHAPE of the assembly — that baseline rules
 * are present, that profile content is interleaved under matching
 * headers, that tense directives append, that the `imageryEnabled`
 * short-circuit doesn't go through the helper. The actual text of
 * the v1 spec content lives in
 * `drizzle/0004_v1_spec_content.sql` and is editorial content —
 * tested via editorial review, not byte-equality here.
 */

const FIXTURE_GENERATION_SPEC: GenerationSpecContent = {
  taskInstructions: [
    "## Prose stands on its own",
    "",
    "For the test domain: meta-commentary about cycle windows sounds like reporting *about* the broadcast.",
    "",
    "<example>",
    'Avoid: "covering minutes 23–31".',
    "</example>",
    "",
    "## Telemetry is signal, not script",
    "",
    "For the test domain: the bracketed annotations describe play measurements; render the texture, not the metric.",
  ].join("\n"),
  modeBlurbs: {
    action_led: "ACTION-LED blurb for the test domain.",
    enrichment_led: "ENRICHMENT-LED blurb for the test domain.",
    context_led: "CONTEXT-LED blurb for the test domain.",
  },
};

describe("buildSystemPrompt — assembly with profile content", () => {
  it("interleaves baseline + profile content under matching ## headers", () => {
    const prompt = buildSystemPrompt("Voice.", "Context.", {
      generationSpec: FIXTURE_GENERATION_SPEC,
    });

    // Baseline section header is present.
    assert.match(prompt, /^## Prose stands on its own$/m);
    // Baseline body is present.
    assert.match(prompt, /stand on its own as story/);
    // Profile content is present, AFTER the baseline body in the same section.
    const proseSectionMatch = prompt.match(
      /## Prose stands on its own\n\n([\s\S]+?)\n\n## /,
    );
    assert.ok(proseSectionMatch, "expected to find the prose section body");
    assert.match(
      proseSectionMatch![1],
      /stand on its own as story[\s\S]+meta-commentary about cycle windows/,
    );
  });

  it("emits baseline-only when no profile content provided", () => {
    const prompt = buildSystemPrompt("Voice.", "Context.");
    assert.match(prompt, /## Prose stands on its own/);
    // No fixture-domain elaboration present.
    assert.doesNotMatch(prompt, /test domain/);
    assert.doesNotMatch(prompt, /Tense:/);
  });

  it("appends the tense directive after task instructions when present", () => {
    const past = buildSystemPrompt("V.", "C.", {
      generationSpec: FIXTURE_GENERATION_SPEC,
      tense: "past",
    });
    assert.match(past, /## Tense\n\nWrite in the past tense throughout/);

    const present = buildSystemPrompt("V.", "C.", { tense: "present" });
    assert.match(present, /Write in the present tense throughout/);

    const dynamic = buildSystemPrompt("V.", "C.", { tense: "dynamic" });
    assert.match(dynamic, /Select tense passage-by-passage/);
  });

  it("voice + context + task ordering is stable", () => {
    const prompt = buildSystemPrompt("Hemingway voice.", "Cup final context.", {
      generationSpec: FIXTURE_GENERATION_SPEC,
    });
    const voiceIdx = prompt.indexOf("# Voice");
    const contextIdx = prompt.indexOf("# Context");
    const taskIdx = prompt.indexOf("# Task");
    assert.ok(voiceIdx >= 0 && contextIdx > voiceIdx && taskIdx > contextIdx);
  });
});

describe("assembleSectionedPrompt — assembly helper", () => {
  it("throws when profile content has a section the baseline does not", () => {
    const baseline = "## Known\n\nbaseline body.";
    const profile = "## Unknown\n\nprofile body that has no baseline counterpart.";
    assert.throws(
      () => assembleSectionedPrompt(baseline, profile),
      /no matching baseline section/i,
    );
  });

  it("emits baseline alone for sections with no profile content", () => {
    const baseline = "## One\n\nfirst.\n\n## Two\n\nsecond.";
    const profile = "## One\n\nprofile for one only.";
    const out = assembleSectionedPrompt(baseline, profile);
    assert.match(out, /## One\n\nfirst\.\n\nprofile for one only\./);
    assert.match(out, /## Two\n\nsecond\./);
    assert.doesNotMatch(out, /profile for two/);
  });

  it("returns baseline unchanged when profile is empty / undefined", () => {
    const baseline = "## A\n\naa\n\n## B\n\nbb";
    const expected = "## A\n\naa\n\n## B\n\nbb";
    assert.equal(assembleSectionedPrompt(baseline, undefined), expected);
    assert.equal(assembleSectionedPrompt(baseline, ""), expected);
    assert.equal(assembleSectionedPrompt(baseline, "   "), expected);
  });
});

const FIXTURE_IMAGERY_SPEC: ImagerySpecContent = {
  imageryInstructions: [
    "## Avoid spoilers",
    "",
    "For the test domain: don't pre-announce the moment the passage is building toward.",
  ].join("\n"),
};

describe("buildImagerySystemPrompt — assembly with profile content", () => {
  it("interleaves baseline + profile content under matching ## headers", () => {
    const prompt = buildImagerySystemPrompt(FIXTURE_IMAGERY_SPEC);
    // Baseline section header appears.
    assert.match(prompt, /^## Avoid spoilers$/m);
    // Baseline body is present.
    assert.match(prompt, /The image accompanies the passage being narrated NOW/);
    // Profile content lands AFTER the baseline body in the same section.
    const spoilerSection = prompt.match(/## Avoid spoilers\n\n([\s\S]+?)\n\n## /);
    assert.ok(spoilerSection, "expected to find the Avoid-spoilers section body");
    assert.match(
      spoilerSection![1],
      /The image accompanies the passage being narrated NOW[\s\S]+test domain/,
    );
  });

  it("emits baseline-only when no profile content provided", () => {
    const prompt = buildImagerySystemPrompt();
    assert.match(prompt, /## Avoid spoilers/);
    assert.doesNotMatch(prompt, /test domain/);
  });

  it("emits baseline-only on null spec (same as undefined)", () => {
    assert.equal(buildImagerySystemPrompt(null), buildImagerySystemPrompt());
  });

  it("throws when profile content has a section the baseline does not", () => {
    assert.throws(
      () =>
        buildImagerySystemPrompt({
          imageryInstructions: "## Bogus section\n\nbody.",
        }),
      /no matching baseline section/i,
    );
  });
});

const FIXTURE_SUMMARY_SPEC: SummarySpecContent = {
  summaryInstructions: [
    "## What the note carries",
    "",
    "For the test domain: threads and motifs surface around participants and the occasion.",
  ].join("\n"),
};

describe("buildSummarySystemPrompt — assembly with profile content", () => {
  it("interleaves baseline + profile content under matching ## headers", () => {
    const prompt = buildSummarySystemPrompt(FIXTURE_SUMMARY_SPEC);
    assert.match(prompt, /^## What the note carries$/m);
    // Baseline body is present.
    assert.match(prompt, /the arc's direction \(rising, falling, climaxing, resolving\)/);
    // Profile content lands AFTER the baseline body in the same section.
    const section = prompt.match(/## What the note carries\n\n([\s\S]+?)\n\n## /);
    assert.ok(section, "expected to find the What-the-note-carries section body");
    assert.match(
      section![1],
      /the arc's direction[\s\S]+test domain/,
    );
  });

  it("emits baseline-only when no profile content provided", () => {
    const prompt = buildSummarySystemPrompt();
    assert.match(prompt, /## What the note carries/);
    assert.doesNotMatch(prompt, /test domain/);
  });

  it("emits baseline-only on null spec (same as undefined)", () => {
    assert.equal(buildSummarySystemPrompt(null), buildSummarySystemPrompt());
  });

  it("throws when profile content has a section the baseline does not", () => {
    assert.throws(
      () =>
        buildSummarySystemPrompt({
          summaryInstructions: "## Bogus section\n\nbody.",
        }),
      /no matching baseline section/i,
    );
  });
});

describe("spec types — round-trip JSON shape", () => {
  it("ImagerySpecContent shape carries `imageryInstructions`", () => {
    const spec: ImagerySpecContent = {
      imageryInstructions: "## Avoid spoilers\n\nFor test domain: …",
    };
    assert.equal(typeof spec.imageryInstructions, "string");
  });

  it("SummarySpecContent shape carries `summaryInstructions`", () => {
    const spec: SummarySpecContent = {
      summaryInstructions: "## What the note carries\n\nFor test domain: …",
    };
    assert.equal(typeof spec.summaryInstructions, "string");
  });
});
