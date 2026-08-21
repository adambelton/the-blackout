import type { WebSocket } from "ws";
import { inArray } from "drizzle-orm";
import { Feed } from "./feed.js";
import { NarrativeEngine } from "./narrative/engine.js";
import { ServiceRegistry } from "./registry.js";
import { CyclePipeline, DEFAULT_FLUSH_INTERVAL_MS } from "./pipeline/pipeline.js";
import { Curator } from "./curation/curator.js";
import { BroadcastStateTracker } from "./curation/state-tracker.js";
import { RecentCyclesBuffer } from "./curation/recent-cycles.js";
import { getBroadcastWithConfig, updateBroadcast } from "./db/broadcasts.js";
import type { BroadcastWithConfig, SourceRow } from "./db/broadcasts.js";
import type { FeedEntry } from "./types.js";
import { AnthropicLLMClient } from "./llm/anthropic.js";
import type { LLMClient } from "./llm/types.js";
import type { BroadcastStatus, SourceType } from "./db/enums.js";
import { db } from "./db/client.js";
import { feedEntries } from "./db/schema.js";
import { ContextCurator } from "./curation/services/context-curator.js";
import type { NarrativeThread } from "./curation/types.js";

export interface RuntimeDependencies {
  llm?: LLMClient;
}

let defaultDependencies: RuntimeDependencies = {};

/** Override runtime dependencies (tests use this to inject a stub LLM). */
export function setRuntimeDependencies(deps: RuntimeDependencies): void {
  defaultDependencies = deps;
}

interface GeneratorConfig {
  model?: string;
  max_tokens?: number;
  recency_ms?: number;
  max_context_tokens?: number;
  /** Assumed TTS words-per-minute for the configured voice. */
  narration_wpm?: number;
  /** Fraction of the cycle window the narrator should fill (0–1). */
  utilization?: number;
  /**
   * Designated refrains with per-phase budgets. The engine scans prior
   * generations for each phrase and injects a usage line into the
   * prompt so the narrator stops reaching for an over-spent motif.
   * Consumer-supplied — narrator voice briefs typically name a handful
   * of motifs the voice leans on ("Eleven years / December 2014",
   * "Still nil", a bespoke stadium chant).
   */
  refrains?: RefrainBudget[];
  /** Per-broadcast tense — `past | present | dynamic`. Composed into a
   * config-derived prompt segment appended after the assembled task
   * instructions. Defaults to undefined (no tense directive). */
  tense?: "past" | "present" | "dynamic";
}

interface ImageryConfig {
  /** When false, the imagery selector short-circuits to `hold` without
   * a Haiku call — useful for cost-gating or for consumers who don't
   * want imagery on this broadcast. Defaults to true. */
  enabled?: boolean;
}

function readImageryConfig(config: BroadcastWithConfig): ImageryConfig {
  return (config.broadcast.config as { imagery?: ImageryConfig } | null)?.imagery ?? {};
}

export interface RefrainBudget {
  phrase: string;
  /** Max occurrences per phase. */
  maxPerPhase?: number;
  /** Max total occurrences across the whole broadcast. */
  maxTotal?: number;
}

interface PipelineConfig {
  /** How long the pipeline buffers entries before each flush. */
  flush_interval_ms?: number;
}

function readGeneratorConfig(config: BroadcastWithConfig): GeneratorConfig {
  return (config.broadcast.config as { generator?: GeneratorConfig } | null)?.generator ?? {};
}

function readPipelineConfig(config: BroadcastWithConfig): PipelineConfig {
  return (config.broadcast.config as { pipeline?: PipelineConfig } | null)?.pipeline ?? {};
}

function buildLLMClient(config: BroadcastWithConfig): LLMClient {
  if (defaultDependencies.llm) return defaultDependencies.llm;

  const generator = readGeneratorConfig(config);
  return new AnthropicLLMClient({
    defaultModel: generator.model,
    defaultMaxTokens: generator.max_tokens,
  });
}

export interface BroadcastRuntime {
  broadcastId: string;
  feed: Feed;
  narrative: NarrativeEngine;
  pipeline: CyclePipeline;
  curator: Curator;
  registry: ServiceRegistry;
  stateTracker: BroadcastStateTracker;
  subscribers: Set<WebSocket>;
}

const runtimes = new Map<string, BroadcastRuntime>();

// In-flight startRuntime promises, keyed by broadcastId. The set-on-completion
// guard (`runtimes.has`) below isn't enough on its own: brief-init awaits
// ~13s of LLM calls before the runtime is registered, so two concurrent
// activate requests both pass that guard and each build their own runtime
// with its own fresh `subscribers` Set. The second one's `runtimes.set`
// overwrites the first; any WS that connected during the window lands in
// the orphan Set and never sees another message. This map serialises
// concurrent starts so the second caller awaits the first's runtime.
const runtimeStarts = new Map<string, Promise<BroadcastRuntime>>();

export function getRuntime(broadcastId: string): BroadcastRuntime | undefined {
  return runtimes.get(broadcastId);
}

export async function ensureRuntime(
  broadcastId: string,
): Promise<BroadcastRuntime | null> {
  const existing = runtimes.get(broadcastId);
  if (existing) return existing;

  const config = await getBroadcastWithConfig(broadcastId);
  if (!config) return null;
  if (config.broadcast.status !== "active") return null;

  return startRuntime(config);
}

export async function startRuntime(config: BroadcastWithConfig): Promise<BroadcastRuntime> {
  const { broadcast } = config;
  const existing = runtimes.get(broadcast.id);
  if (existing) return existing;
  const inFlight = runtimeStarts.get(broadcast.id);
  if (inFlight) return inFlight;

  const promise = buildRuntime(config);
  runtimeStarts.set(broadcast.id, promise);
  try {
    return await promise;
  } finally {
    runtimeStarts.delete(broadcast.id);
  }
}

async function buildRuntime(config: BroadcastWithConfig): Promise<BroadcastRuntime> {
  const { broadcast } = config;
  const feed = new Feed(broadcast.id);
  await feed.hydrate();

  const subscribers = new Set<WebSocket>();

  const llm = buildLLMClient(config);

  const registry = new ServiceRegistry();
  await registry.initialize(broadcast.id, broadcast.eventProfileName, llm);

  // Brief initialisation pass — read the writer's brief through every
  // service's lens before any cycle runs, seeding subject priors and
  // ContextCurator's thread inventory. Skipped on conductor restart
  // when persistence already carries the seeded state forward;
  // otherwise the LLM calls run in parallel against the brief alone.
  await initializeServicesFromBrief(broadcast.id, broadcast.briefThreadInventory ?? null, feed, registry);

  const generatorConfig = readGeneratorConfig(config);
  const pipelineConfig = readPipelineConfig(config);
  const stateTracker = new BroadcastStateTracker(broadcast.id, registry);
  const recentCycles = new RecentCyclesBuffer();
  const curator = new Curator(registry, stateTracker, recentCycles, {
    // Budget moved from the assembly stage into curation (Phase 2 of
    // the pipeline-fix plan). Config key retained as
    // `generator.max_context_tokens` for backward-compat; curation is
    // the authority that enforces it now.
    maxContextTokens: generatorConfig.max_context_tokens,
    // Pacing reads this to size word counts to the actual cycle window
    // (`words ≈ wpm × cycleMs / 60000 × phaseModifier`). Same source
    // as the pipeline's own `flushIntervalMs` so the two stay in sync.
    cycleIntervalMs: pipelineConfig.flush_interval_ms ?? DEFAULT_FLUSH_INTERVAL_MS,
  });
  const pipeline = new CyclePipeline(broadcast.id, registry, curator, {
    flushIntervalMs: pipelineConfig.flush_interval_ms,
    onCyclePersisted: (cycleId) => {
      const payload = JSON.stringify({ type: "cycle_complete", cycleId, broadcastId: broadcast.id });
      for (const ws of subscribers) ws.send(payload);
    },
    // narrative_context is ambient and immutable for the broadcast,
    // but the brief can be refined while pending — derive from the
    // feed's in-memory cache each cycle so refinements made before
    // activation are reflected without re-hydrating.
    getNarrativeContext: () => feed.getAll().filter((e) => e.sourceType === "narrative_context"),
    recentCycles,
  });
  const imageryConfig = readImageryConfig(config);
  const narrative = new NarrativeEngine(broadcast.id, feed, subscribers, llm, stateTracker, {
    cycleDurationMs: pipeline.getFlushIntervalMs(),
    narrationWpm: generatorConfig.narration_wpm,
    utilization: generatorConfig.utilization,
    refrains: generatorConfig.refrains,
    // Resolved at registry.initialize — null when no spec row exists
    // for the profile; engine falls back to baseline-only assembly.
    generationSpec: registry.getGenerationSpec(),
    imagerySpec: registry.getImagerySpec(),
    summarySpec: registry.getSummarySpec(),
    tense: generatorConfig.tense,
    imageryEnabled: imageryConfig.enabled,
  });

  curator.setOnCurated(async (curated) => {
    const output = await narrative.driveGeneration(curated);
    if (output) {
      await curator.sendFeedback(curated);
    }
    return output;
  });

  const runtime: BroadcastRuntime = {
    broadcastId: broadcast.id,
    feed,
    narrative,
    pipeline,
    curator,
    registry,
    stateTracker,
    subscribers,
  };

  feed.subscribe((entry: FeedEntry) => {
    runtime.pipeline.onEntry(entry);
    for (const ws of runtime.subscribers) {
      ws.send(JSON.stringify({ type: "entry", entry }));
    }
  });

  pipeline.start();

  runtimes.set(broadcast.id, runtime);
  console.log(`[broadcast] runtime started: ${broadcast.id}`);
  return runtime;
}

/**
 * Read the writer's brief from the feed, then in parallel:
 *   - call `initializeFromBrief` on every enrichment service (each
 *     opt-in via `briefInitializationConfig`; patterns_echoes and
 *     anything else that returns null is a no-op);
 *   - extract or hydrate ContextCurator's thread inventory.
 *
 * On a fresh broadcast, the LLM calls run in parallel and the curator's
 * inventory is persisted to `broadcasts.briefThreadInventory` so a
 * conductor restart skips the extraction. Enrichment service state is
 * persisted via the existing `enrichment_service_states` table after
 * the first cycle's `persistEnrichmentStates`; here we trigger a
 * persist immediately so the seeded state survives any restart that
 * predates cycle 1.
 *
 * Failures are logged and swallowed — a service whose brief-init call
 * fails reaches cycle 1 with empty state, which is the pre-piece-2.5
 * behaviour. Better than blocking activation.
 */
async function initializeServicesFromBrief(
  broadcastId: string,
  persistedInventory: NarrativeThread[] | null,
  feed: Feed,
  registry: ServiceRegistry,
): Promise<void> {
  const briefText = feed.getAll()
    .filter((e) => e.sourceType === "narrative_context")
    .map((e) => (typeof e.data?.content === "string" ? (e.data.content as string) : ""))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");

  if (!briefText.trim()) {
    console.log(`[broadcast:${broadcastId}] brief-init: brief is empty — skipping`);
    return;
  }

  const contextCurator = registry
    .getCurationServices()
    .find((s): s is ContextCurator => s.name === "context_curator") as ContextCurator | undefined;

  // Hydrate ContextCurator from persistence first — saves the Haiku
  // call entirely on conductor restarts.
  if (contextCurator && persistedInventory && persistedInventory.length > 0) {
    contextCurator.hydrateThreadInventory(persistedInventory);
    console.log(
      `[broadcast:${broadcastId}] brief-init: hydrated ContextCurator from persistence (${persistedInventory.length} threads)`,
    );
  }

  const enrichmentServices = registry.getEnrichmentServices();
  const startedAt = Date.now();
  const results = await Promise.allSettled([
    ...enrichmentServices.map((svc) =>
      svc.initializeFromBrief(briefText).then(() => ({ kind: "enrichment" as const, name: svc.name })),
    ),
    ...(contextCurator && (!persistedInventory || persistedInventory.length === 0)
      ? [
          contextCurator.initializeFromBrief(briefText).then((threads) => ({
            kind: "curator" as const,
            name: contextCurator.name,
            threads,
          })),
        ]
      : []),
  ]);

  const durationMs = Date.now() - startedAt;
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length > 0) {
    for (const f of failures) {
      console.warn(`[broadcast:${broadcastId}] brief-init failure: ${f.reason}`);
    }
  }

  // Persist outcomes:
  //  - enrichment seed state via the existing per-broadcast state table.
  //  - ContextCurator inventory on the broadcast row, but only if we
  //    actually ran the extraction (skip the DB write on the hydrate path).
  await registry.persistEnrichmentStates().catch((err) => {
    console.warn(`[broadcast:${broadcastId}] brief-init: persistEnrichmentStates failed: ${(err as Error).message}`);
  });

  for (const r of results) {
    if (r.status === "fulfilled" && r.value.kind === "curator") {
      try {
        await updateBroadcast(broadcastId, { briefThreadInventory: r.value.threads });
      } catch (err) {
        console.warn(`[broadcast:${broadcastId}] brief-init: persist thread inventory failed: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    `[broadcast:${broadcastId}] brief-init: ${enrichmentServices.length} enrichment + ${contextCurator ? 1 : 0} curator service(s), ${durationMs}ms wall-clock`,
  );
}

export function stopRuntime(broadcastId: string): void {
  const runtime = runtimes.get(broadcastId);
  if (!runtime) return;

  runtime.pipeline.stop();
  runtime.narrative.destroy();

  for (const ws of runtime.subscribers) {
    ws.close();
  }
  runtime.subscribers.clear();

  runtimes.delete(broadcastId);
  console.log(`[broadcast] runtime stopped: ${broadcastId}`);
}

export function stopAllRuntimes(): void {
  for (const id of Array.from(runtimes.keys())) {
    stopRuntime(id);
  }
}

export async function transitionStatus(
  broadcastId: string,
  nextStatus: BroadcastStatus,
): Promise<{ ok: true; config: BroadcastWithConfig } | { ok: false; error: string; code: number }> {
  const config = await getBroadcastWithConfig(broadcastId);
  if (!config) return { ok: false, error: "Broadcast not found", code: 404 };

  const current = config.broadcast.status;

  if (current === nextStatus) {
    return { ok: true, config };
  }

  if (nextStatus === "active") {
    const missing = await missingAmbientContent(config.sources);
    if (missing.length > 0) {
      return {
        ok: false,
        error: `Cannot activate: ${missing.join(" and ")} must have at least one non-empty entry`,
        code: 422,
      };
    }
  }

  const updated = await updateBroadcast(broadcastId, { status: nextStatus });
  if (!updated) return { ok: false, error: "Broadcast not found", code: 404 };

  const newConfig: BroadcastWithConfig = { ...config, broadcast: updated };

  if (nextStatus === "active") {
    await startRuntime(newConfig);
  } else if (current === "active") {
    stopRuntime(broadcastId);
  }

  return { ok: true, config: newConfig };
}

/**
 * Returns the ambient source types that don't have at least one entry
 * with non-empty `data.content`. Every broadcast must carry a voice and
 * a context brief before activation — the generator relies on both and
 * there is no fallback.
 */
async function missingAmbientContent(sources: SourceRow[]): Promise<string[]> {
  const required: SourceType[] = ["narrative_voice", "narrative_context"];
  const relevant = sources.filter((s) => required.includes(s.type));
  const byType = new Map<SourceType, SourceRow[]>();
  for (const source of relevant) {
    const list = byType.get(source.type) ?? [];
    list.push(source);
    byType.set(source.type, list);
  }

  const missing: string[] = [];
  for (const type of required) {
    const matching = byType.get(type) ?? [];
    if (matching.length === 0) {
      missing.push(type);
      continue;
    }
    const rows = await db
      .select({ data: feedEntries.data })
      .from(feedEntries)
      .where(inArray(feedEntries.sourceId, matching.map((s) => s.id)));
    const hasContent = rows.some((r) => {
      const content = (r.data as { content?: unknown }).content;
      return typeof content === "string" && content.trim().length > 0;
    });
    if (!hasContent) missing.push(type);
  }
  return missing;
}
