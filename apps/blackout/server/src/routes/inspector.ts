import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { broadcastIllustrations, broadcastNarrations } from "../db/schema.js";
import { getStorage } from "../lib/storage/index.js";
import { getBroadcast } from "../lib/broadcasts.js";
import {
  listCycles,
  getCycle,
  getBroadcastHealth,
  getGeneration,
  listBroadcastEntries,
} from "../lib/kairos.js";
import { requireRole } from "../lib/auth-middleware.js";

export const inspectorRoutes = new Hono();

// ---------------------------------------------------------------------------
// Pipeline inspector — admin debug surface for completed broadcasts
// ---------------------------------------------------------------------------
//
// The inspector UI lives in the Blackout web app. Cycle + generation data
// lives on the Kairos side. These routes resolve the Blackout broadcast id
// to its Kairos broadcast id, then delegate to Kairos. The web never talks
// to Kairos directly — preserves the module boundary.

// Inspector (completed-broadcast debug surface) is admin-only.
inspectorRoutes.use("/broadcasts/:id/cycles", requireRole("admin"));
inspectorRoutes.use("/broadcasts/:id/cycles/*", requireRole("admin"));
inspectorRoutes.use("/broadcasts/:id/generations/*", requireRole("admin"));
inspectorRoutes.use("/broadcasts/:id/health", requireRole("admin"));
inspectorRoutes.use("/broadcasts/:id/narratives/*", requireRole("admin"));
inspectorRoutes.use("/broadcasts/:id/entries", requireRole("admin"));

async function resolveKairosId(id: string): Promise<string | null> {
  const broadcast = await getBroadcast(id);
  return broadcast?.kairosBroadcastId ?? null;
}

inspectorRoutes.get("/broadcasts/:id/cycles", async (c) => {
  const kairosId = await resolveKairosId(c.req.param("id"));
  if (!kairosId) return c.json({ error: "Broadcast not linked to Kairos" }, 404);
  const limit = parseInt(c.req.query("limit") ?? "200", 10);
  try {
    const cycles = await listCycles(kairosId, limit);
    return c.json({ cycles });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

inspectorRoutes.get("/broadcasts/:id/cycles/:cycleId", async (c) => {
  const kairosId = await resolveKairosId(c.req.param("id"));
  if (!kairosId) return c.json({ error: "Broadcast not linked to Kairos" }, 404);
  try {
    const detail = await getCycle(kairosId, c.req.param("cycleId"));
    return c.json(detail);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

inspectorRoutes.get("/broadcasts/:id/health", async (c) => {
  const kairosId = await resolveKairosId(c.req.param("id"));
  if (!kairosId) return c.json({ error: "Broadcast not linked to Kairos" }, 404);
  try {
    const health = await getBroadcastHealth(kairosId);
    return c.json(health);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

inspectorRoutes.get("/broadcasts/:id/generations/:generationId", async (c) => {
  const kairosId = await resolveKairosId(c.req.param("id"));
  if (!kairosId) return c.json({ error: "Broadcast not linked to Kairos" }, 404);
  try {
    const generation = await getGeneration(kairosId, c.req.param("generationId"));
    return c.json(generation);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});

/**
 * Illustration + narration media for a single generation — used by the
 * pipeline inspector to show the image that accompanied a passage and
 * play back the TTS audio for solo review. Either or both can be
 * missing: a generation that pre-dated illustrations has no image row,
 * and a generation whose TTS was skipped (rate-limit, kill switch) has
 * no narration row. The client degrades accordingly.
 */
inspectorRoutes.get(
  "/broadcasts/:id/narratives/:narrativeId/media",
  async (c) => {
    const broadcastId = c.req.param("id");
    const narrativeId = c.req.param("narrativeId");

    const [illustration] = await db
      .select()
      .from(broadcastIllustrations)
      .where(
        and(
          eq(broadcastIllustrations.broadcastId, broadcastId),
          eq(broadcastIllustrations.narrativeId, narrativeId),
        ),
      )
      .orderBy(desc(broadcastIllustrations.generatedAt))
      .limit(1);

    const [narration] = await db
      .select()
      .from(broadcastNarrations)
      .where(
        and(
          eq(broadcastNarrations.broadcastId, broadcastId),
          eq(broadcastNarrations.narrativeId, narrativeId),
        ),
      )
      .orderBy(desc(broadcastNarrations.synthesizedAt))
      .limit(1);

    const storage = getStorage();
    const imageUrl = illustration
      ? await storage.getPublicUrl(illustration.imageKey).catch(() => null)
      : null;
    const audioUrl = narration
      ? await storage.getPublicUrl(narration.audioKey).catch(() => null)
      : null;

    return c.json({
      illustration: illustration
        ? {
            id: illustration.id,
            imageUrl,
            prompt: illustration.prompt,
            model: illustration.model,
            generationMs: illustration.generationMs,
          }
        : null,
      narration: narration
        ? {
            id: narration.id,
            audioUrl,
            durationMs: narration.durationMs,
            voiceId: narration.voiceId,
            provider: narration.provider,
          }
        : null,
    });
  },
);

/**
 * Inspector header needs the narrative_voice and narrative_context
 * ambient entries to show what the broadcast was configured with. This
 * is a thin wrapper — callers pass `?source=narrative_voice` etc.
 */
inspectorRoutes.get("/broadcasts/:id/entries", async (c) => {
  const kairosId = await resolveKairosId(c.req.param("id"));
  if (!kairosId) return c.json({ error: "Broadcast not linked to Kairos" }, 404);
  try {
    const source = c.req.query("source");
    const entries = await listBroadcastEntries(kairosId, source ? { source } : {});
    return c.json({ entries });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 502);
  }
});
