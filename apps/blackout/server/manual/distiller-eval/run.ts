/**
 * Distiller eval runner — out-of-band LLM golden set.
 *
 * Walks every fixture in `fixtures.ts`, calls the live distiller for
 * each, asserts hard invariants, and prints soft mismatches for human
 * judgement. Exits 1 if any hard invariant is violated.
 *
 * Run before shipping any change to `distiller.ts` SYSTEM prose, the
 * tool schema, or the Haiku model version. NOT part of `pnpm test`.
 *
 * Usage: `pnpm tsx manual/distiller-eval/run.ts`
 *
 * Requires ANTHROPIC_API_KEY in env (loaded from .env if present).
 */
import "../../src/env.js";
import { distillCommentary, type DistillationOutput } from "../../src/lib/distiller.js";
import { FIXTURES, type Fixture } from "./fixtures.js";

interface FixtureResult {
  fixture: Fixture;
  output: DistillationOutput | null;
  error?: string;
  hardFailures: string[];
}

function checkHardInvariants(fixture: Fixture, output: DistillationOutput): string[] {
  const failures: string[] = [];
  const claimClasses = new Set(output.eventClaim.map((c) => c.eventClass));

  if (fixture.hard.claimsMustInclude) {
    for (const required of fixture.hard.claimsMustInclude) {
      if (!claimClasses.has(required)) {
        failures.push(
          `expected eventClaim of class ${required} — got [${[...claimClasses].join(", ") || "none"}]`,
        );
      }
    }
  }

  if (fixture.hard.claimsMustNotInclude) {
    for (const forbidden of fixture.hard.claimsMustNotInclude) {
      if (claimClasses.has(forbidden)) {
        failures.push(
          `forbidden eventClaim of class ${forbidden} — distiller emitted one anyway`,
        );
      }
    }
  }

  if (fixture.hard.atmosphereMustNotContainPhrase) {
    for (const pattern of fixture.hard.atmosphereMustNotContainPhrase) {
      for (const a of output.atmosphere) {
        if (pattern.test(a.content)) {
          failures.push(
            `atmosphere line contains forbidden phrase ${pattern}: "${a.content}"`,
          );
        }
      }
    }
  }

  return failures;
}

function printSummary(output: DistillationOutput): void {
  console.log(`  atmosphere   (${output.atmosphere.length}):`);
  for (const a of output.atmosphere) console.log(`    - ${a.content}`);
  console.log(`  eventTexture (${output.eventTexture.length}):`);
  for (const t of output.eventTexture) {
    console.log(`    - [${t.eventHint.eventClass}] ${t.content}`);
  }
  console.log(`  eventClaim   (${output.eventClaim.length}):`);
  for (const c of output.eventClaim) {
    const id = [c.eventClass, c.player, c.team, c.contentTimeHint].filter(Boolean).join(" / ");
    console.log(`    - ${id}`);
  }
}

async function runFixture(fixture: Fixture): Promise<FixtureResult> {
  try {
    const output = await distillCommentary({
      lines: fixture.lines,
      recentCanonicalEvents: fixture.recentCanonicalEvents ?? [],
      contentTimeAnchor: fixture.contentTimeAnchor ?? null,
      homeRoster: fixture.homeRoster,
      awayRoster: fixture.awayRoster,
      homeTeamName: fixture.homeTeamName,
      awayTeamName: fixture.awayTeamName,
    });
    const hardFailures = checkHardInvariants(fixture, output);
    return { fixture, output, hardFailures };
  } catch (err) {
    return {
      fixture,
      output: null,
      error: (err as Error).message,
      hardFailures: [`distiller threw: ${(err as Error).message}`],
    };
  }
}

async function main(): Promise<void> {
  console.log(`distiller eval — running ${FIXTURES.length} fixture(s)\n`);
  let totalHardFailures = 0;

  for (const fixture of FIXTURES) {
    console.log(`▶ ${fixture.name}`);
    console.log(`  ${fixture.describes}`);
    const result = await runFixture(fixture);

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
