import type { TtsProviderModule, TtsVoice } from "./types.js";

interface ElevenLabsVoiceRaw {
  voice_id: string;
  name: string;
  labels?: Record<string, string>;
}

const DEFAULT_VOICE_ID = "JBFqnCBsd6RMkjVDRZzb"; // ElevenLabs "George" — English narrator

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  return key;
}

export const elevenlabsProvider: TtsProviderModule = {
  id: "elevenlabs",
  label: "ElevenLabs",

  isConfigured(): boolean {
    return Boolean(process.env.ELEVENLABS_API_KEY);
  },

  async listVoices(): Promise<TtsVoice[]> {
    const res = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": apiKey() },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ElevenLabs ${res.status}: ${body}`);
    }
    const data = (await res.json()) as { voices: ElevenLabsVoiceRaw[] };
    return data.voices.map((v): TtsVoice => ({
      id: v.voice_id,
      provider: "elevenlabs",
      name: v.name,
      gender: v.labels?.gender,
      accent: v.labels?.accent,
      description: v.labels?.description,
    }));
  },

  async generateSpeech(text: string, voiceId?: string, speed?: number): Promise<ArrayBuffer> {
    const voice = voiceId || process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID;
    const model = process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key": apiKey(),
      },
      body: JSON.stringify({
        text,
        model_id: model,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          ...(speed !== undefined && { speed }),
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`ElevenLabs ${res.status}: ${body}`);
    }
    return res.arrayBuffer();
  },
};
