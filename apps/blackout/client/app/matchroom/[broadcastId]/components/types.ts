export interface Narrative {
  id: string;
  text: string;
  generatedAt: string;
  wordCount?: number;
}

export interface PlayCue {
  narrationId: string;
  narrativeId: string;
  text: string;
  wordCount: number;
  audioUrl: string;
  durationMs: number;
  playbackStartedAt: number;
  serverNow: number;
  batchEntryIds?: string[];
  contentTime?: number | null;
}

export interface BroadcastMeta {
  id: string;
  homeTeam: string;
  awayTeam: string;
  competition: string;
  matchDate: string;
  status: "draft" | "scheduled" | "live" | "complete";
  ttsEnabled?: boolean;
  [k: string]: unknown;
}

export interface ReplayProgress {
  index: number;
  audioOffsetMs: number;
}
