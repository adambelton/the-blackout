/**
 * Curation eval runner — out-of-band LLM reviewer harness.
 *
 * Runs each LLM-driven curation service against one representative cycle
 * (`fixtures.ts`) — a crafted `EnrichedPayload` + a base `CurationContext`
 * with tier-1 fields pre-set — and prints the field(s) each service writes,
 * alongside its `## Eval — soft notes`. `pacing` is excluded (pure
 * arithmetic, no LLM).
 *
 * Curation output is structured judgment, so most of this is review-only.
 * The three genuinely machine-checkable rules ARE asserted as hard checks:
 * priority never removes a canonical entry and stays within the emphasis
 * budget; conflict_resolver's winner ≠ loser; saturation doesn't force
 * context_led on a fresh cycle with no recent window. Exits 1 on a hard
 * failure.
 *
 * NOT part of `pnpm test`. Usage: `pnpm eval:curation`
 * Requires ANTHROPIC_API_KEY in env (loaded from .env if present).
 */
import "../../src/env.js";
import { readFileSync } from "node:fs";
import { AnthropicLLMClient } from "../../src/llm/index.js";
import type { CurationService, CurationContext } from "../../src/curation/types.js";
import type { CurationSpecContent } from "../../src/curation/spec-types.js";
import type { ServiceSpec } from "../../src/enrichment/types.js";
import { NarrativeArcService } from "../../src/curation/services/narrative-arc.js";
import { NarrativeGapService } from "../../src/curation/services/narrative-gap.js";
import { SaturationResolver } from "../../src/curation/services/saturation-resolver.js";
import { ContextCurator } from "../../src/curation/services/context-curator.js";
import { PriorityService } from "../../src/curation/services/priority.js";
import { ConflictResolver } from "../../src/curation/services/conflict-resolver.js";
import { BroadcastSummaryService } from "../../src/curation/services/broadcast-summary.js";
import {
  sportingEventNarrativeArcV1,
  sportingEventPriorityV1,
  sportingEventNarrativeGapV1,
  sportingEventBroadcastSummaryV1,
  sportingEventSaturationResolverV1,
  sportingEventContextCuratorV1,
  sportingEventConflictResolverV1,
} from "../../src/db/seed-data/sporting-event/curation/index.js";
import { extractEvalCriteria } from "../../src/eval/spec-eval.js";
import { PAYLOAD, baseContext, BRIEF, CANONICAL_ENTRY_IDS } from "./sporting-event/fixtures.js";

const PROFILE_NAME = "sporting_event";

interface ServiceCase {
  name: string;
  make: (spec: ServiceSpec, llm: AnthropicLLMClient) => CurationService;
  spec: CurationSpecContent;
  baseline: string;
  /** Run before curate (e.g. ContextCurator hydrates its thread inventory). */
  init?: (svc: CurationService) => Promise<void>;
  /** The genuinely machine-checkable rules — returns one failure per violation. */
  hardCheck?: (after: CurationContext, base: CurationContext) => string[];
}

const SERVICES: ServiceCase[] = [
  { name: "narrative_arc", make: (s, l) => new NarrativeArcService(s, l), spec: sportingEventNarrativeArcV1, baseline: "narrative-arc" },
  { name: "narrative_gap", make: (s, l) => new NarrativeGapService(s, l), spec: sportingEventNarrativeGapV1, baseline: "narrative-gap" },
  {
    name: "saturation_resolver",
    make: (s, l) => new SaturationResolver(s, l),
    spec: sportingEventSaturationResolverV1,
    baseline: "saturation-resolver",
    hardCheck: (after) =>
      after.forceContextLed
        ? ["forceContextLed set on a fresh cycle with no recent window — nothing should be saturated"]
        : [],
  },
  {
    name: "context_curator",
    make: (s, l) => new ContextCurator(s, l),
    spec: sportingEventContextCuratorV1,
    baseline: "context-curator",
    init: async (svc) => {
      await (svc as ContextCurator).initializeFromBrief(BRIEF);
    },
  },
  {
    name: "priority",
    make: (s, l) => new PriorityService(s, l),
    spec: sportingEventPriorityV1,
    baseline: "priority",
    hardCheck: (after) => {
      const failures: string[] = [];
      const removed = Object.values(after.decisions).flatMap((d) => d.entriesRemoved);
      for (const id of removed) {
        if (CANONICAL_ENTRY_IDS.includes(id)) failures.push(`removed a canonical entry (${id}) — canonicals are protected`);
      }
      const added = Object.values(after.decisions)
        .flatMap((d) => d.entriesEmphasized)
        .filter((id) => !CANONICAL_ENTRY_IDS.includes(id));
      const nonCanonical = PAYLOAD.entries.filter((e) => !e.sourceCanonical).length;
      const budget = Math.max(3, Math.ceil(nonCanonical * 0.2));
      if (added.length > budget) failures.push(`emphasised ${added.length} non-canonical entries — over the ~${budget} budget`);
      return failures;
    },
  },
  {
    name: "conflict_resolver",
    make: (s, l) => new ConflictResolver(s, l),
    spec: sportingEventConflictResolverV1,
    baseline: "conflict-resolver",
    hardCheck: (after, base) =>
      after.conflicts
        .slice(base.conflicts.length)
        .filter((c) => c.winner.serviceName === c.loser.serviceName && c.winner.subjectId === c.loser.subjectId)
        .map((c) => `conflict winner equals loser (${c.winner.serviceName}/${c.winner.subjectId})`),
  },
  { name: "broadcast_summary", make: (s, l) => new BroadcastSummaryService(s, l), spec: sportingEventBroadcastSummaryV1, baseline: "broadcast-summary" },
];

function specRow(c: ServiceCase): ServiceSpec {
  return {
    serviceName: c.name,
    serviceType: "curation",
    eventProfileName: PROFILE_NAME,
    version: "1.0.0",
    status: "active",
    spec: c.spec as unknown as Record<string, unknown>,
  };
}

function softNotes(c: ServiceCase): string[] {
  const baselineBlob = readFileSync(
    new URL(`../../src/curation/services/${c.baseline}.baseline.md`, import.meta.url),
    "utf8",
  );
  return extractEvalCriteria(baselineBlob, c.spec.serviceInstructions).softNotes;
}

/** Print the decision fields a curation service may have written. */
function printDelta(after: CurationContext, base: CurationContext): void {
  if (after.arcPhase !== base.arcPhase) console.log(`  arcPhase: ${after.arcPhase}`);
  if (after.summary) console.log(`  summary: ${after.summary}`);
  if (after.forceContextLed) console.log(`  forceContextLed: true`);
  for (const u of after.urgentSubjects ?? []) {
    console.log(`  urgent: ${u.serviceName}/${u.subjectId} — ${u.reason}`);
  }
  for (const t of after.relevantThreads ?? []) {
    console.log(`  thread: ${t.label} — ${t.whyNow}`);
  }
  for (const c of after.conflicts.slice(base.conflicts.length)) {
    console.log(`  conflict: ${c.winner.serviceName}/${c.winner.subjectId} beats ${c.loser.serviceName}/${c.loser.subjectId} — ${c.reason}`);
  }
  for (const [key, d] of Object.entries(after.decisions)) {
    const parts: string[] = [];
    if (d.entriesEmphasized.length) parts.push(`emphasise [${d.entriesEmphasized.join(", ")}]`);
    if (d.entriesRemoved.length) parts.push(`remove [${d.entriesRemoved.join(", ")}]`);
    console.log(`  decision[${key}]: ${d.action}${parts.length ? " — " + parts.join("; ") : ""}`);
  }
}

async function main(): Promise<void> {
  console.log(`curation eval [${PROFILE_NAME}] — ${SERVICES.length} services against one cycle\n`);
  const client = new AnthropicLLMClient();
  let totalHardFailures = 0;

  for (const c of SERVICES) {
    console.log(`▶ ${c.name}`);
    const base = baseContext();
    try {
      const svc = c.make(specRow(c), client);
      if (c.init) await c.init(svc);
      const after = await svc.curate(PAYLOAD, structuredClone(base));
      printDelta(after, base);
      const failures = c.hardCheck?.(after, base) ?? [];
      if (failures.length > 0) {
        console.log(`  ✗ HARD FAILURES:`);
        for (const f of failures) console.log(`    - ${f}`);
        totalHardFailures += failures.length;
      } else if (c.hardCheck) {
        console.log(`  ✓ hard checks pass`);
      }
    } catch (err) {
      console.log(`  ERROR: ${(err as Error).message}`);
      totalHardFailures += 1;
    }
    for (const note of softNotes(c)) console.log(`  note: ${note}`);
    console.log("");
  }

  if (totalHardFailures > 0) {
    console.log(`\nFAIL: ${totalHardFailures} hard check(s) violated. (Soft notes are reviewer guidance — judge those by reading the output above.)`);
    process.exit(1);
  }
  console.log(`\nOK: hard checks pass. Soft notes are reviewer guidance — read each service's output above against them.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
