/**
 * Controlled comparison of character_relationships (fires) vs
 * character_arcs (silent) against captured Ipswich chunks.
 *
 * Three variants per chunk:
 *   V1 — character_relationships as shipped (fires in replay)
 *   V2 — character_arcs as shipped (silent in replay)
 *   V3 — character_arcs with `trajectory` reframed as an absolute phase
 *        rather than a delta vs baseline
 *
 * Prints raw tool-call content for every call — reveals whether silence
 * is (a) an empty reports array from the LLM, (b) a malformed tool call
 * the production parser would drop, or (c) no tool use at all.
 *
 * Usage:
 *   SOURCE_BROADCAST_ID=<replay-uuid> pnpm tsx scripts/enrichment-probe.ts
 */

import "../src/env.js";
import { asc, eq } from "drizzle-orm";
import { db, sql } from "../src/db/client.js";
import { pipelineCycles } from "../src/db/schema.js";
import { AnthropicLLMClient } from "../src/llm/anthropic.js";
import type { LLMClient, LLMRequest, SystemSegment, ToolCall } from "../src/llm/types.js";
import { ENRICHMENT_MAX_TOKENS, UTILITY_ANTHROPIC_MODEL } from "../src/llm/defaults.js";

const SOURCE_BROADCAST_ID = process.env.SOURCE_BROADCAST_ID ?? process.argv[2];
if (!SOURCE_BROADCAST_ID) {
  console.error("Usage: SOURCE_BROADCAST_ID=<uuid> pnpm tsx scripts/enrichment-probe.ts");
  process.exit(1);
}

const REPORT_READINGS_TOOL = "report_readings";

// ---- Concepts — redefined inline to make variant authoring obvious ----

const CR_CONCEPT = `A character relationship is the dynamic between two actors — how they stand in relation to each other, what's charged between them, what's playing out in this moment. Relationships are tracked as pairs; each pair is its own evolving thread.`;
const CR_SUBJECT_GUIDANCE = `A subject is an ordered pair of two actors whose interaction is worth tracking. Use a stable ordering (alphabetic by the label of each party) so the same two actors always hash to the same subject id. Three-way dynamics should be decomposed into pairwise relationships; do not introduce triads.`;
const CR_READING_GUIDANCE = `Each reading has: \`parties\` (the two actor labels, alphabetically ordered); \`dynamic\` (adversarial | allied | complex | wary); \`charge\` (low | moderate | high — how loaded the relationship is right now); \`currentState\` (one sentence on what's happening between them in this moment).`;
const CR_SCHEMA = {
  type: "object",
  properties: {
    parties: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
    dynamic: { type: "string", enum: ["adversarial", "allied", "complex", "wary"] },
    charge: { type: "string", enum: ["low", "moderate", "high"] },
    currentState: { type: "string" },
  },
  required: ["parties", "dynamic", "charge", "currentState"],
  additionalProperties: false,
};

const CA_CONCEPT = `A character arc is an actor's trajectory through the narrative — how their role, their stake, and their current state are evolving. Arcs are tracked per actor; each individual is read independently.`;
const CA_SUBJECT_GUIDANCE = `A subject is one specific actor — a named individual, persona, or character with their own trajectory. One subject per actor; never combine multiple actors into a single subject. Collectives, crowds, and teams belong in Character Relationships (if as a pair) or Momentum (if as an overall scene), not here.`;
const CA_READING_GUIDANCE = `Each reading has: \`role\` (how the actor is functioning in the story right now — hero, antagonist, witness, catalyst, etc.); \`trajectory\` (ascending | descending | pivoting | holding); \`stakePosition\` (low | moderate | high — how much they have on the line); \`currentState\` (one sentence on what they're doing or carrying right now).`;
const CA_SCHEMA = {
  type: "object",
  properties: {
    role: { type: "string" },
    trajectory: { type: "string", enum: ["ascending", "descending", "pivoting", "holding"] },
    stakePosition: { type: "string", enum: ["low", "moderate", "high"] },
    currentState: { type: "string" },
  },
  required: ["role", "trajectory", "stakePosition", "currentState"],
  additionalProperties: false,
};

// V3 — trajectory reframed as an absolute phase. Same enum values, but
// the reading guidance describes them as self-contained snapshots rather
// than deltas vs a prior reading.
const CA_V3_CONCEPT = `A character arc is an actor's current phase in the narrative — who they are, what stake they carry, and where they stand in their personal journey right now. Each individual is read independently.`;
const CA_V3_READING_GUIDANCE = `Each reading has: \`role\` (how the actor is functioning in the story right now — hero, antagonist, witness, catalyst, etc.); \`trajectory\` (which phase they are in: ascending — on the rise, claiming stakes or influence; descending — losing ground; pivoting — at a turning point; holding — steady, neither gaining nor losing); \`stakePosition\` (low | moderate | high); \`currentState\` (one sentence on what they're doing or carrying right now).`;

// ---- Prompt assembly (mirrors src/enrichment/llm-enrichment.ts) ----

function buildSystemSegments(
  concept: string,
  subjectGuidance: string,
  readingGuidance: string,
): SystemSegment[] {
  const body = [
    "# Concept",
    concept.trim(),
    "",
    "# What counts as a subject",
    subjectGuidance.trim(),
    "",
    "# Reading shape",
    readingGuidance.trim(),
    "",
    "# Your task",
    [
      "Each cycle you receive three snapshots per subject you're tracking:",
      "  • expressed    — what the audience has been told about this subject",
      "  • acknowledged — a reading briefly surfaced but not fully expressed",
      "  • unexpressed  — your running truth, carrying forward from prior cycles",
      "",
      "You also receive new feed entries since the last cycle.",
      "",
      "Update the unexpressed reading for each subject you see in the new entries. When a subject from the known list reappears, reuse its id exactly. When a genuinely new subject appears, mint a new short id (e.g. `subj-<something-descriptive>`) with a clear human-readable label. Subjects not mentioned in the new entries should not appear in your response — their state holds.",
      "",
      "Report a subject if either:",
      "  • it is new this cycle (first appearance) — always emit with an initial reading grounded in the evidence",
      "  • its reading has materially shifted from its prior state (unexpressed, or expressed if no unexpressed exists yet)",
      "Omit subjects whose reading is unchanged from their prior state and where no new evidence has accumulated. If nothing is new or shifted, return an empty list.",
      "",
      "For each subject you report, `basis` should be one short sentence — what in the new entries moved the reading — and `informedBy` must list the specific entry ids that justified the update (from the entries shown below).",
      "",
      "Always call the `" + REPORT_READINGS_TOOL + "` tool.",
    ].join("\n"),
  ].join("\n");
  return [{ text: body, cache: true }];
}

function buildUserMessage(entries: ChunkEntry[]): string {
  const parts: string[] = [];
  parts.push("## Known subjects");
  parts.push("(none yet — this is the first cycle with anything to read)");
  parts.push("");
  parts.push("## Prior readings");
  parts.push("(none)");
  parts.push("");
  parts.push("## New feed entries");
  for (const e of entries) {
    const content = typeof e.data.content === "string" ? e.data.content : JSON.stringify(e.data);
    parts.push(`  [id:${e.id}] ${content}`);
  }
  return parts.join("\n");
}

function buildTool(readingSchema: Record<string, unknown>): LLMRequest["tools"] {
  return [
    {
      name: REPORT_READINGS_TOOL,
      description: "Report per-subject reading updates.",
      inputSchema: {
        type: "object",
        properties: {
          reports: {
            type: "array",
            items: {
              type: "object",
              properties: {
                subjectId: { type: "string" },
                label: { type: "string" },
                reading: readingSchema,
                basis: { type: "string" },
                informedBy: { type: "array", items: { type: "string" } },
              },
              required: ["subjectId", "label", "reading", "basis", "informedBy"],
              additionalProperties: false,
            },
          },
        },
        required: ["reports"],
        additionalProperties: false,
      },
    },
  ];
}

// ---- Telemetry ----

interface ChunkEntry {
  id: string;
  data: Record<string, unknown>;
}

interface Variant {
  name: string;
  concept: string;
  subjectGuidance: string;
  readingGuidance: string;
  schema: Record<string, unknown>;
}

interface ProbeResult {
  variant: string;
  cycleIdx: number;
  chunkSize: number;
  inputTokens: number;
  outputTokens: number;
  toolCall: ToolCall | null;
  reports: unknown[];
  rawText: string;
}

async function probe(
  client: LLMClient,
  variant: Variant,
  cycleIdx: number,
  chunk: ChunkEntry[],
): Promise<ProbeResult> {
  const system = buildSystemSegments(variant.concept, variant.subjectGuidance, variant.readingGuidance);
  const userMessage = buildUserMessage(chunk);

  const response = await client.generate({
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: buildTool(variant.schema),
    toolChoice: { type: "tool", name: REPORT_READINGS_TOOL },
    cacheTools: true,
    model: UTILITY_ANTHROPIC_MODEL,
    maxTokens: ENRICHMENT_MAX_TOKENS,
  });

  const toolCall = response.toolCalls?.[0] ?? null;
  const reports = toolCall && toolCall.name === REPORT_READINGS_TOOL
    ? ((toolCall.input as { reports?: unknown[] }).reports ?? [])
    : [];

  return {
    variant: variant.name,
    cycleIdx,
    chunkSize: chunk.length,
    inputTokens: response.usage?.inputTokens ?? 0,
    outputTokens: response.usage?.outputTokens ?? 0,
    toolCall,
    reports,
    rawText: response.text ?? "",
  };
}

function summarise(r: ProbeResult): string {
  const head = `[${r.variant.padEnd(25)}] cycle ${String(r.cycleIdx).padStart(2)} (${String(r.chunkSize).padStart(3)}e) ${String(r.inputTokens).padStart(5)}in/${String(r.outputTokens).padStart(3)}out`;
  if (!r.toolCall) {
    const preview = r.rawText.slice(0, 120).replace(/\s+/g, " ");
    return `${head}  NO TOOL CALL — raw text: "${preview}"`;
  }
  if (r.reports.length === 0) {
    return `${head}  empty reports []`;
  }
  const first = r.reports[0] as { subjectId?: string; label?: string };
  return `${head}  ${r.reports.length} report(s)  first: ${first.subjectId}/${first.label}`;
}

async function main() {
  const client = new AnthropicLLMClient({});
  console.log(`[probe] source broadcast: ${SOURCE_BROADCAST_ID}`);

  const cycles = await db
    .select()
    .from(pipelineCycles)
    .where(eq(pipelineCycles.broadcastId, SOURCE_BROADCAST_ID!))
    .orderBy(asc(pipelineCycles.triggeredAt));

  const workable = cycles.filter((c) => c.triggerReason === "accumulation" && (c.chunkEntries as ChunkEntry[]).length > 0);
  console.log(`[probe] ${workable.length} accumulation cycles with entries`);

  const variants: Variant[] = [
    {
      name: "V1-character_relationships",
      concept: CR_CONCEPT,
      subjectGuidance: CR_SUBJECT_GUIDANCE,
      readingGuidance: CR_READING_GUIDANCE,
      schema: CR_SCHEMA,
    },
    {
      name: "V2-character_arcs-original",
      concept: CA_CONCEPT,
      subjectGuidance: CA_SUBJECT_GUIDANCE,
      readingGuidance: CA_READING_GUIDANCE,
      schema: CA_SCHEMA,
    },
    {
      name: "V3-character_arcs-absolute",
      concept: CA_V3_CONCEPT,
      subjectGuidance: CA_SUBJECT_GUIDANCE,
      readingGuidance: CA_V3_READING_GUIDANCE,
      schema: CA_SCHEMA,
    },
  ];

  const allResults: ProbeResult[] = [];

  for (let i = 0; i < workable.length; i++) {
    const cycle = workable[i];
    const chunk = (cycle.chunkEntries as ChunkEntry[]).map((e) => ({
      id: String(e.id),
      data: e.data ?? {},
    }));

    console.log(`\n---- cycle ${i + 1} (${chunk.length} entries) ----`);
    for (const variant of variants) {
      try {
        const result = await probe(client, variant, i + 1, chunk);
        allResults.push(result);
        console.log(summarise(result));
        if (result.reports.length === 0 && result.toolCall) {
          // Emit the tool-call input block so we can see exactly what
          // the LLM sent when it chose silence. The inputSchema forces
          // `reports` to be present, so empty vs absent is distinguishable.
          console.log(`    tool input: ${JSON.stringify(result.toolCall.input)}`);
        }
      } catch (err) {
        console.log(`[${variant.name}] cycle ${i + 1} ERROR: ${(err as Error).message.slice(0, 180)}`);
      }
    }
  }

  // ---- Matrix summary ----
  console.log(`\n[probe] ==== firing matrix ====`);
  const byVariant = new Map<string, { fired: number; silent: number; noTool: number; totalReports: number }>();
  for (const r of allResults) {
    const bucket = byVariant.get(r.variant) ?? { fired: 0, silent: 0, noTool: 0, totalReports: 0 };
    if (!r.toolCall) bucket.noTool++;
    else if (r.reports.length === 0) bucket.silent++;
    else {
      bucket.fired++;
      bucket.totalReports += r.reports.length;
    }
    byVariant.set(r.variant, bucket);
  }
  for (const [name, stats] of byVariant) {
    const cycles = stats.fired + stats.silent + stats.noTool;
    console.log(
      `  ${name.padEnd(30)} fired: ${stats.fired}/${cycles}  silent: ${stats.silent}  no-tool: ${stats.noTool}  total reports: ${stats.totalReports}`,
    );
  }

  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
