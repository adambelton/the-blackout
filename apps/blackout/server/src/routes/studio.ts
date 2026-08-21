import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { broadcastIllustrations } from "../db/schema.js";
import { getStorage } from "../lib/storage/index.js";
import { getBroadcast } from "../lib/broadcasts.js";
import {
  createPoolItem as kairosCreatePoolItem,
  deletePoolItem as kairosDeletePoolItem,
  listPoolItems as kairosListPoolItems,
  updatePoolItem as kairosUpdatePoolItem,
  type KairosPoolItem,
} from "../lib/kairos.js";
import { generateImage } from "../lib/replicate.js";
import { suggestPrompts } from "../lib/prompt-suggester.js";
import { deriveTags } from "../lib/tag-deriver.js";
import {
  deleteIllustration,
  getIllustration,
  insertIllustration,
  listDiscardedPrompts,
  recordDiscardedPrompt,
  type IllustrationRow,
} from "../lib/illustration-pool.js";
import { requireRole } from "../lib/auth-middleware.js";

export const studioRoutes = new Hono();

// ---------------------------------------------------------------------------
// Studio — illustration pool prep (Kairos-authoritative)
// ---------------------------------------------------------------------------
//
// Kairos owns pool membership (prompt + tags + consumer_metadata) so
// that its imagery selector can reason over the pool at cycle time
// without crossing a module boundary. Blackout owns the image bytes,
// R2 storage, and the local `broadcast_illustrations` record — the
// pool item's `consumer_metadata.illustrationId` is the pointer
// Blackout uses to resolve bytes when Kairos hands back a `pool`
// decision.
//
// Flow:
//  1. Prompt suggestion (Haiku via Blackout — football-specific).
//  2. Generate an image — Replicate, R2, Blackout row. Not in pool yet.
//  3. Accept — derive tags (Haiku), POST the pool item to Kairos with
//     consumer_metadata.illustrationId = the Blackout row id.
//  4. Discard (pre-accept) — delete Blackout row + R2; record the
//     prompt in Blackout's discarded-prompts ledger for the next
//     suggestion call.
//  5. Remove from pool (post-accept) — delete the Kairos pool item
//     AND the Blackout row + R2.

// Every studio endpoint triggers a paid API call (Haiku or Replicate).
// Writer + admin only.
studioRoutes.use("/broadcasts/:id/studio/*", requireRole("writer", "admin"));

interface StudioGeneratedIllustration {
  id: string;
  broadcastId: string;
  prompt: string;
  imageUrl: string | null;
  model: string;
  generatedAt: string;
  generationMs: number;
}

interface StudioPoolItem {
  poolItemId: string;
  illustrationId: string | null;
  prompt: string;
  tags: string[];
  imageUrl: string | null;
  createdAt: number;
}

async function resolveImageUrlByKey(imageKey: string): Promise<string | null> {
  if (!imageKey) return null;
  try {
    return await getStorage().getPublicUrl(imageKey);
  } catch {
    return null;
  }
}

async function shapeGeneratedRow(
  row: IllustrationRow,
): Promise<StudioGeneratedIllustration> {
  return {
    id: row.id,
    broadcastId: row.broadcastId,
    prompt: row.prompt,
    model: row.model,
    generatedAt: row.generatedAt,
    generationMs: row.generationMs,
    imageUrl: await resolveImageUrlByKey(row.imageKey),
  };
}

function readIllustrationId(
  metadata: Record<string, unknown> | null,
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const id = (metadata as { illustrationId?: unknown }).illustrationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

async function shapePoolItem(
  item: KairosPoolItem,
): Promise<StudioPoolItem> {
  const illustrationId = readIllustrationId(item.consumerMetadata);
  let imageUrl: string | null = null;
  if (illustrationId) {
    const row = await getIllustration(illustrationId);
    if (row?.imageKey) imageUrl = await resolveImageUrlByKey(row.imageKey);
  }
  return {
    poolItemId: item.id,
    illustrationId,
    prompt: item.prompt,
    tags: item.tags ?? [],
    imageUrl,
    createdAt: item.createdAt,
  };
}

studioRoutes.get("/broadcasts/:id/studio/pool", async (c) => {
  const id = c.req.param("id");
  const broadcast = await getBroadcast(id);
  if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);

  try {
    const items = await kairosListPoolItems(broadcast.kairosBroadcastId ?? id);
    const enriched = await Promise.all(items.map(shapePoolItem));
    return c.json({ items: enriched });
  } catch (err) {
    return c.json(
      { error: (err as Error).message || "pool fetch failed" },
      502,
    );
  }
});

studioRoutes.post("/broadcasts/:id/studio/prompts/suggest", async (c) => {
  const id = c.req.param("id");
  const broadcast = await getBroadcast(id);
  if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);

  const body = await c.req
    .json<{ count?: number }>()
    .catch(() => ({}) as { count?: number });
  const count = Math.max(1, Math.min(50, body.count ?? 25));

  const matchBrief = broadcast.matchBrief?.trim();
  if (!matchBrief) {
    return c.json(
      { error: "Match brief is empty — set one before suggesting prompts" },
      400,
    );
  }

  const kairosId = broadcast.kairosBroadcastId;
  const [poolItems, discarded] = await Promise.all([
    kairosId
      ? kairosListPoolItems(kairosId).catch(() => [] as KairosPoolItem[])
      : Promise.resolve([] as KairosPoolItem[]),
    listDiscardedPrompts(id),
  ]);
  const accepted = poolItems.map((p) => p.prompt);

  try {
    const result = await suggestPrompts({
      matchBrief,
      accepted,
      discarded,
      count,
    });
    return c.json({ prompts: result.prompts, usage: result.usage });
  } catch (err) {
    return c.json(
      { error: (err as Error).message || "suggest failed" },
      500,
    );
  }
});

studioRoutes.post("/broadcasts/:id/studio/prompts/discard", async (c) => {
  const id = c.req.param("id");
  const broadcast = await getBroadcast(id);
  if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);

  const body = await c.req.json<{ prompt?: string }>();
  const prompt = body.prompt?.trim();
  if (!prompt) return c.json({ error: "prompt is required" }, 400);

  await recordDiscardedPrompt(id, prompt);
  return c.json({ ok: true });
});

studioRoutes.post(
  "/broadcasts/:id/studio/illustrations/generate",
  async (c) => {
    const id = c.req.param("id");
    const broadcast = await getBroadcast(id);
    if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);

    const body = await c.req.json<{ prompt?: string }>();
    const prompt = body.prompt?.trim();
    if (!prompt) return c.json({ error: "prompt is required" }, 400);

    try {
      const image = await generateImage(prompt);
      // Insert with an empty imageKey then patch after the R2 put — the
      // row id is needed to compose the storage key.
      const row = await insertIllustration({
        broadcastId: id,
        prompt,
        imageKey: "",
        contentType: image.contentType,
        model: image.model,
        generationMs: image.generationMs,
      });
      const imageKey = `broadcasts/${id}/illustrations/${row.id}.webp`;
      await getStorage().put(imageKey, image.bytes, image.contentType);
      await db
        .update(broadcastIllustrations)
        .set({ imageKey })
        .where(eq(broadcastIllustrations.id, row.id));

      return c.json(await shapeGeneratedRow({ ...row, imageKey }));
    } catch (err) {
      return c.json(
        { error: (err as Error).message || "generation failed" },
        500,
      );
    }
  },
);

studioRoutes.post(
  "/broadcasts/:id/studio/illustrations/:illustrationId/accept",
  async (c) => {
    const id = c.req.param("id");
    const illustrationId = c.req.param("illustrationId");
    const broadcast = await getBroadcast(id);
    if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);
    if (!broadcast.kairosBroadcastId) {
      return c.json({ error: "Broadcast not linked to Kairos" }, 409);
    }

    const existing = await getIllustration(illustrationId);
    if (!existing || existing.broadcastId !== id) {
      return c.json({ error: "Illustration not found" }, 404);
    }

    const body = await c.req
      .json<{ tags?: string[] }>()
      .catch(() => ({ tags: undefined as string[] | undefined }));
    const explicitTags = Array.isArray(body.tags)
      ? body.tags.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0)
      : null;

    let tags: string[];
    if (explicitTags && explicitTags.length > 0) {
      tags = explicitTags;
    } else {
      try {
        tags = await deriveTags(existing.prompt);
      } catch (err) {
        console.warn(
          `[studio] tag derivation failed for ${illustrationId}: ${(err as Error).message}`,
        );
        tags = [];
      }
    }

    try {
      const poolItem = await kairosCreatePoolItem(broadcast.kairosBroadcastId, {
        prompt: existing.prompt,
        tags,
        consumerMetadata: { illustrationId: existing.id },
      });
      return c.json(await shapePoolItem(poolItem));
    } catch (err) {
      return c.json(
        { error: (err as Error).message || "pool accept failed" },
        502,
      );
    }
  },
);

studioRoutes.post(
  "/broadcasts/:id/studio/illustrations/:illustrationId/discard",
  async (c) => {
    const id = c.req.param("id");
    const illustrationId = c.req.param("illustrationId");
    const broadcast = await getBroadcast(id);
    if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);

    const existing = await getIllustration(illustrationId);
    if (!existing || existing.broadcastId !== id) {
      return c.json({ error: "Illustration not found" }, 404);
    }

    await recordDiscardedPrompt(id, existing.prompt);
    await deleteIllustration(illustrationId);
    if (existing.imageKey) {
      await getStorage()
        .delete(existing.imageKey)
        .catch((err) =>
          console.warn(
            `[studio] failed to delete R2 object ${existing.imageKey}: ${(err as Error).message}`,
          ),
        );
    }
    return c.json({ ok: true });
  },
);

studioRoutes.patch(
  "/broadcasts/:id/studio/pool/:poolItemId",
  async (c) => {
    const id = c.req.param("id");
    const poolItemId = c.req.param("poolItemId");
    const broadcast = await getBroadcast(id);
    if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);
    if (!broadcast.kairosBroadcastId) {
      return c.json({ error: "Broadcast not linked to Kairos" }, 409);
    }

    const body = await c.req
      .json<{ tags?: unknown }>()
      .catch(() => ({ tags: undefined as unknown }));
    if (!Array.isArray(body.tags)) {
      return c.json({ error: "tags must be an array of strings" }, 400);
    }
    const tags = body.tags
      .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
      .filter((t) => t.length > 0);

    try {
      const updated = await kairosUpdatePoolItem(
        broadcast.kairosBroadcastId,
        poolItemId,
        { tags },
      );
      return c.json(await shapePoolItem(updated));
    } catch (err) {
      return c.json(
        { error: (err as Error).message || "pool update failed" },
        502,
      );
    }
  },
);

studioRoutes.delete(
  "/broadcasts/:id/studio/pool/:poolItemId",
  async (c) => {
    const id = c.req.param("id");
    const poolItemId = c.req.param("poolItemId");
    const broadcast = await getBroadcast(id);
    if (!broadcast) return c.json({ error: "Broadcast not found" }, 404);
    if (!broadcast.kairosBroadcastId) {
      return c.json({ error: "Broadcast not linked to Kairos" }, 409);
    }

    // Resolve the Blackout-side illustrationId before we delete the
    // Kairos pool item — the consumer_metadata is our only pointer to
    // the local row + R2 object.
    let items: KairosPoolItem[] = [];
    try {
      items = await kairosListPoolItems(broadcast.kairosBroadcastId);
    } catch (err) {
      return c.json(
        { error: (err as Error).message || "pool lookup failed" },
        502,
      );
    }
    const item = items.find((i) => i.id === poolItemId);
    if (!item) {
      return c.json({ error: "Pool item not found" }, 404);
    }
    const illustrationId = readIllustrationId(item.consumerMetadata);

    try {
      await kairosDeletePoolItem(broadcast.kairosBroadcastId, poolItemId);
    } catch (err) {
      return c.json(
        { error: (err as Error).message || "pool delete failed" },
        502,
      );
    }

    if (illustrationId) {
      const row = await getIllustration(illustrationId);
      await deleteIllustration(illustrationId);
      if (row?.imageKey) {
        await getStorage()
          .delete(row.imageKey)
          .catch((err) =>
            console.warn(
              `[studio] failed to delete R2 object ${row.imageKey}: ${(err as Error).message}`,
            ),
          );
      }
    }

    return c.json({ ok: true });
  },
);
