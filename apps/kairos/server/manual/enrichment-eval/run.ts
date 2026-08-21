/**
 * Enrichment eval runner — out-of-band LLM reviewer harness.
 *
 * Runs all six enrichment services against one representative cycle
 * (`fixtures.ts`), each with its resolved baseline + v1 sporting_event spec
 * and a live Haiku client, then prints what each service surfaces alongside
 * that service's `## Eval — soft notes`. Enrichment output is structured
 * judgment, so there are no hard regex invariants — the reviewer reads each
 * reading against the contract its soft notes describe.
 *
 * NOT part of `pnpm test`. Usage: `pnpm eval:enrichment`
 * Requires ANTHROPIC_API_KEY in env (loaded from .env if present).
 */
import "../../src/env.js";
import { readFileSync } from "node:fs";
import { AnthropicLLMClient } from "../../src/llm/index.js";
import type { EnrichmentService, ServiceSpec } from "../../src/enrichment/types.js";
import { MomentumService } from "../../src/enrichment/services/momentum.js";
import { TensionConflictService } from "../../src/enrichment/services/tension-conflict.js";
import { ThemesService } from "../../src/enrichment/services/themes.js";
import { CharacterArcsService } from "../../src/enrichment/services/character-arcs.js";
import { CharacterRelationshipsService } from "../../src/enrichment/services/character-relationships.js";
import { PatternsEchoesService } from "../../src/enrichment/services/patterns-echoes.js";
import {
  sportingEventMomentumV1,
  sportingEventTensionConflictV1,
  sportingEventThemesV1,
  sportingEventCharacterArcsV1,
  sportingEventCharacterRelationshipsV1,
  sportingEventPatternsEchoesV1,
} from "../../src/db/seed-data/sporting-event/enrichment/index.js";
import type { EnrichmentSpecContent } from "../../src/enrichment/spec-types.js";
import { extractEvalCriteria } from "../../src/eval/spec-eval.js";
import { CHUNK } from "./sporting-event/fixtures.js";

const PROFILE_NAME = "sporting_event";

interface ServiceCase {
  name: string;
  make: (spec: ServiceSpec, llm: AnthropicLLMClient) => EnrichmentService;
  spec: EnrichmentSpecContent;
  /** baseline.md basename under src/enrichment/services/ */
  baseline: string;
}

const SERVICES: ServiceCase[] = [
  { name: "momentum", make: (s, l) => new MomentumService(s, l), spec: sportingEventMomentumV1, baseline: "momentum" },
  { name: "tension_conflict", make: (s, l) => new TensionConflictService(s, l), spec: sportingEventTensionConflictV1, baseline: "tension-conflict" },
  { name: "themes", make: (s, l) => new ThemesService(s, l), spec: sportingEventThemesV1, baseline: "themes" },
  { name: "character_arcs", make: (s, l) => new CharacterArcsService(s, l), spec: sportingEventCharacterArcsV1, baseline: "character-arcs" },
  { name: "character_relationships", make: (s, l) => new CharacterRelationshipsService(s, l), spec: sportingEventCharacterRelationshipsV1, baseline: "character-relationships" },
  { name: "patterns_echoes", make: (s, l) => new PatternsEchoesService(s, l), spec: sportingEventPatternsEchoesV1, baseline: "patterns-echoes" },
];

function specRow(c: ServiceCase): ServiceSpec {
  return {
    serviceName: c.name,
    serviceType: "enrichment",
    eventProfileName: PROFILE_NAME,
    version: "1.0.0",
    status: "active",
    spec: c.spec as unknown as Record<string, unknown>,
  };
}

function softNotes(c: ServiceCase): string[] {
  const baselineBlob = readFileSync(
    new URL(`../../src/enrichment/services/${c.baseline}.baseline.md`, import.meta.url),
    "utf8",
  );
  return extractEvalCriteria(baselineBlob, c.spec.serviceInstructions).softNotes;
}

async function main(): Promise<void> {
  console.log(`enrichment eval [${PROFILE_NAME}] — ${SERVICES.length} services against one cycle\n`);
  console.log(`cycle: ${CHUNK.entries.length} entries, ${CHUNK.narrativeContext.length} brief fragments\n`);
  const client = new AnthropicLLMClient();

  for (const c of SERVICES) {
    console.log(`▶ ${c.name}`);
    try {
      const annotations = await c.make(specRow(c), client).process(CHUNK);
      if (annotations.length === 0) {
        console.log("  (no annotations — nothing materially shifted this cycle)");
      }
      for (const a of annotations) {
        console.log(`  • ${a.subjectLabel} [${a.subjectId}]`);
        console.log(`      reading: ${JSON.stringify(a.meaning.unexpressed)}`);
        console.log(`      basis:   ${a.meaning.basis}`);
        console.log(`      informedBy: [${a.informedBy.join(", ")}]`);
      }
    } catch (err) {
      console.log(`  ERROR: ${(err as Error).message}`);
    }
    for (const note of softNotes(c)) {
      console.log(`  note: ${note}`);
    }
    console.log("");
  }

  console.log(
    "Reviewer harness — no pass/fail. Read each service's readings against its soft notes above.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
