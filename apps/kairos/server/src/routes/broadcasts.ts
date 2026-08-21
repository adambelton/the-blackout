import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { feedEntries, generations, pipelineCycles, sources as sourcesTable } from "../db/schema.js";
import { computeBroadcastHealth, computeCycleDrift } from "../broadcast-health.js";
import { Feed } from "../feed.js";
import {
  createBroadcastRow,
  getBroadcastWithConfig,
  listBroadcasts,
  updateBroadcast,
  deleteBroadcast,
  type SourceInsert,
} from "../db/broadcasts.js";
import { ensureRuntime, stopRuntime, transitionStatus } from "../broadcast.js";
import type { BroadcastStatus, SourceType } from "../db/enums.js";
import { isBroadcastStatus } from "../db/enums.js";
import { PACING_SIGNALS, isPacingSignal, type PacingSignal } from "../curation/types.js";

const broadcastRoutes = new Hono();

function validateSourceInput(
  s: { type: SourceType; enrichmentTags?: string[] | null; canonical?: boolean | null },
): string | null {
  if (s.enrichmentTags?.length && s.type !== "event") {
    return `enrichment_tags only allowed on event sources (got ${s.type})`;
  }
  if (s.canonical && s.type !== "event" && s.type !== "moderator") {
    return `canonical only allowed on event and moderator sources (got ${s.type})`;
  }
  return null;
}

broadcastRoutes.post("/broadcasts", async (c) => {
  const body = await c.req.json<{
    event_profile?: string;
    eventProfile?: string;
    config?: Record<string, unknown>;
    spec_overrides?: Record<string, { version: string }>;
    specOverrides?: Record<string, { version: string }>;
    sources?: Array<{
      name: string;
      type: SourceType;
      canonical?: boolean;
      enrichment_tags?: string[];
      enrichmentTags?: string[];
      config?: Record<string, unknown>;
    }>;
  }>();

  const eventProfileName = body.event_profile ?? body.eventProfile;
  if (!eventProfileName) {
    return c.json({ error: "event_profile is required" }, 400);
  }
  const specOverrides = body.spec_overrides ?? body.specOverrides;

  const sourceInputs: SourceInsert[] = (body.sources ?? []).map((s) => ({
    name: s.name,
    type: s.type,
    canonical: s.canonical ?? false,
    enrichmentTags: s.enrichment_tags ?? s.enrichmentTags ?? [],
    config: s.config ?? {},
  }));

  for (const s of sourceInputs) {
    const err = validateSourceInput({
      type: s.type as SourceType,
      enrichmentTags: s.enrichmentTags as string[] | null | undefined,
      canonical: s.canonical,
    });
    if (err) return c.json({ error: err }, 422);
  }

  try {
    const result = await createBroadcastRow({
      eventProfileName,
      specOverrides,
      config: body.config,
      sources: sourceInputs,
    });
    return c.json(result, 201);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

broadcastRoutes.get("/broadcasts", async (c) => {
  const rows = await listBroadcasts();
  return c.json({ broadcasts: rows });
});

broadcastRoutes.get("/broadcasts/:broadcastId", async (c) => {
  const { broadcastId } = c.req.param();
  const config = await getBroadcastWithConfig(broadcastId);
  if (!config) return c.json({ error: "Broadcast not found" }, 404);
  return c.json(config);
});

broadcastRoutes.patch("/broadcasts/:broadcastId", async (c) => {
  const { broadcastId } = c.req.param();
  const body = await c.req.json<{
    status?: BroadcastStatus;
    config?: Record<string, unknown>;
    spec_overrides?: Record<string, { version: string }>;
    specOverrides?: Record<string, { version: string }>;
  }>();

  if (body.status !== undefined && !isBroadcastStatus(body.status)) {
    return c.json({ error: `status must be one of pending, active, paused, complete` }, 400);
  }

  if (body.status) {
    const result = await transitionStatus(broadcastId, body.status);
    if (!result.ok) return c.json({ error: result.error }, result.code as 404 | 422);

    if (body.config || body.spec_overrides || body.specOverrides) {
      await updateBroadcast(broadcastId, {
        config: body.config,
        specOverrides: body.spec_overrides ?? body.specOverrides,
      });
    }

    const fresh = await getBroadcastWithConfig(broadcastId);
    return c.json(fresh);
  }

  const updated = await updateBroadcast(broadcastId, {
    config: body.config,
    specOverrides: body.spec_overrides ?? body.specOverrides,
  });
  if (!updated) return c.json({ error: "Broadcast not found" }, 404);

  const fresh = await getBroadcastWithConfig(broadcastId);
  return c.json(fresh);
});

broadcastRoutes.delete("/broadcasts/:broadcastId", async (c) => {
  const { broadcastId } = c.req.param();
  stopRuntime(broadcastId);
  const deleted = await deleteBroadcast(broadcastId);
  if (!deleted) return c.json({ error: "Broadcast not found" }, 404);
  return c.json({ broadcastId, status: "deleted" });
});

// --- Source management ---

broadcastRoutes.post("/broadcasts/:broadcastId/sources", async (c) => {
  const { broadcastId } = c.req.param();
  const body = await c.req.json<{
    name: string;
    type: SourceType;
    canonical?: boolean;
    enrichment_tags?: string[];
    enrichmentTags?: string[];
    config?: Record<string, unknown>;
  }>();

  const config = await getBroadcastWithConfig(broadcastId);
  if (!config) return c.json({ error: "Broadcast not found" }, 404);

  const err = validateSourceInput({
    type: body.type,
    enrichmentTags: body.enrichment_tags ?? body.enrichmentTags ?? null,
    canonical: body.canonical ?? null,
  });
  if (err) return c.json({ error: err }, 422);

  const [row] = await db
    .insert(sourcesTable)
    .values({
      broadcastId,
      name: body.name,
      type: body.type,
      canonical: body.canonical ?? false,
      enrichmentTags: body.enrichment_tags ?? body.enrichmentTags ?? [],
      config: body.config ?? {},
    })
    .returning();

  return c.json(row, 201);
});

broadcastRoutes.get("/broadcasts/:broadcastId/sources", async (c) => {
  const { broadcastId } = c.req.param();
  const rows = await db.select().from(sourcesTable).where(eq(sourcesTable.broadcastId, broadcastId));
  return c.json({ sources: rows });
});

broadcastRoutes.patch("/broadcasts/:broadcastId/sources/:sourceId", async (c) => {
  const { sourceId } = c.req.param();
  const body = await c.req.json<{
    canonical?: boolean;
    enrichment_tags?: string[];
    enrichmentTags?: string[];
    config?: Record<string, unknown>;
  }>();

  const existing = await db.query.sources.findFirst({ where: eq(sourcesTable.id, sourceId) });
  if (!existing) return c.json({ error: "Source not found" }, 404);

  const next = {
    canonical: body.canonical ?? existing.canonical,
    enrichmentTags: body.enrichment_tags ?? body.enrichmentTags ?? (existing.enrichmentTags as string[] | null),
    config: body.config ?? (existing.config as Record<string, unknown>),
  };

  const err = validateSourceInput({
    type: existing.type,
    enrichmentTags: next.enrichmentTags,
    canonical: next.canonical,
  });
  if (err) return c.json({ error: err }, 422);

  const [row] = await db
    .update(sourcesTable)
    .set(next)
    .where(eq(sourcesTable.id, sourceId))
    .returning();

  return c.json(row);
});

broadcastRoutes.delete("/broadcasts/:broadcastId/sources/:sourceId", async (c) => {
  const { sourceId } = c.req.param();
  const result = await db
    .delete(sourcesTable)
    .where(eq(sourcesTable.id, sourceId))
    .returning({ id: sourcesTable.id });
  if (result.length === 0) return c.json({ error: "Source not found" }, 404);
  return c.json({ sourceId, status: "deleted" });
});

// --- Feed entries ---

broadcastRoutes.post("/broadcasts/:broadcastId/entries", async (c) => {
  const { broadcastId } = c.req.param();

  const body = await c.req.json<{
    source: string;
    data: Record<string, unknown>;
    timestamp?: number;
  }>();

  if (!body.source || !body.data) {
    return c.json({ error: "source and data are required" }, 400);
  }

  const config = await getBroadcastWithConfig(broadcastId);
  if (!config) return c.json({ error: "Broadcast not found" }, 404);

  const source = await db.query.sources.findFirst({
    where: and(eq(sourcesTable.broadcastId, broadcastId), eq(sourcesTable.name, body.source)),
  });
  if (!source) return c.json({ error: `Source "${body.source}" not found on this broadcast` }, 404);

  const isAmbient = source.type === "narrative_voice" || source.type === "narrative_context";
  const status = config.broadcast.status;

  if (status === "active") {
    const runtime = await ensureRuntime(broadcastId);
    if (!runtime) return c.json({ error: "Broadcast runtime unavailable" }, 500);
    const entry = await runtime.feed.push(source, body.data, body.timestamp);
    return c.json(entry, 201);
  }

  if (status === "pending" && isAmbient) {
    // Voice and context must be seeded before activation so the gate
    // can confirm non-empty content. No runtime exists yet — persist
    // directly; hydration will pick these up on activation.
    const [row] = await db
      .insert(feedEntries)
      .values({
        broadcastId,
        sourceId: source.id,
        data: body.data,
        enrichmentTags: (source.enrichmentTags ?? []) as string[],
        ...(body.timestamp ? { timestamp: new Date(body.timestamp) } : {}),
      })
      .returning();
    return c.json(
      {
        id: row.id,
        broadcastId: row.broadcastId,
        sourceId: row.sourceId,
        sourceName: source.name,
        sourceType: source.type,
        timestamp: row.timestamp.getTime(),
        data: row.data,
        enrichmentTags: (row.enrichmentTags ?? []) as string[],
      },
      201,
    );
  }

  if (status === "pending") {
    return c.json({ error: "Only narrative_voice and narrative_context entries can be pushed to a pending broadcast" }, 409);
  }
  return c.json({ error: `Broadcast is ${status}` }, 409);
});

broadcastRoutes.get("/broadcasts/:broadcastId/entries", async (c) => {
  const { broadcastId } = c.req.param();

  const config = await getBroadcastWithConfig(broadcastId);
  if (!config) return c.json({ error: "Broadcast not found" }, 404);

  const feed = new Feed(broadcastId);
  const sourceName = c.req.query("source") ?? undefined;
  const tag = c.req.query("tag") ?? undefined;
  const from = c.req.query("from");
  const to = c.req.query("to");

  const entries = await feed.query({
    sourceName,
    tag,
    fromTimestamp: from ? parseInt(from, 10) : undefined,
    toTimestamp: to ? parseInt(to, 10) : undefined,
  });

  return c.json({ entries });
});

// --- Pipeline cycles (inspector support) ---

broadcastRoutes.get("/broadcasts/:broadcastId/cycles", async (c) => {
  const { broadcastId } = c.req.param();
  const limit = Math.min(parseInt(c.req.query("limit") ?? "200", 10), 500);

  // Pull the columns the list view needs PLUS the ones the inspector
  // scrub strip needs to compute per-cycle drift (chunk_entries +
  // curation for the within-cycle content span and pacing-derived
  // WPM; flush_trigger for the visual marker). The scrub strip
  // would otherwise force a per-cycle round-trip for every row.
  const rows = await db
    .select({
      id: pipelineCycles.id,
      triggeredAt: pipelineCycles.triggeredAt,
      triggerReason: pipelineCycles.triggerReason,
      flushTrigger: pipelineCycles.flushTrigger,
      generationId: pipelineCycles.generationId,
      chunkEntries: pipelineCycles.chunkEntries,
      annotations: pipelineCycles.annotations,
      curation: pipelineCycles.curation,
    })
    .from(pipelineCycles)
    .where(eq(pipelineCycles.broadcastId, broadcastId))
    .orderBy(desc(pipelineCycles.triggeredAt))
    .limit(limit);

  // Pull just wordCount for the matching generations — used by the
  // drift calculation for each cycle's prose-seconds figure.
  const generationIds = rows
    .map((r) => r.generationId)
    .filter((id): id is string => id !== null);
  const generationRows =
    generationIds.length > 0
      ? await db
          .select({ id: generations.id, wordCount: generations.wordCount })
          .from(generations)
          .where(inArray(generations.id, generationIds))
      : [];
  const wordCountById = new Map(generationRows.map((g) => [g.id, g.wordCount]));

  // Rows are newest-first; the previous cycle in wall-clock terms
  // is the row at index+1. Compute drift per row using that.
  const cycles = rows.map((r, idx) => {
    const prev = rows[idx + 1];
    const drift = computeCycleDrift({
      cycle: {
        chunkEntries: r.chunkEntries,
        curation: r.curation,
        generationId: r.generationId,
      },
      generation:
        r.generationId && wordCountById.has(r.generationId)
          ? { wordCount: wordCountById.get(r.generationId)! }
          : null,
      prevTriggeredAtMs: prev ? prev.triggeredAt.getTime() : null,
      thisTriggeredAtMs: r.triggeredAt.getTime(),
    });
    return {
      id: r.id,
      triggeredAt: r.triggeredAt.getTime(),
      triggerReason: r.triggerReason,
      flushTrigger: r.flushTrigger,
      generationId: r.generationId,
      entryCount: Array.isArray(r.chunkEntries) ? r.chunkEntries.length : 0,
      annotationCount: Array.isArray(r.annotations) ? r.annotations.length : 0,
      drift,
    };
  });

  return c.json({ cycles });
});

broadcastRoutes.get("/broadcasts/:broadcastId/cycles/:cycleId", async (c) => {
  const { broadcastId, cycleId } = c.req.param();
  const row = await db.query.pipelineCycles.findFirst({
    where: and(eq(pipelineCycles.broadcastId, broadcastId), eq(pipelineCycles.id, cycleId)),
  });
  if (!row) return c.json({ error: "Cycle not found" }, 404);

  return c.json({
    id: row.id,
    broadcastId: row.broadcastId,
    triggeredAt: row.triggeredAt.getTime(),
    triggerReason: row.triggerReason,
    flushTrigger: row.flushTrigger,
    chunkEntries: row.chunkEntries,
    annotations: row.annotations,
    curation: row.curation,
    timingMs: row.timingMs,
    generationId: row.generationId,
  });
});

// --- Flow-health summary (inspector header) ---
//
// Aggregates the four numbers that tell admins whether Kairos is
// keeping pace: wall-clock elapsed, content-time covered, prose
// produced (`wordCount × 60 / WPM`), and target prose
// (`recommendedWordCount × 60 / WPM`). Computed across every cycle
// + generation in the broadcast — heavy enough that the inspector
// polls (4s), not subscribes. See `broadcast-health.ts` for the
// arithmetic and the WPM-derivation rules.
broadcastRoutes.get("/broadcasts/:broadcastId/health", async (c) => {
  const { broadcastId } = c.req.param();
  const broadcast = await getBroadcastWithConfig(broadcastId);
  if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);

  const cycleRows = await db
    .select({
      triggeredAt: pipelineCycles.triggeredAt,
      chunkEntries: pipelineCycles.chunkEntries,
      curation: pipelineCycles.curation,
      generationId: pipelineCycles.generationId,
    })
    .from(pipelineCycles)
    .where(eq(pipelineCycles.broadcastId, broadcastId))
    .orderBy(pipelineCycles.triggeredAt);

  const generationRows = await db
    .select({
      id: generations.id,
      wordCount: generations.wordCount,
    })
    .from(generations)
    .where(eq(generations.broadcastId, broadcastId));

  const health = computeBroadcastHealth({
    broadcastStatus: broadcast.broadcast.status,
    cycles: cycleRows.map((r) => ({
      triggeredAt: r.triggeredAt.getTime(),
      chunkEntries: r.chunkEntries,
      curation: r.curation,
      generationId: r.generationId,
    })),
    generations: generationRows,
    nowMs: Date.now(),
  });

  return c.json(health);
});

broadcastRoutes.get("/broadcasts/:broadcastId/services", async (c) => {
  const { broadcastId } = c.req.param();
  const runtime = await ensureRuntime(broadcastId);
  if (!runtime) return c.json({ error: "Broadcast is not active" }, 409);
  return c.json({ services: runtime.pipeline.getSnapshots() });
});

broadcastRoutes.post("/broadcasts/:broadcastId/feedback", async (c) => {
  const { broadcastId } = c.req.param();
  const runtime = await ensureRuntime(broadcastId);
  if (!runtime) return c.json({ error: "Broadcast is not active" }, 409);

  const body = await c.req.json<{
    signal: PacingSignal;
    words_per_minute?: number;
    wordsPerMinute?: number;
  }>();

  if (!isPacingSignal(body.signal)) {
    return c.json({ error: `signal must be one of ${PACING_SIGNALS.join(", ")}` }, 400);
  }

  const wpm = body.words_per_minute ?? body.wordsPerMinute;
  if (typeof wpm !== "number" || wpm <= 0) {
    return c.json({ error: "words_per_minute must be a positive number" }, 400);
  }

  runtime.stateTracker.recordPacingSignal({
    signal: body.signal,
    wordsPerMinute: wpm,
    receivedAt: Date.now(),
  });

  const estimatedWpm = runtime.stateTracker.getEstimatedWpm();
  return c.json({
    status: "recorded",
    signal: body.signal,
    wordsPerMinute: wpm,
    estimatedWpm,
  });
});

broadcastRoutes.get("/broadcasts/:broadcastId/services/:serviceName", async (c) => {
  const { broadcastId, serviceName } = c.req.param();
  const runtime = await ensureRuntime(broadcastId);
  if (!runtime) return c.json({ error: "Broadcast is not active" }, 409);
  const snapshots = runtime.pipeline.getSnapshots();
  const service = snapshots.find((s) => s.name === serviceName);
  if (!service) return c.json({ error: `Service "${serviceName}" not found` }, 404);
  return c.json(service);
});

export { broadcastRoutes };
