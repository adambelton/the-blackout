import type { TtsProviderModule, TtsVoice } from "./types.js";

const VOICES: TtsVoice[] = [
  { id: "onyx", provider: "openai", name: "Onyx", gender: "male", accent: "american", description: "Deep, measured, narrator" },
  { id: "alloy", provider: "openai", name: "Alloy", gender: "neutral", accent: "american", description: "Balanced, versatile" },
  { id: "echo", provider: "openai", name: "Echo", gender: "male", accent: "american", description: "Warm, grounded" },
  { id: "fable", provider: "openai", name: "Fable", gender: "male", accent: "british", description: "Expressive, storyteller" },
  { id: "nova", provider: "openai", name: "Nova", gender: "female", accent: "american", description: "Friendly, bright" },
  { id: "shimmer", provider: "openai", name: "Shimmer", gender: "female", accent: "american", description: "Clear, refined" },
];

const DEFAULT_VOICE = "onyx";

export const openaiProvider: TtsProviderModule = {
  id: "openai",
  label: "OpenAI",

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY);
  },

  async listVoices(): Promise<TtsVoice[]> {
    return VOICES;
  },

  async generateSpeech(text: string, voiceId?: string, speed?: number): Promise<ArrayBuffer> {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY is not set");
    const voice = voiceId || DEFAULT_VOICE;

    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        voice,
        input: text,
        response_format: "mp3",
        ...(speed !== undefined && { speed }),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI TTS ${res.status}: ${body}`);
    }
    return res.arrayBuffer();
  },
};
