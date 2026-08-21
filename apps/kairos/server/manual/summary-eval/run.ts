/**
 * Summary eval runner — out-of-band LLM golden set.
 *
 * Walks every fixture in `fixtures.ts`, resolves the baseline +
 * v1 sporting_event summary spec, calls `updateNarrativeBlock`
 * against a real Anthropic Haiku client, asserts hard invariants
 * on the resulting note, prints soft mismatches for human
 * judgement. Exits 1 if any hard invariant is violated.
 *
 * Run before shipping any change to `summary.baseline.md`, the
 * v1 spec content in `src/db/seed-data/sporting-event/summary.md`,
 * `summary.ts`, or `assembleSectionedPrompt`. NOT part of
 * `pnpm test`.
 *
 * Usage: `pnpm tsx manual/summary-eval/run.ts`
 *
 * Requires ANTHROPIC_API_KEY in env (loaded from .env if present).
 */
import "../../src/env.js";
import { AnthropicLLMClient } from "../../src/llm/index.js";
import {
  updateNarrativeBlock,
  NARRATIVE_INSTRUCTIONS_BASELINE,
} from "../../src/narrative/summary.js";
import { sportingEventSummaryV1 } from "../../src/db/seed-data/sporting-event/index.js";
import { extractEvalCriteria, checkProseInvariants } from "../../src/eval/spec-eval.js";
import { FIXTURES, type Fixture } from "./sporting-event/fixtures.js";

const PROFILE_NAME = "sporting_event";

// The general note contract (no scoreline strings, no scorer+minute as
// state, no meta-commentary) lives in the summary spec's `## Eval` section;
// per-fixture word caps and bans stay on each fixture.
const SPEC_EVAL = extractEvalCriteria(
  NARRATIVE_INSTRUCTIONS_BASELINE,
  sportingEventSummaryV1.summaryInstructions,
);

interface FixtureResult {
  fixture: Fixture;
  note: string | null;
  error?: string;
  hardFailures: string[];
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function checkHardInvariants(fixture: Fixture, note: string): string[] {
  // Spec-level invariants (the general note contract) run against every
  // fixture; per-fixture word cap + bans follow.
  const failures: string[] = checkProseInvariants(SPEC_EVAL.hardInvariants, note);

  const words = wordCount(note);
  if (words > fixture.hard.maxWords) {
    failures.push(`note word count ${words} exceeds maxWords ${fixture.hard.maxWords}`);
  }

  if (fixture.hard.mustNotMatch) {
    for (const pattern of fixture.hard.mustNotMatch) {
      if (pattern.test(note)) {
        failures.push(`note matched forbidden pattern ${pattern}`);
      }
    }
  }
  if (fixture.hard.mustMatch) {
    for (const pattern of fixture.hard.mustMatch) {
      if (!pattern.test(note)) {
        failures.push(`note did not match required pattern ${pattern}`);
      }
    }
  }

  return failures;
}

async function runFixture(client: AnthropicLLMClient, fixture: Fixture): Promise<FixtureResult> {
  try {
    const note = await updateNarrativeBlock({
      client,
      previousNarrative: fixture.previousNarrative,
      justNarrated: fixture.justNarrated,
      newEntries: fixture.newEntries,
      summarySpec: sportingEventSummaryV1,
    });
    const hardFailures = checkHardInvariants(fixture, note);
    return { fixture, note, hardFailures };
  } catch (err) {
    return {
      fixture,
      note: null,
      error: (err as Error).message,
      hardFailures: [`updateNarrativeBlock() threw: ${(err as Error).message}`],
    };
  }
}

async function main(): Promise<void> {
  console.log(`summary eval [${PROFILE_NAME}] — running ${FIXTURES.length} fixture(s)\n`);
  const client = new AnthropicLLMClient();
  let totalHardFailures = 0;

  for (const fixture of FIXTURES) {
    console.log(`▶ ${fixture.name}`);
    console.log(`  ${fixture.describes}`);
    const result = await runFixture(client, fixture);

    if (result.error) {
      console.log(`  ERROR: ${result.error}`);
    } else if (result.note != null) {
      console.log(`  note (${wordCount(result.note)} words):`);
      for (const line of result.note.split("\n")) console.log(`    ${line}`);
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
