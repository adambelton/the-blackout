import { Hono } from "hono";
import { generate, listAllVoices, listProviders, TTS_PROVIDERS, type TtsProvider } from "../lib/tts/index.js";
import { getBroadcast } from "../lib/broadcasts.js";
import { listTtsVoices, getTtsVoice } from "../lib/tts-voices.js";
import { requireRole } from "../lib/auth-middleware.js";

const tts = new Hono();

// Every TTS surface touches a paid provider (OpenAI / ElevenLabs /
// Hume). Gate globally at the route level — writer + admin only.
// The in-route broadcastId + ttsEnabled checks stay as a second layer:
// role gets you access; the broadcast's own kill switch gates whether
// synthesis actually fires.
tts.use("/tts", requireRole("writer", "admin"));
tts.use("/tts/*", requireRole("writer", "admin"));
// Admin-curated voice catalogue — writers need this to populate the voice picker.
tts.use("/tts-voices", requireRole("writer", "admin"));

tts.get("/tts/providers", (c) => {
  return c.json({ providers: listProviders() });
});

// Admin-curated voice catalogue for the moderator picker.
tts.get("/tts-voices", async (c) => {
  const records = await listTtsVoices();
  const voices = records.map((r) => ({
    id: r.id,
    provider: r.provider,
    providerVoiceId: r.providerVoiceId,
    name: r.name,
    description: r.description,
  }));
  return c.json({ voices });
});

tts.get("/tts/voices", async (c) => {
  const voices = await listAllVoices();
  return c.json({ voices });
});

/**
 * POST /tts
 *
 * Always requires a `broadcastId` — TTS is a paid operation, so we
 * refuse to synthesise without knowing which broadcast authorised the
 * call. The broadcast's `ttsEnabled` flag is the server-side kill
 * switch: when not true, every surface (matchroom, moderator console,
 * voice previews) gets a 503 with a clear reason.
 */
tts.post("/tts", async (c) => {
  const body = await c.req.json<{
    text?: string;
    voiceId?: string;
    provider?: string;
    broadcastId?: string;
  }>();
  const text = body.text?.trim();
  if (!text) {
    return c.json({ error: "text is required" }, 400);
  }

  if (!body.broadcastId) {
    return c.json(
      { error: "broadcastId is required — TTS must be authorised by a specific broadcast" },
      400,
    );
  }

  const broadcast = await getBroadcast(body.broadcastId).catch(() => null);
  if (!broadcast) {
    return c.json({ error: "Broadcast not found" }, 404);
  }
  if (broadcast.ttsEnabled !== true) {
    return c.json(
      { error: "TTS is disabled for this broadcast", code: "tts_disabled" },
      503,
    );
  }

  try {
    const voiceRecord = body.voiceId ? await getTtsVoice(body.voiceId) : null;
    const provider = voiceRecord
      ? (voiceRecord.provider as TtsProvider)
      : ((body.provider ?? "openai") as TtsProvider);
    if (!TTS_PROVIDERS.includes(provider)) {
      return c.json({ error: `Unknown provider: ${provider}` }, 400);
    }
    const providerVoiceId = voiceRecord?.providerVoiceId ?? body.voiceId;
    const audio = await generate(provider, text, providerVoiceId, voiceRecord?.speed ?? undefined);
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

export { tts as ttsRoutes };
