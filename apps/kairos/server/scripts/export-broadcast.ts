/**
 * Export a completed broadcast's inputs and outputs to a directory of
 * flat files for offline comparison and analysis.
 *
 * Produces:
 *   narrative_voice.md      — author brief / narrative voice
 *   narrative_context.md    — match brief + lineups block
 *   events.jsonl            — all match_events entries, chronologically
 *   transcription.txt       — all radio transcription utterances
 *   generations.md          — every generated passage in order, with cycle refs
 *   cycles.jsonl            — full pipeline_cycles payloads (inspector-grade)
 *   summary.md              — totals, word counts, event-type breakdown
 *
 * Output goes under `data/broadcasts/<broadcast-id>/` at the repo root by
 * default — the `data/` tree is gitignored and is where the rest of the
 * project keeps per-broadcast artefacts. Override with `OUT=` or
 * `--out <path>` if needed for one-offs.
 *
 * Usage:
 *   BROADCAST_ID=<kairos-uuid> pnpm tsx scripts/export-broadcast.ts
 */

import "../src/env.js";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, asc } from "drizzle-orm";
import { db, sql } from "../src/db/client.js";
import {
  feedEntries,
  sources as sourcesTable,
  pipelineCycles,
  generations,
  broadcasts,
} from "../src/db/schema.js";

const BROADCAST_ID = process.env.BROADCAST_ID ?? process.argv[2];

// Default output: `<repo-root>/data/broadcasts/<broadcast-id>/`. The
// `data/` tree is gitignored and is the convention for per-broadcast
// artefacts in this project. Override via `OUT=` when running one-offs.
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const DEFAULT_OUT_ROOT = join(REPO_ROOT, "data", "broadcasts");
const OUT_ROOT = process.env.OUT ?? process.argv[3] ?? DEFAULT_OUT_ROOT;

if (!BROADCAST_ID) {
  console.error("Usage: BROADCAST_ID=<uuid> [OUT=<dir>] pnpm tsx scripts/export-broadcast.ts");
  process.exit(1);
}

const OUT = process.env.OUT || process.argv[3] ? OUT_ROOT : join(OUT_ROOT, BROADCAST_ID);
mkdirSync(OUT, { recursive: true });

function isoAt(ms: number | Date): string {
  const d = typeof ms === "number" ? new Date(ms) : ms;
  return d.toISOString();
}

async function main() {
  const broadcast = await db.query.broadcasts.findFirst({
    where: eq(broadcasts.id, BROADCAST_ID!),
  });
  if (!broadcast) {
    console.error(`Broadcast ${BROADCAST_ID} not found`);
    process.exit(1);
  }
  console.log(`[export] broadcast ${BROADCAST_ID} → ${OUT}`);

  // --- Source lookup (name → source row) ---------------------------------

  const sourceRows = await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.broadcastId, BROADCAST_ID!));
  const sourceById = new Map(sourceRows.map((s) => [s.id, s]));

  // --- All feed entries, chronological ----------------------------------

  const entries = await db
    .select()
    .from(feedEntries)
    .where(eq(feedEntries.broadcastId, BROADCAST_ID!))
    .orderBy(asc(feedEntries.timestamp));

  const voiceEntries: typeof entries = [];
  const contextEntries: typeof entries = [];
  const matchEventEntries: typeof entries = [];
  const transcriptionEntries: typeof entries = [];
  const otherEntries: typeof entries = [];

  for (const e of entries) {
    const source = sourceById.get(e.sourceId);
    if (!source) { otherEntries.push(e); continue; }
    if (source.type === "narrative_voice") voiceEntries.push(e);
    else if (source.type === "narrative_context") contextEntries.push(e);
    else if (source.name === "match_events") matchEventEntries.push(e);
    else if (source.name === "transcription") transcriptionEntries.push(e);
    else otherEntries.push(e);
  }

  // --- narrative_voice.md -----------------------------------------------

  const voiceText = voiceEntries
    .map((e) => (typeof e.data.content === "string" ? e.data.content : JSON.stringify(e.data)))
    .join("\n\n---\n\n");
  writeFileSync(join(OUT, "narrative_voice.md"), voiceText + "\n");
  console.log(`  narrative_voice.md: ${voiceEntries.length} entr${voiceEntries.length === 1 ? "y" : "ies"}`);

  // --- narrative_context.md ---------------------------------------------

  const contextText = contextEntries
    .map((e) => (typeof e.data.content === "string" ? e.data.content : JSON.stringify(e.data)))
    .join("\n\n---\n\n");
  writeFileSync(join(OUT, "narrative_context.md"), contextText + "\n");
  console.log(`  narrative_context.md: ${contextEntries.length} entr${contextEntries.length === 1 ? "y" : "ies"}`);

  // --- events.jsonl -----------------------------------------------------

  const eventsStream = createWriteStream(join(OUT, "events.jsonl"));
  for (const e of matchEventEntries) {
    eventsStream.write(
      JSON.stringify({
        id: e.id,
        timestamp: isoAt(e.timestamp),
        ...(e.data as Record<string, unknown>),
      }) + "\n",
    );
  }
  eventsStream.end();
  console.log(`  events.jsonl: ${matchEventEntries.length} entries`);

  // --- transcription.txt ------------------------------------------------

  const transLines = transcriptionEntries.map((e) => {
    const content = typeof e.data.content === "string" ? (e.data.content as string) : "";
    const minute = typeof e.data.minute === "number" ? `${e.data.minute}` : "";
    const subjectTime = typeof e.data.subjectTime === "string" ? (e.data.subjectTime as string) : minute;
    const ts = isoAt(e.timestamp);
    const ctPrefix = subjectTime ? `[${subjectTime}'] ` : "";
    return `${ts} ${ctPrefix}${content}`;
  });
  writeFileSync(join(OUT, "transcription.txt"), transLines.join("\n") + "\n");
  console.log(`  transcription.txt: ${transcriptionEntries.length} utterances`);

  // --- generations.md ---------------------------------------------------

  const gens = await db
    .select()
    .from(generations)
    .where(eq(generations.broadcastId, BROADCAST_ID!))
    .orderBy(asc(generations.triggeredAt));

  const genLines: string[] = [];
  genLines.push(`# ${broadcast.eventProfileName} — generated passages`);
  genLines.push(`Broadcast: ${BROADCAST_ID}`);
  genLines.push(`Total passages: ${gens.length}`);
  genLines.push("");
  gens.forEach((g, i) => {
    const words = g.wordCount;
    const inTok = (g.tokenUsage as { inputTokens?: number } | null)?.inputTokens ?? "—";
    const outTok = (g.tokenUsage as { outputTokens?: number } | null)?.outputTokens ?? "—";
    genLines.push(`## #${String(i + 1).padStart(3, "0")} — ${isoAt(g.triggeredAt)} — ${g.triggerReason} — ${words}w (${inTok}in/${outTok}out)`);
    genLines.push("");
    genLines.push(g.output.trim());
    genLines.push("");
  });
  writeFileSync(join(OUT, "generations.md"), genLines.join("\n") + "\n");
  console.log(`  generations.md: ${gens.length} passages, ${gens.reduce((a, g) => a + g.wordCount, 0)} words`);

  // --- cycles.jsonl (inspector payloads) --------------------------------

  const cycles = await db
    .select()
    .from(pipelineCycles)
    .where(eq(pipelineCycles.broadcastId, BROADCAST_ID!))
    .orderBy(asc(pipelineCycles.triggeredAt));
  const cyclesStream = createWriteStream(join(OUT, "cycles.jsonl"));
  for (const c of cycles) {
    cyclesStream.write(
      JSON.stringify({
        id: c.id,
        triggeredAt: isoAt(c.triggeredAt),
        triggerReason: c.triggerReason,
        generationId: c.generationId,
        chunkEntries: c.chunkEntries,
        annotations: c.annotations,
        curation: c.curation,
      }) + "\n",
    );
  }
  cyclesStream.end();
  console.log(`  cycles.jsonl: ${cycles.length} cycles`);

  // --- summary.md -------------------------------------------------------

  // Event-type breakdown
  const eventTypeCounts = new Map<string, number>();
  for (const e of matchEventEntries) {
    const type = (e.data as { eventType?: string }).eventType ?? "(no eventType)";
    eventTypeCounts.set(type, (eventTypeCounts.get(type) ?? 0) + 1);
  }
  const sortedEventTypes = [...eventTypeCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Generation stats
  const wordCounts = gens.map((g) => g.wordCount);
  const avgWords = wordCounts.length > 0 ? Math.round(wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length) : 0;
  const totalInputTokens = gens.reduce((a, g) => a + ((g.tokenUsage as { inputTokens?: number } | null)?.inputTokens ?? 0), 0);
  const totalOutputTokens = gens.reduce((a, g) => a + ((g.tokenUsage as { outputTokens?: number } | null)?.outputTokens ?? 0), 0);

  const firstCycle = cycles[0];
  const lastCycle = cycles[cycles.length - 1];
  const durationSec = firstCycle && lastCycle
    ? Math.round((lastCycle.triggeredAt.getTime() - firstCycle.triggeredAt.getTime()) / 1000)
    : 0;

  const summaryLines: string[] = [];
  summaryLines.push(`# Broadcast export summary`);
  summaryLines.push("");
  summaryLines.push(`- Broadcast id: \`${BROADCAST_ID}\``);
  summaryLines.push(`- Event profile: ${broadcast.eventProfileName}`);
  summaryLines.push(`- Status: ${broadcast.status}`);
  summaryLines.push(`- Duration (first → last cycle): ${Math.floor(durationSec / 60)}m ${durationSec % 60}s`);
  summaryLines.push("");
  summaryLines.push(`## Inputs`);
  summaryLines.push(`- narrative_voice entries: ${voiceEntries.length}`);
  summaryLines.push(`- narrative_context entries: ${contextEntries.length}`);
  summaryLines.push(`- match_events entries: ${matchEventEntries.length}`);
  summaryLines.push(`- transcription entries: ${transcriptionEntries.length}`);
  summaryLines.push("");
  summaryLines.push(`## match_events eventType breakdown`);
  for (const [type, count] of sortedEventTypes) {
    summaryLines.push(`- ${type}: ${count}`);
  }
  summaryLines.push("");
  summaryLines.push(`## Pipeline`);
  summaryLines.push(`- Cycles: ${cycles.length}`);
  summaryLines.push(`- Cycles with generation: ${cycles.filter((c) => c.generationId != null).length}`);
  summaryLines.push(`- External cycles: ${cycles.filter((c) => c.triggerReason === "external").length}`);
  summaryLines.push("");
  summaryLines.push(`## Generations`);
  summaryLines.push(`- Count: ${gens.length}`);
  summaryLines.push(`- Word count: min ${Math.min(...wordCounts)}, avg ${avgWords}, max ${Math.max(...wordCounts)}, total ${wordCounts.reduce((a, b) => a + b, 0)}`);
  summaryLines.push(`- Sonnet tokens: ${totalInputTokens.toLocaleString()} input / ${totalOutputTokens.toLocaleString()} output`);
  writeFileSync(join(OUT, "summary.md"), summaryLines.join("\n") + "\n");
  console.log(`  summary.md: stats + event-type breakdown`);

  console.log(`\n[export] done: ${OUT}`);
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
