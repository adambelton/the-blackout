export const VISIBLE_CARDS = 3;

export interface StudioPoolItem {
  poolItemId: string;
  illustrationId: string | null;
  prompt: string;
  tags: string[];
  imageUrl: string | null;
  createdAt: number;
}

export interface StudioGeneratedIllustration {
  id: string;
  broadcastId: string;
  prompt: string;
  imageUrl: string | null;
  model: string;
  generatedAt: string;
  generationMs: number;
}

export type CardMode =
  | "prompt" // suggestion up, awaiting discard / edit / generate
  | "editing" // writer is tweaking the text before generating
  | "generating" // Replicate in flight
  | "preview" // image landed; awaiting accept / regenerate / discard
  | "busy"; // terminal action in flight (accept / discard)

export interface Card {
  id: string;
  prompt: string;
  mode: CardMode;
  editBuffer?: string;
  illustration?: StudioGeneratedIllustration;
  error?: string;
}
