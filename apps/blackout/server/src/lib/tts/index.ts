import { openaiProvider } from "./openai.js";
import { elevenlabsProvider } from "./elevenlabs.js";
import { humeProvider } from "./hume.js";
import type { TtsProvider, TtsProviderModule, TtsVoice } from "./types.js";

export type { TtsProvider, TtsVoice } from "./types.js";
export { TTS_PROVIDERS } from "./types.js";

const providers: Record<TtsProvider, TtsProviderModule> = {
  openai: openaiProvider,
  elevenlabs: elevenlabsProvider,
  hume: humeProvider,
};

export interface TtsProviderSummary {
  id: TtsProvider;
  label: string;
  configured: boolean;
}

export function listProviders(): TtsProviderSummary[] {
  return (Object.values(providers) as TtsProviderModule[]).map((p) => ({
    id: p.id,
    label: p.label,
    configured: p.isConfigured(),
  }));
}

/**
 * Fetch voices from every *configured* provider. Failures for one provider
 * don't sink the others — we log and return whatever did resolve so the
 * moderator UI still shows the working options.
 */
export async function listAllVoices(): Promise<TtsVoice[]> {
  const configured = (Object.values(providers) as TtsProviderModule[]).filter((p) => p.isConfigured());
  const results = await Promise.all(
    configured.map(async (p) => {
      try {
        return await p.listVoices();
      } catch (err) {
        console.warn(`[tts] ${p.id} listVoices failed: ${(err as Error).message}`);
        return [] as TtsVoice[];
      }
    }),
  );
  return results.flat();
}

export async function generate(
  provider: TtsProvider,
  text: string,
  voiceId?: string,
  speed?: number,
): Promise<ArrayBuffer> {
  const p = providers[provider];
  if (!p) throw new Error(`Unknown TTS provider: ${provider}`);
  if (!p.isConfigured()) throw new Error(`TTS provider ${provider} is not configured`);
  return p.generateSpeech(text, voiceId, speed);
}
