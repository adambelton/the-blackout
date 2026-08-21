import type { TtsProviderModule, TtsVoice } from "./types.js";

interface HumeVoiceRaw {
  id: string;
  name: string;
  provider?: string;
}

function apiKey(): string {
  const key = process.env.HUME_API_KEY;
  if (!key) throw new Error("HUME_API_KEY is not set");
  return key;
}

export const humeProvider: TtsProviderModule = {
  id: "hume",
  label: "Hume Octave 2",

  isConfigured(): boolean {
    return Boolean(process.env.HUME_API_KEY);
  },

  async listVoices(): Promise<TtsVoice[]> {
    // Hume's library voices sit under provider=HUME_AI. The API lists them
    // at /v0/tts/voices; we page once (first 100) which is enough today —
    // extend with cursor pagination if we ever approach the cap.
    const url = "https://api.hume.ai/v0/tts/voices?provider=HUME_AI&page_size=100";
    const res = await fetch(url, { headers: { "X-Hume-Api-Key": apiKey() } });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Hume voices ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { voices_page?: HumeVoiceRaw[] };
    const voices = data.voices_page ?? [];
    return voices.map((v): TtsVoice => ({
      id: v.id,
      provider: "hume",
      name: v.name,
      description: "Octave 2 library voice",
    }));
  },

  async generateSpeech(text: string, voiceId?: string, speed?: number): Promise<ArrayBuffer> {
    // Hume returns base64 audio in a JSON envelope rather than raw bytes.
    // We decode to ArrayBuffer so the caller can treat it the same as
    // the other providers. Octave 2 is selected via `version: "2"`.
    const id = voiceId || process.env.HUME_VOICE_ID;
    if (!id) throw new Error("Hume TTS requires a voiceId or HUME_VOICE_ID env var");

    const res = await fetch("https://api.hume.ai/v0/tts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hume-Api-Key": apiKey(),
      },
      body: JSON.stringify({
        version: "2",
        format: { type: "mp3" },
        utterances: [
          {
            text,
            voice: { id, provider: "HUME_AI" },
            ...(speed !== undefined && { speed }),
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Hume TTS ${res.status}: ${body}`);
    }

    const data = (await res.json()) as { generations?: Array<{ audio?: string }> };
    const b64 = data.generations?.[0]?.audio;
    if (!b64) throw new Error("Hume TTS response contained no audio");
    return Uint8Array.from(Buffer.from(b64, "base64")).buffer;
  },
};
