export const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

export interface NarrativeMedia {
  illustration: {
    id: string;
    imageUrl: string | null;
    prompt: string;
    model: string;
    generationMs: number;
  } | null;
  narration: {
    id: string;
    audioUrl: string | null;
    durationMs: number;
    voiceId: string;
    provider: string;
  } | null;
}
