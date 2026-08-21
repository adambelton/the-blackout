/**
 * Replay a previously captured broadcast through the current engine.
 *
 * Three modes:
 *
 *   - Default (canned LLM): validates engine mechanics — context bounds,
 *     inactive filtering, 429 handling, covers wiring, persistence —
 *     against real captured data without hitting the Anthropic API.
 *     Both enrichment and generation are stubbed.
 *
 *   - LIVE_ENRICHMENT=1: real Haiku for the enrichment services while
 *     generation stays canned. Cheap way to validate subject-identity
 *     stability and per-service annotation quality without paying for
 *     Sonnet on every cycle.
 *
 *   - LIVE_LLM=1: real Anthropic for everything. Tails each generation's
 *     prose as it lands, runs leak-pattern checks on the output, and
 *     surfaces the priorCovers audit.
 *
 * This is our replay-for-quality tool: long-term, it's how we reproduce
 * Kairos output bugs by re-streaming captured source data as if live.
 *
 * Usage:
 *   SOURCE_BROADCAST_ID=<uuid> pnpm tsx scripts/replay.ts
 *   [SPEED=10] [WAIT_MS=15000] [LIVE_LLM=1 | LIVE_ENRICHMENT=1]
 */

import "../src/env.js";
import { asc, eq } from "drizzle-orm";
import { createApp } from "../src/app.js";
import {
  getRuntime,
  setRuntimeDependencies,
  stopAllRuntimes,
} from "../src/broadcast.js";
import { db, sql } from "../src/db/client.js";
import {
  enrichmentServiceStates,
  feedEntries,
  generations as generationsTable,
  sources as sourcesTable,
} from "../src/db/schema.js";
import { AnthropicLLMClient } from "../src/llm/anthropic.js";
import type { LLMClient, LLMRequest, LLMResponse } from "../src/llm/types.js";
import { REPORT_READINGS_TOOL } from "../src/enrichment/llm-enrichment.js";
import { DELIVER_NARRATIVE_TOOL_NAME } from "../src/narrative/generator.js";

/**
 * Non-generation tool names — enrichment + all six curation services.
 * In LIVE_ENRICHMENT mode these route to real Haiku; only
 * `deliver_narrative` stays canned.
 */
const MEANING_TOOL_NAMES = new Set<string>([
  REPORT_READINGS_TOOL,
  "report_arc",
  "report_urgent_subjects",
  "report_priority",
  "report_conflicts",
  "report_pacing",
  "report_summary",
  "report_saturation",
]);

const SOURCE_BROADCAST_ID = process.env.SOURCE_BROADCAST_ID ?? process.argv[2];
const SPEED = parseFloat(process.env.SPEED ?? "10");
const LIVE_LLM = process.env.LIVE_LLM === "1";
const LIVE_ENRICHMENT = process.env.LIVE_ENRICHMENT === "1" || LIVE_LLM;
const WAIT_MS = parseInt(process.env.WAIT_MS ?? (LIVE_ENRICHMENT ? "60000" : "15000"), 10);
// Smoke-test guardrail: cap the number of live entries replayed. Useful
// for verifying architecture/cost changes on a short slice rather than
// paying for a full-match LIVE_LLM run.
const MAX_ENTRIES = process.env.MAX_ENTRIES ? parseInt(process.env.MAX_ENTRIES, 10) : null;

if (!SOURCE_BROADCAST_ID) {
  console.error("Usage: SOURCE_BROADCAST_ID=<uuid> pnpm tsx scripts/replay.ts");
  process.exit(1);
}

/**
 * Deterministic canned-response LLM. Dispatches on the requested tool
 * name so the same stub serves both enrichment (`report_readings` →
 * empty reports, no annotations) and generation (`deliver_narrative`
 * → counter-indexed prose).
 */
class CannedLLM implements LLMClient {
  callCount = 0;

  async generate(req: LLMRequest): Promise<LLMResponse> {
    this.callCount++;
    const toolName = requestedToolName(req);
    if (toolName && MEANING_TOOL_NAMES.has(toolName)) {
      // Canned stub for any enrichment or curation tool — return the
      // empty-but-valid shape each tool expects so the pipeline continues.
      return {
        text: "",
        usage: { inputTokens: 400, outputTokens: 30 },
        toolCalls: [{ name: toolName, input: emptyToolPayload(toolName) }],
      };
    }
    return {
      text: "",
      usage: { inputTokens: 2000, outputTokens: 200 },
      toolCalls: [
        {
          name: DELIVER_NARRATIVE_TOOL_NAME,
          input: { prose: `Replay passage ${this.callCount}.`, covers: [] },
        },
      ],
    };
  }
}

/**
 * Minimum-viable tool payloads for the canned path. Each curation
 * service validates its input and falls back cleanly on a null parse —
 * these shapes pass validation but produce no decisions.
 */
function emptyToolPayload(toolName: string): Record<string, unknown> {
  switch (toolName) {
    case REPORT_READINGS_TOOL:
      return { reports: [] };
    case "report_arc":
      return { phase: "opening", changeStrength: "stable", rationale: "canned stub" };
    case "report_urgent_subjects":
      return { urgentSubjects: [] };
    case "report_priority":
      return { emphasisEntryIds: [], removeEntryIds: [], rationale: "canned stub" };
    case "report_conflicts":
      return { conflicts: [] };
    case "report_pacing":
      return { recommendedWordCount: 120, cadenceMs: 30_000, rationale: "canned stub" };
    case "report_summary":
      return { summary: "canned stub" };
    case "report_saturation":
      return { saturated: [], shouldHoldGeneration: false, rationale: "canned stub" };
    default:
      return {};
  }
}

function requestedToolName(req: LLMRequest): string | undefined {
  if (req.toolChoice?.type === "tool") return req.toolChoice.name;
  return req.tools?.[0]?.name;
}

/**
 * Routes requests to different inner clients based on the requested
 * tool — enrichment to one, generation to the other. Used by the
 * LIVE_ENRICHMENT mode to hit Haiku for enrichment while keeping
 * generation on the canned stub.
 */
class RoutingLLM implements LLMClient {
  constructor(
    private readonly enrichment: LLMClient,
    private readonly generation: LLMClient,
  ) {}

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const toolName = requestedToolName(req);
    // Any non-generation tool (enrichment + curation) routes to the
    // live Haiku client in LIVE_ENRICHMENT mode. Generation stays canned.
    const target =
      toolName && MEANING_TOOL_NAMES.has(toolName) ? this.enrichment : this.generation;
    return target.generate(req);
  }
}

/**
 * Wraps an LLMClient to tail each generation inline as it lands.
 * Prints cycle #, latency, token usage, and a prose preview. Also
 * surfaces the "Already narrated in prior passages" block if present
 * in the user message, proving the priorCovers wiring end-to-end.
 *
 * Tracks in-flight promises so the script can wait for rate-limit-queued
 * calls to settle before ending the DB connection — without this, late
 * calls resolve against an ended pool and their generations are lost.
 */
class TailingLLM implements LLMClient {
  callCount = 0;
  private pending = new Set<Promise<LLMResponse>>();
  constructor(private inner: LLMClient) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  async waitForIdle(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.allSettled(Array.from(this.pending));
    }
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    // Enrichment calls pass through without tailing — they're high-volume
    // and would bury the narrative output. The end-of-run enrichment
    // summary covers their contribution.
    const toolName = requestedToolName(req);
    if (toolName !== DELIVER_NARRATIVE_TOOL_NAME) {
      const promise = this.inner.generate(req);
      this.pending.add(promise);
      try {
        return await promise;
      } finally {
        this.pending.delete(promise);
      }
    }

    this.callCount++;
    const n = this.callCount;
    const userMsg = req.messages.find((m) => m.role === "user")?.content ?? "";
    const priorBlock = userMsg.match(/Already narrated in prior passages[\s\S]*?(?=\nHere is the latest)/);
    const priorCount = priorBlock ? (priorBlock[0].match(/\n- /g)?.length ?? 0) : 0;

    const t0 = Date.now();
    const promise = this.inner.generate(req);
    this.pending.add(promise);
    try {
      const res = await promise;
      const dt = Date.now() - t0;

      const toolCall = res.toolCalls?.find((t) => t.name === DELIVER_NARRATIVE_TOOL_NAME);
      const prose = toolCall ? String((toolCall.input as { prose?: unknown }).prose ?? "") : res.text;
      const covers = toolCall ? (((toolCall.input as { covers?: unknown[] }).covers ?? []) as Array<{ entryId: string }>).length : 0;
      const preview = prose.length > 240 ? `${prose.slice(0, 240)}…` : prose;

      console.log(
        `\n[gen #${n}] (${dt}ms, ${res.usage?.inputTokens ?? "?"}in/${res.usage?.outputTokens ?? "?"}out, priorCovers=${priorCount}, newCovers=${covers})`,
      );
      console.log(`  ${preview.replace(/\n/g, "\n  ")}`);
      return res;
    } finally {
      this.pending.delete(promise);
    }
  }
}

const LEAK_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\[ZONE\]|\[PRESSURE\]/, label: "raw bracket tag" },
  { re: /cover(ing|s|ed)\s+minut/i, label: "coverage-span ('covering minute …')" },
  { re: /during\s+this\s+passage/i, label: "self-reference ('during this passage')" },
  { re: /\b(in|over)\s+(the\s+)?(last|past|previous|recent)\s+(few|couple|several|next)\s+(moments?|minutes?)/i, label: "generic meta phrase" },
];

function scanProse(prose: string): string[] {
  return LEAK_PATTERNS.filter((p) => p.re.test(prose)).map((p) => p.label);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// Replay summary stats are derived directly from `contextPackage`
// fields the engine persists post-refactor. The former `AssemblyStats`
// shape (droppedRecency / droppedBudget / etc.) retired alongside the
// assembly stage in Phase 3 of the pipeline-fix plan.

async function main() {
  const canned = new CannedLLM();
  let llm: LLMClient;
  let mode: string;
  if (LIVE_LLM) {
    llm = new TailingLLM(new AnthropicLLMClient({}));
    mode = "LIVE (Anthropic — all calls)";
  } else if (LIVE_ENRICHMENT) {
    const real = new AnthropicLLMClient({});
    llm = new RoutingLLM(real, canned);
    mode = "LIVE enrichment (Haiku) + canned generation";
  } else {
    llm = canned;
    mode = "canned (all calls)";
  }
  setRuntimeDependencies({ llm });
  console.log(`[replay] mode: ${mode}`);

  const app = createApp();
  const fetch = (path: string, init?: RequestInit) =>
    app.fetch(new Request(`http://replay.local${path}`, init));
  const jsonPost = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const jsonPatch = (body: unknown): RequestInit => ({
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  console.log(`[replay] source broadcast: ${SOURCE_BROADCAST_ID}`);
  console.log(`[replay] speed: ${SPEED}x`);

  // Pull source definitions and entries from the original broadcast.
  const origSources = await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.broadcastId, SOURCE_BROADCAST_ID));
  if (origSources.length === 0) {
    console.error(`[replay] no sources found for broadcast ${SOURCE_BROADCAST_ID}`);
    process.exit(1);
  }

  const origRows = await db
    .select({ entry: feedEntries, source: sourcesTable })
    .from(feedEntries)
    .innerJoin(sourcesTable, eq(feedEntries.sourceId, sourcesTable.id))
    .where(eq(feedEntries.broadcastId, SOURCE_BROADCAST_ID))
    .orderBy(asc(feedEntries.timestamp));

  const ambient = origRows.filter(
    (r) => r.source.type === "narrative_voice" || r.source.type === "narrative_context",
  );
  const liveAll = origRows.filter(
    (r) => r.source.type !== "narrative_voice" && r.source.type !== "narrative_context",
  );
  const live = MAX_ENTRIES != null ? liveAll.slice(0, MAX_ENTRIES) : liveAll;
  const capNote = MAX_ENTRIES != null ? ` (capped from ${liveAll.length} via MAX_ENTRIES=${MAX_ENTRIES})` : "";
  console.log(`[replay] entries: ${ambient.length} ambient (voice+context), ${live.length} live${capNote}`);

  // Create a fresh replay broadcast.
  const created = await fetch(
    "/broadcasts",
    jsonPost({
      event_profile: "sporting_event",
      sources: origSources.map((s) => ({
        name: s.name,
        type: s.type,
        canonical: s.canonical,
        enrichment_tags: s.enrichmentTags ?? [],
        config: s.config ?? {},
      })),
    }),
  );
  const createdBody = (await created.json()) as { broadcast: { id: string } };
  const replayId = createdBody.broadcast.id;
  console.log(`[replay] new broadcast: ${replayId}`);

  // Seed voice + context from the original.
  for (const row of ambient) {
    const res = await fetch(
      `/broadcasts/${replayId}/entries`,
      jsonPost({ source: row.source.name, data: row.entry.data }),
    );
    if (res.status !== 201) {
      console.error(`[replay] failed to seed ${row.source.type} entry:`, await res.text());
      process.exit(1);
    }
  }
  console.log(`[replay] voice + context seeded`);

  // Activate.
  const activated = await fetch(`/broadcasts/${replayId}`, jsonPatch({ status: "active" }));
  if (activated.status !== 200) {
    console.error(`[replay] activation failed:`, await activated.text());
    process.exit(1);
  }
  console.log(`[replay] activated — streaming ${live.length} entries at ${SPEED}x`);

  // Replay live entries. Preserve inter-entry gaps scaled by SPEED.
  const firstTs = live[0]?.entry.timestamp.getTime() ?? Date.now();
  const replayStart = Date.now();
  let pushed = 0;
  let lastLog = Date.now();

  for (const row of live) {
    const origDelayMs = row.entry.timestamp.getTime() - firstTs;
    const scaledDelayMs = origDelayMs / SPEED;
    const targetTime = replayStart + scaledDelayMs;
    const waitMs = targetTime - Date.now();
    if (waitMs > 5) await sleep(waitMs);

    const res = await fetch(
      `/broadcasts/${replayId}/entries`,
      jsonPost({ source: row.source.name, data: row.entry.data }),
    );
    if (res.status !== 201) {
      console.error(`[replay] push failed at entry ${pushed}:`, await res.text());
      break;
    }
    pushed++;

    if (pushed % 250 === 0 || Date.now() - lastLog > 10_000) {
      const elapsedS = ((Date.now() - replayStart) / 1000).toFixed(0);
      console.log(`[replay] ${pushed}/${live.length} pushed (t+${elapsedS}s)`);
      lastLog = Date.now();
    }
  }

  console.log(`[replay] all ${pushed} entries pushed. Waiting ${WAIT_MS}ms for final flushes...`);
  await sleep(WAIT_MS);

  // Stash a pipeline reference before the complete transition disposes
  // the runtime — we need it to drain in-flight flushes before closing
  // the DB pool below.
  const pipelineToDrain = getRuntime(replayId)?.pipeline ?? null;

  // Mark the replay broadcast complete — otherwise subsequent API
  // touches (e.g. opening the inspector) would rehydrate the runtime
  // and fire improv cycles against a broadcast that's logically done.
  // This also stops the in-process pipeline, so no NEW generations
  // enqueue after this point.
  const completed = await fetch(`/broadcasts/${replayId}`, jsonPatch({ status: "complete" }));
  if (completed.status !== 200) {
    console.warn(`[replay] could not complete broadcast:`, await completed.text());
  } else {
    console.log(`[replay] broadcast marked complete`);
  }

  // Drain any flush that was already in-flight when stop() cleared the
  // timer. Without this, a late flush's LLM + DB calls land on a closed
  // `sql` pool and its annotations / state are lost.
  if (pipelineToDrain) {
    await pipelineToDrain.waitForIdle();
  }

  // Drain in-flight LLM calls before the DB pool closes. Rate-limit-queued
  // Anthropic calls can stay pending for 4+ minutes; without this wait
  // they resolve against an ended `sql` pool and their generations are
  // lost (wasted Anthropic spend, missing rows in the summary).
  if (LIVE_LLM && llm instanceof TailingLLM) {
    if (llm.pendingCount > 0) {
      console.log(`[replay] draining ${llm.pendingCount} in-flight LLM call(s) before summary...`);
      await llm.waitForIdle();
      console.log(`[replay] drain complete`);
    }
  }

  // Pull the generation rows for the replay broadcast and summarise.
  const gens = await db
    .select()
    .from(generationsTable)
    .where(eq(generationsTable.broadcastId, replayId));

  const contextSizes = gens
    .map((g) => ((g.contextPackage as { includedEntryIds?: string[] }).includedEntryIds ?? []).length)
    .filter((n) => n > 0);
  const tokens = gens
    .map((g) => (g.tokenUsage as { inputTokens?: number } | null)?.inputTokens)
    .filter((n): n is number => typeof n === "number" && n > 0);
  const toolCallFailed = gens.filter(
    (g) => (g.contextPackage as { toolCallFailed?: boolean }).toolCallFailed,
  ).length;

  const llmCallCount = LIVE_LLM ? (llm as TailingLLM).callCount : canned.callCount;
  console.log(`\n[replay] ==== summary ====`);
  console.log(`  replay broadcast id:     ${replayId}`);
  console.log(`  entries pushed:          ${pushed}`);
  console.log(`  LLM calls:               ${llmCallCount}`);
  console.log(`  generations persisted:   ${gens.length}`);
  if (tokens.length > 0) {
    console.log(`  input tokens (Sonnet)    max: ${Math.max(...tokens)}  p95: ${percentile(tokens, 95)}  p50: ${median(tokens)}  min: ${Math.min(...tokens)}`);
  }
  if (contextSizes.length > 0) {
    console.log(`  curated entries          max: ${Math.max(...contextSizes)}  p95: ${percentile(contextSizes, 95)}  p50: ${median(contextSizes)}  min: ${Math.min(...contextSizes)}`);
  }
  console.log(`  tool-call failures:      ${toolCallFailed}`);

  if (LIVE_ENRICHMENT) {
    const states = await db
      .select()
      .from(enrichmentServiceStates)
      .where(eq(enrichmentServiceStates.broadcastId, replayId));

    console.log(`\n[replay] ==== enrichment state ====`);
    if (states.length === 0) {
      console.log(`  (no enrichment state persisted — services may not have run)`);
    } else {
      for (const s of states) {
        const expressed = Object.keys((s.expressedState ?? {}) as Record<string, unknown>).length;
        const unexpressed = Object.keys((s.unexpressedState ?? {}) as Record<string, unknown>).length;
        const acknowledged = Object.keys((s.acknowledgedState ?? {}) as Record<string, unknown>).length;
        const union = new Set([
          ...Object.keys((s.expressedState ?? {}) as Record<string, unknown>),
          ...Object.keys((s.unexpressedState ?? {}) as Record<string, unknown>),
          ...Object.keys((s.acknowledgedState ?? {}) as Record<string, unknown>),
        ]);
        console.log(
          `  ${s.serviceName.padEnd(25)}  subjects: ${String(union.size).padStart(2)}  (expressed: ${expressed}, unexpressed: ${unexpressed}, acknowledged: ${acknowledged})`,
        );
      }
    }
  }

  if (LIVE_LLM) {
    const ordered = [...gens].sort((a, b) => a.triggeredAt.getTime() - b.triggeredAt.getTime());
    const seenCovers = new Set<string>();
    const flagged: Array<{ idx: number; flags: string[]; excerpt: string }> = [];

    console.log(`\n[replay] ==== narrative quality ====`);
    for (let i = 0; i < ordered.length; i++) {
      const g = ordered[i];
      const prior = seenCovers.size;
      const covers = g.covers ?? [];
      const flags = scanProse(g.output);
      if (flags.length > 0) {
        const excerpt = g.output.length > 160 ? `${g.output.slice(0, 160)}…` : g.output;
        flagged.push({ idx: i + 1, flags, excerpt });
      }
      console.log(
        `  gen ${String(i + 1).padStart(2)}:  priorCovers=${String(prior).padStart(3)}  newCovers=${String(covers.length).padStart(2)}  words=${String(g.wordCount).padStart(4)}  flags=${flags.length ? flags.join(", ") : "clean"}`,
      );
      for (const c of covers) seenCovers.add(c.entryId);
    }

    if (flagged.length > 0) {
      console.log(`\n[replay] ${flagged.length} flagged generation(s):`);
      for (const f of flagged) {
        console.log(`  gen ${f.idx}: ${f.flags.join("; ")}`);
        console.log(`    "${f.excerpt}"`);
      }
    } else {
      console.log(`\n[replay] no leak patterns detected across ${ordered.length} generations`);
    }
    console.log(`  unique covers accumulated: ${seenCovers.size}`);
  }

  // Give the app a chance to finalise outstanding writes before we tear down.
  stopAllRuntimes();
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
