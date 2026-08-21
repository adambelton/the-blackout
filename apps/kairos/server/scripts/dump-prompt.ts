/**
 * Dumps the system prompt that runEnrichmentLLM and runCurationLLM
 * would assemble for a given (synthetic) chunk + brief, without
 * making any LLM calls. Sanity check for step 0 — confirms the brief
 * section, the K17 lens-not-gate reminder, and the per-service
 * extraction guidance all land in the cached system prompt.
 *
 * Usage: pnpm tsx scripts/dump-prompt.ts
 */

import "../src/env.js";
import { runEnrichmentLLM } from "../src/enrichment/llm-enrichment.js";
import { runCurationLLM } from "../src/curation/llm-curation.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../src/llm/types.js";
import type { FeedEntry } from "../src/types.js";

class CapturingLLM implements LLMClient {
  public lastRequest: LLMRequest | null = null;

  async generate(request: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = request;
    // Return a minimal valid tool-call response so the caller doesn't crash.
    const toolName =
      request.tools?.[0]?.name ?? "report_readings";
    return {
      text: "",
      toolCalls: [
        {
          name: toolName,
          input: toolName === "report_readings" ? { reports: [] } : {},
        },
      ],
    };
  }
}

function fakeBrief(): FeedEntry[] {
  const now = Date.now();
  const mk = (id: string, content: string): FeedEntry => ({
    id,
    broadcastId: "test-broadcast",
    sourceId: "test-source",
    sourceName: "narrative_context",
    sourceType: "narrative_context",
    timestamp: now,
    data: { content },
    enrichmentTags: [],
  });
  return [
    mk(
      "ctx-1",
      "West Ham travel to Selhurst Park needing points after a damaging defeat to Spurs. Castellanos starts up top, Bowen on the right. The big story is set-pieces — Mavropanos has scored four of West Ham's last seven goals from dead-ball situations, including a brace against Wolves last month. Palace's set-piece defending has been a problem all season.",
    ),
    mk(
      "ctx-2",
      "Crystal Palace come in fresh from a Conference League quarter-final first leg in Florence. Glasner has named a strong eleven despite the European trip; Strand Larsen leads the line, Pino in the hole behind him. Selhurst will be loud — Monday night, mid-table jeopardy, the European hangover question hanging over everything.",
    ),
    mk(
      "ctx-3",
      "Themes worth carrying: the cost of European nights for mid-tier sides; West Ham's late-season form charge; the relegation arithmetic at the bottom; Selhurst Park as a venue that punishes inattention.",
    ),
  ];
}

function fakeChunk(narrativeContext: FeedEntry[]) {
  const entry: FeedEntry = {
    id: "evt-1",
    broadcastId: "test-broadcast",
    sourceId: "match-events",
    sourceName: "match_events",
    sourceType: "event",
    timestamp: Date.now(),
    data: { content: "[PRESSURE] West Ham United (45s): 78% territory, 2 attacks, 1 dangerous" },
    enrichmentTags: [],
  };
  return {
    broadcastId: "test-broadcast",
    entries: [entry],
    fromTimestamp: Date.now() - 30_000,
    toTimestamp: Date.now(),
    narrativeContext,
  };
}

function printSystem(label: string, request: LLMRequest | null): void {
  console.log("\n" + "=".repeat(72));
  console.log(label);
  console.log("=".repeat(72));
  if (!request) {
    console.log("(no request captured)");
    return;
  }
  const system = request.system;
  if (!system) {
    console.log("(no system prompt)");
    return;
  }
  if (typeof system === "string") {
    console.log(system);
  } else {
    for (const seg of system) {
      console.log(`--- segment (cache=${seg.cache ?? false}) ---`);
      console.log(seg.text);
    }
  }
}

async function main(): Promise<void> {
  const brief = fakeBrief();

  // 1. Enrichment with brief — momentum-shaped.
  const llm1 = new CapturingLLM();
  await runEnrichmentLLM({
    client: llm1,
    concept:
      "Momentum is the rate and direction of change in narrative energy. It answers: is something building, holding, or fading?",
    subjectGuidance:
      "A subject is any entity or collective whose narrative energy can be separately assessed.",
    readingGuidance:
      "Each reading has direction (rising | stable | falling) and intensity (dormant | low | moderate | high | peak).",
    readingSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["rising", "stable", "falling"] },
        intensity: { type: "string", enum: ["dormant", "low", "moderate", "high", "peak"] },
      },
      required: ["direction", "intensity"],
      additionalProperties: false,
    },
    knownSubjects: [],
    states: { expressed: {}, unexpressed: {}, acknowledged: {} },
    chunk: fakeChunk(brief),
    briefExtractionGuidance:
      "From the writer's brief, draw any sense of the broadcast's expected energetic shape — anticipated rises, expected lulls, characters or threads whose momentum the writer is watching.",
  });
  printSystem("ENRICHMENT — momentum, with brief", llm1.lastRequest);

  // 2. Enrichment without brief (empty narrativeContext) — section should be omitted.
  const llm2 = new CapturingLLM();
  await runEnrichmentLLM({
    client: llm2,
    concept: "Momentum is the rate and direction of change in narrative energy.",
    subjectGuidance: "Any entity or collective.",
    readingGuidance: "direction + intensity.",
    readingSchema: { type: "object", additionalProperties: false },
    knownSubjects: [],
    states: { expressed: {}, unexpressed: {}, acknowledged: {} },
    chunk: fakeChunk([]),
  });
  printSystem("ENRICHMENT — momentum, NO brief (section should be absent)", llm2.lastRequest);

  // 3. Curation with brief — broadcast-summary-shaped.
  const llm3 = new CapturingLLM();
  await runCurationLLM({
    client: llm3,
    concept:
      "The broadcast summary is a compact natural-language sense of where the broadcast is right now.",
    taskGuidance:
      "Write one or two sentences a narrator would want to read at the top of their prompt.",
    toolName: "report_summary",
    readingSchema: {
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    },
    userMessage: "## Annotations this cycle\n(none)",
    parseInput: () => null,
    narrativeContext: brief,
    briefExtractionGuidance:
      "From the writer's brief, draw the through-lines the writer is tracking — themes, characters, tensions, expected shape.",
  });
  printSystem("CURATION — broadcast_summary, with brief", llm3.lastRequest);

  console.log("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
