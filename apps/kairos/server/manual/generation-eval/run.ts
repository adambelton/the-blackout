/**
 * Generation eval runner — out-of-band LLM golden set.
 *
 * Walks every fixture in `fixtures.ts`, resolves the baseline +
 * v1 sporting_event spec, calls the live generator (Sonnet) for
 * each fixture, asserts hard invariants on the prose + covers,
 * and prints soft mismatches for human judgement. Exits 1 if any
 * hard invariant is violated.
 *
 * Run before shipping any change to `generator.baseline.md`, the
 * v1 spec content in `src/db/seed-data/sporting-event/generation.md`,
 * `generator.ts`, or `assembleSectionedPrompt`. NOT part of
 * `pnpm test`.
 *
 * Usage: `pnpm tsx manual/generation-eval/run.ts`
 *
 * Requires ANTHROPIC_API_KEY in env (loaded from .env if present).
 */
import "../../src/env.js";
import { AnthropicLLMClient } from "../../src/llm/index.js";
import {
  generate,
  type GenerationResult,
  TASK_INSTRUCTIONS_BASELINE,
} from "../../src/narrative/generator.js";
import { sportingEventGenerationV1 } from "../../src/db/seed-data/sporting-event/index.js";
import { extractEvalCriteria, checkProseInvariants } from "../../src/eval/spec-eval.js";
import { FIXTURES, type Fixture } from "./sporting-event/fixtures.js";

const PROFILE_NAME = "sporting_event";

// The general prose contract now lives in the spec content (baseline
// machine invariants + the sporting_event spec's profile invariants),
// parsed from the assembled `## Eval` sections. Per-fixture expectations
// (covers, word caps, mode-specific bans) stay on each fixture below.
const SPEC_EVAL = extractEvalCriteria(
  TASK_INSTRUCTIONS_BASELINE,
  sportingEventGenerationV1.taskInstructions,
);

interface FixtureResult {
  fixture: Fixture;
  output: GenerationResult | null;
  error?: string;
  hardFailures: string[];
}

function wordCount(prose: string): number {
  return prose.trim().split(/\s+/).filter(Boolean).length;
}

function checkHardInvariants(fixture: Fixture, output: GenerationResult): string[] {
  // Spec-level invariants (the general prose contract) run against every
  // fixture; per-fixture invariants follow.
  const failures: string[] = checkProseInvariants(SPEC_EVAL.hardInvariants, output.text);

  if (fixture.hard.proseMustNotMatch) {
    for (const pattern of fixture.hard.proseMustNotMatch) {
      if (pattern.test(output.text)) {
        failures.push(`prose matched forbidden pattern ${pattern}`);
      }
    }
  }
  if (fixture.hard.proseMustMatch) {
    for (const pattern of fixture.hard.proseMustMatch) {
      if (!pattern.test(output.text)) {
        failures.push(`prose did not match required pattern ${pattern}`);
      }
    }
  }

  const coverIds = new Set(output.covers.map((c) => c.entryId));
  if (fixture.hard.coversMustInclude) {
    for (const id of fixture.hard.coversMustInclude) {
      if (!coverIds.has(id)) {
        failures.push(`expected covers to include ${id} — got [${[...coverIds].join(", ") || "none"}]`);
      }
    }
  }
  if (fixture.hard.coversMustBeAnchored) {
    for (const id of fixture.hard.coversMustBeAnchored) {
      const cover = output.covers.find((c) => c.entryId === id);
      if (!cover) {
        failures.push(`expected covers to include ${id} for anchoring — entry not in covers`);
      } else if (cover.charOffset == null) {
        failures.push(`cover ${id} missing inline {{ref:…}} anchor (charOffset absent)`);
      }
    }
  }

  if (fixture.hard.maxWords != null) {
    const words = wordCount(output.text);
    if (words > fixture.hard.maxWords) {
      failures.push(`prose word count ${words} exceeds maxWords ${fixture.hard.maxWords}`);
    }
  }

  return failures;
}

function printSummary(output: GenerationResult): void {
  console.log(`  prose (${wordCount(output.text)} words):`);
  for (const line of output.text.split("\n")) console.log(`    ${line}`);
  console.log(`  covers (${output.covers.length}):`);
  for (const c of output.covers) {
    const anchor = c.charOffset != null ? ` @${c.charOffset}` : " (unanchored)";
    const time = c.subjectTime ? ` · ${c.subjectTime}` : "";
    console.log(`    - ${c.entryId}${time}${anchor}`);
  }
}

async function runFixture(client: AnthropicLLMClient, fixture: Fixture): Promise<FixtureResult> {
  try {
    const output = await generate(
      client,
      {
        entries: fixture.entries,
        currentSubjectMinute: fixture.entries[0]?.phaseSecond
          ? Math.floor(fixture.entries[0].phaseSecond / 60)
          : null,
        currentSubjectPhase: fixture.entries[0]?.phase,
        currentSubjectPhaseSecond: fixture.entries[0]?.phaseSecond,
      },
      {
        voice: fixture.voice,
        context: fixture.context,
        mode: fixture.mode,
        canonicalEvents: fixture.canonicalEvents,
        summary: fixture.summary,
        previousPassage: fixture.previousPassage,
        targetWords: fixture.targetWords,
        cycleDurationSeconds: fixture.cycleDurationSeconds,
        generationSpec: sportingEventGenerationV1,
      },
    );
    const hardFailures = checkHardInvariants(fixture, output);
    return { fixture, output, hardFailures };
  } catch (err) {
    return {
      fixture,
      output: null,
      error: (err as Error).message,
      hardFailures: [`generate() threw: ${(err as Error).message}`],
    };
  }
}

async function main(): Promise<void> {
  console.log(`generation eval [${PROFILE_NAME}] — running ${FIXTURES.length} fixture(s)\n`);
  const client = new AnthropicLLMClient();
  let totalHardFailures = 0;

  for (const fixture of FIXTURES) {
    console.log(`▶ ${fixture.name}`);
    console.log(`  mode: ${fixture.mode}`);
    console.log(`  ${fixture.describes}`);
    const result = await runFixture(client, fixture);

    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else if (result.output) {
      printSummary(result.output);
    }

    if (result.hardFailures.length > 0) {
      console.log(`  ✗ HARD FAILURES:`);
      for (const f of result.hardFailures) console.log(`    - ${f}`);
      totalHardFailures += result.hardFailures.length;
    } else {
      console.log(`  ✓ hard invariants pass`);
    }

    if (result.fixture.soft?.notes) {
      console.log(`  note: ${result.fixture.soft.notes}`);
    }
    console.log("");
  }

  if (totalHardFailures > 0) {
    console.log(`\nFAIL: ${totalHardFailures} hard invariant(s) violated across ${FIXTURES.length} fixture(s).`);
    process.exit(1);
  } else {
    console.log(`\nOK: ${FIXTURES.length} fixture(s) — all hard invariants pass. Review soft cases above for borderline mismatches.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
