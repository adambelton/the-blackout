import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { generations } from "../db/schema.js";
import { ensureRuntime } from "../broadcast.js";

const narrative = new Hono();

/**
 * Off-schedule generation trigger. Routes through the same enrich →
 * curate → generate path as a cadence cycle, with curation as the sole
 * authority on selection — the body's `consumerPrompt` is spliced into
 * the generator's user message. The legacy moderator-override path
 * (`generateNow`, which bypassed curation) was retired 2026-04-26.
 */
narrative.post("/broadcasts/:broadcastId/narrative/generate", async (c) => {
  const { broadcastId } = c.req.param();
  const runtime = await ensureRuntime(broadcastId);
  if (!runtime) return c.json({ error: "Broadcast is not active" }, 409);

  // Off-schedule cycle. Body must carry a non-empty `consumerPrompt`
  // string — the opaque preamble text the consumer wants spliced into
  // the LLM user message for this cycle. Flushes the pipeline through
  // enrich → curate → generate, with curation as the sole authority
  // on selection. The earlier body-less moderator-override path
  // (`generateNow`, which bypassed curation) was retired 2026-04-26;
  // the closing-passage regression during the FA Cup SF traced to it.
  const body = await c.req.json().catch(() => ({}));
  const rawPrompt = (body as { consumerPrompt?: unknown }).consumerPrompt;
  const consumerPrompt = typeof rawPrompt === "string" && rawPrompt.length > 0 ? rawPrompt : undefined;
  if (!consumerPrompt) {
    return c.json(
      { error: "consumerPrompt (non-empty string) is required" },
      400,
    );
  }

  const enriched = await runtime.pipeline.flush({ consumerPrompt });
  if (!enriched) return c.json({ message: "No new feed entries to narrate" }, 200);
  // pipeline.flush returns the enriched payload; the narrative is
  // emitted via the curator's onCurated handler (which the engine
  // wired in `broadcast.ts`). The HTTP response is just confirmation
  // the cycle ran — the caller typically waits for the WS narrative
  // cue rather than the body.
  return c.json({ enriched: true, entryCount: enriched.entries.length });
});

narrative.get("/broadcasts/:broadcastId/generations", async (c) => {
  const { broadcastId } = c.req.param();
  const rows = await db
    .select()
    .from(generations)
    .where(eq(generations.broadcastId, broadcastId))
    .orderBy(desc(generations.triggeredAt));

  return c.json({ generations: rows });
});

narrative.get("/broadcasts/:broadcastId/generations/:generationId", async (c) => {
  const { generationId } = c.req.param();
  const row = await db.query.generations.findFirst({
    where: eq(generations.id, generationId),
  });
  if (!row) return c.json({ error: "Generation not found" }, 404);
  return c.json(row);
});

export { narrative as narrativeRoutes };
