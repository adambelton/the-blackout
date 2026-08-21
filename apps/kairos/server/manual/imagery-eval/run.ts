/**
 * Imagery eval runner — out-of-band LLM golden set.
 *
 * Walks every fixture in `fixtures.ts`, resolves the baseline +
 * v1 sporting_event imagery spec, calls `selectImagery` against
 * a real Anthropic Haiku client, asserts hard invariants on the
 * decision + prompt, prints soft mismatches for human judgement.
 * Exits 1 if any hard invariant is violated.
 *
 * Run before shipping any change to `imagery.baseline.md`, the
 * v1 spec content in `src/db/seed-data/sporting-event/imagery.md`,
 * `imagery.ts`, or `assembleSectionedPrompt`. NOT part of
 * `pnpm test`.
 *
 * Usage: `pnpm tsx manual/imagery-eval/run.ts`
 *
 * Requires ANTHROPIC_API_KEY in env (loaded from .env if present).
 */
import "../../src/env.js";
import { AnthropicLLMClient } from "../../src/llm/index.js";
import {
  selectImagery,
  type ImagerySelection,
  IMAGERY_INSTRUCTIONS_BASELINE,
} from "../../src/narrative/imagery.js";
import { sportingEventImageryV1 } from "../../src/db/seed-data/sporting-event/index.js";
import { extractEvalCriteria, checkProseInvariants } from "../../src/eval/spec-eval.js";
import { FIXTURES, type Fixture } from "./sporting-event/fixtures.js";

const PROFILE_NAME = "sporting_event";

// The general image-prompt contract (no in-frame text, no spoilers, no
// broadcast apparatus) lives in the imagery spec's `## Eval` section;
// per-fixture expectations (allowed decisions, word cap, pool allow-list)
// stay on each fixture.
const SPEC_EVAL = extractEvalCriteria(
  IMAGERY_INSTRUCTIONS_BASELINE,
  sportingEventImageryV1.imageryInstructions,
);

interface FixtureResult {
  fixture: Fixture;
  output: ImagerySelection | null;
  error?: string;
  hardFailures: string[];
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function checkHardInvariants(fixture: Fixture, output: ImagerySelection): string[] {
  const failures: string[] = [];

  if (!fixture.hard.decisionMustBeOneOf.includes(output.decision)) {
    failures.push(
      `decision ${output.decision} not in allowed [${fixture.hard.decisionMustBeOneOf.join(", ")}]`,
    );
  }

  if (output.decision === "generate" && output.prompt) {
    // Spec-level invariants (the general image-prompt contract) run against
    // the fresh-generate prompt.
    failures.push(...checkProseInvariants(SPEC_EVAL.hardInvariants, output.prompt));
    if (fixture.hard.promptMustNotMatch) {
      for (const pattern of fixture.hard.promptMustNotMatch) {
        if (pattern.test(output.prompt)) {
          failures.push(`generate-prompt matched forbidden pattern ${pattern}: "${output.prompt}"`);
        }
      }
    }
    if (fixture.hard.promptMaxWords != null) {
      const words = wordCount(output.prompt);
      if (words > fixture.hard.promptMaxWords) {
        failures.push(`generate-prompt word count ${words} exceeds ${fixture.hard.promptMaxWords}`);
      }
    }
  }

  if (output.decision === "pool" && fixture.hard.poolItemIdMustBeOneOf) {
    if (!output.poolItemId || !fixture.hard.poolItemIdMustBeOneOf.includes(output.poolItemId)) {
      failures.push(
        `pool decision chose ${output.poolItemId ?? "(missing id)"} — not in allowed [${fixture.hard.poolItemIdMustBeOneOf.join(", ")}]`,
      );
    }
  }

  return failures;
}

function printSummary(output: ImagerySelection): void {
  console.log(`  decision: ${output.decision}`);
  if (output.requirement) console.log(`  requirement: ${output.requirement}`);
  if (output.rationale) console.log(`  rationale: ${output.rationale}`);
  if (output.decision === "generate" && output.prompt) {
    console.log(`  prompt (${wordCount(output.prompt)} words): ${output.prompt}`);
  }
  if (output.decision === "pool" && output.poolItemId) {
    console.log(`  pool item: ${output.poolItemId}`);
  }
}

async function runFixture(client: AnthropicLLMClient, fixture: Fixture): Promise<FixtureResult> {
  try {
    const output = await selectImagery({
      client,
      ctx: {
        entries: fixture.entries,
        currentSubjectMinute: fixture.entries[0]?.phaseSecond
          ? Math.floor(fixture.entries[0].phaseSecond / 60)
          : null,
        currentSubjectPhase: fixture.entries[0]?.phase,
        currentSubjectPhaseSecond: fixture.entries[0]?.phaseSecond,
      },
      mode: fixture.mode,
      summary: fixture.summary,
      previousImageryRationale: fixture.previousImageryRationale,
      poolItems: fixture.poolItems,
      imagerySpec: sportingEventImageryV1,
      imageryEnabled: fixture.imageryEnabled,
    });
    const hardFailures = checkHardInvariants(fixture, output);
    return { fixture, output, hardFailures };
  } catch (err) {
    return {
      fixture,
      output: null,
      error: (err as Error).message,
      hardFailures: [`selectImagery() threw: ${(err as Error).message}`],
    };
  }
}

async function main(): Promise<void> {
  console.log(`imagery eval [${PROFILE_NAME}] — running ${FIXTURES.length} fixture(s)\n`);
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
