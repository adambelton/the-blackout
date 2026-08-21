export const TTS_PROVIDERS = ["openai", "elevenlabs", "hume"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export interface TtsVoice {
  id: string;
  provider: TtsProvider;
  name: string;
  gender?: string;
  accent?: string;
  description?: string;
}

export interface TtsProviderModule {
  id: TtsProvider;
  label: string;
  isConfigured(): boolean;
  listVoices(): Promise<TtsVoice[]>;
  generateSpeech(text: string, voiceId?: string, speed?: number): Promise<ArrayBuffer>;
}
