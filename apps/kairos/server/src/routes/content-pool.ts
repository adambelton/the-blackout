import { Hono } from "hono";
import { getBroadcastWithConfig } from "../db/broadcasts.js";
import {
  deletePoolItem,
  getPoolItem,
  insertPoolItem,
  listPoolItems,
  updatePoolItem,
} from "../db/content-pool.js";

/**
 * Content pool endpoints.
 *
 * Consumer (e.g. The Blackout's content studio) pushes prepared items
 * here as writers accept them. At cycle time, Kairos's imagery
 * selector reads from the pool and decides whether to pick one or
 * write a fresh-generate decision.
 *
 * Domain-agnostic: each item is `{ prompt, tags, consumer_metadata }`.
 * The consumer_metadata JSONB is opaque to Kairos — the consumer
 * uses it to store whatever pointer it needs (e.g. a local
 * illustration record id).
 */
export const poolRoutes = new Hono();

async function assertBroadcast(id: string): Promise<boolean> {
  const broadcast = await getBroadcastWithConfig(id);
  return broadcast != null;
}

poolRoutes.get("/broadcasts/:id/pool", async (c) => {
  const id = c.req.param("id");
  if (!(await assertBroadcast(id))) {
    return c.json({ error: "Broadcast not found" }, 404);
  }
  const items = await listPoolItems(id);
  return c.json({ items });
});

poolRoutes.post("/broadcasts/:id/pool", async (c) => {
  const id = c.req.param("id");
  if (!(await assertBroadcast(id))) {
    return c.json({ error: "Broadcast not found" }, 404);
  }

  const body = await c.req.json<{
    prompt?: string;
    tags?: string[];
    consumer_metadata?: Record<string, unknown>;
  }>();

  const prompt = body.prompt?.trim();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  const tags = Array.isArray(body.tags)
    ? body.tags
        .filter((t): t is string => typeof t === "string")
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];

  const item = await insertPoolItem({
    broadcastId: id,
    prompt,
    tags,
    consumerMetadata: body.consumer_metadata ?? null,
  });
  return c.json(item, 201);
});

poolRoutes.patch("/broadcasts/:id/pool/:itemId", async (c) => {
  const id = c.req.param("id");
  const itemId = c.req.param("itemId");
  const existing = await getPoolItem(itemId);
  if (!existing || existing.broadcastId !== id) {
    return c.json({ error: "Pool item not found" }, 404);
  }

  const body = await c.req.json<{
    tags?: string[];
    consumer_metadata?: Record<string, unknown> | null;
  }>();
  const updates: {
    tags?: string[];
    consumerMetadata?: Record<string, unknown> | null;
  } = {};
  if (Array.isArray(body.tags)) {
    updates.tags = body.tags
      .filter((t): t is string => typeof t === "string")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }
  if (body.consumer_metadata !== undefined) {
    updates.consumerMetadata = body.consumer_metadata;
  }

  const updated = await updatePoolItem(itemId, updates);
  if (!updated) return c.json({ error: "Failed to update" }, 500);
  return c.json(updated);
});

poolRoutes.delete("/broadcasts/:id/pool/:itemId", async (c) => {
  const id = c.req.param("id");
  const itemId = c.req.param("itemId");
  const existing = await getPoolItem(itemId);
  if (!existing || existing.broadcastId !== id) {
    return c.json({ error: "Pool item not found" }, 404);
  }
  await deletePoolItem(itemId);
  return c.json({ ok: true });
});
