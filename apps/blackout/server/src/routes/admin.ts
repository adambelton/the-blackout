import { Hono } from "hono";
import { requireRole } from "../lib/auth-middleware.js";
import { listUsers, setUserRole } from "../lib/users.js";
import {
  listTtsVoices,
  createTtsVoice,
  updateTtsVoice,
  deleteTtsVoice,
} from "../lib/tts-voices.js";
import { generate } from "../lib/tts/index.js";
import { TTS_PROVIDERS, type TtsProvider } from "../lib/tts/types.js";

export const adminRoutes = new Hono();

adminRoutes.use("/admin/*", requireRole("admin"));

adminRoutes.get("/admin/users", async (c) => {
  const users = await listUsers();
  return c.json(users);
});

adminRoutes.patch("/admin/users/:id/role", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ role: "admin" | "writer" | null }>();

  if (body.role !== "admin" && body.role !== "writer" && body.role !== null) {
    return c.json({ error: "role must be 'admin', 'writer', or null" }, 400);
  }

  const user = await setUserRole(id, body.role);
  if (!user) return c.json({ error: "Not found" }, 404);
  return c.json(user);
});

// --- TTS voice catalogue (admin CRUD) ------------------------------------

adminRoutes.get("/admin/tts-voices", async (c) => {
  return c.json(await listTtsVoices());
});

adminRoutes.post("/admin/tts-voices", async (c) => {
  const body = await c.req.json<{
    provider?: string;
    providerVoiceId?: string;
    name?: string;
    description?: string;
    speed?: number;
    isDefault?: boolean;
  }>();

  if (!body.provider || !body.providerVoiceId || !body.name) {
    return c.json({ error: "provider, providerVoiceId, and name are required" }, 400);
  }
  if (!(TTS_PROVIDERS as readonly string[]).includes(body.provider)) {
    return c.json({ error: `Unknown provider: ${body.provider}` }, 400);
  }

  try {
    const voice = await createTtsVoice({
      provider: body.provider,
      providerVoiceId: body.providerVoiceId,
      name: body.name,
      description: body.description,
      speed: body.speed,
      isDefault: body.isDefault ?? false,
    });
    return c.json(voice, 201);
  } catch (err) {
    const msg = (err as Error).message;
    // Unique constraint: voice already in catalogue
    if (msg.includes("tts_voices_provider_voice_unique")) {
      return c.json({ error: "This voice is already in the catalogue" }, 409);
    }
    return c.json({ error: msg }, 500);
  }
});

adminRoutes.patch("/admin/tts-voices/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    speed?: number | null;
    isDefault?: boolean;
  }>();

  const voice = await updateTtsVoice(id, {
    ...(body.name !== undefined && { name: body.name }),
    ...(body.description !== undefined && { description: body.description }),
    ...(body.speed !== undefined && { speed: body.speed }),
    ...(body.isDefault !== undefined && { isDefault: body.isDefault }),
  });
  if (!voice) return c.json({ error: "Not found" }, 404);
  return c.json(voice);
});

adminRoutes.delete("/admin/tts-voices/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const deleted = await deleteTtsVoice(id);
    if (!deleted) return c.json({ error: "Not found" }, 404);
    return c.body(null, 204);
  } catch (err) {
    if ((err as any)?.code === "23503") {
      return c.json({ error: "Voice is referenced by one or more broadcasts" }, 409);
    }
    throw err;
  }
});

// --- TTS voice preview (admin — no broadcastId required) -----------------
// Lets admins hear a voice while building the catalogue, without needing
// an active broadcast. Auth gate is admin role; no spend-guard beyond that.

adminRoutes.post("/admin/tts/preview", async (c) => {
  const body = await c.req.json<{
    text?: string;
    voiceId?: string;
    provider?: string;
    speed?: number;
  }>();

  if (!body.text?.trim() || !body.voiceId || !body.provider) {
    return c.json({ error: "text, voiceId, and provider are required" }, 400);
  }
  if (!(TTS_PROVIDERS as readonly string[]).includes(body.provider)) {
    return c.json({ error: `Unknown provider: ${body.provider}` }, 400);
  }

  try {
    const audio = await generate(
      body.provider as TtsProvider,
      body.text.trim(),
      body.voiceId,
      body.speed,
    );
    return new Response(audio, {
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.byteLength),
      },
    });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});
