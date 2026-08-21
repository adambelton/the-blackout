import type { BroadcastTtsProvider } from "@blackout/shared";

export interface TtsVoice {
  /** UUID primary key from the tts_voices catalogue. */
  id: string;
  provider: BroadcastTtsProvider;
  /** The provider's own voice identifier (e.g. ElevenLabs voice ID).
   * Present on catalogue voices; absent on raw provider-browse results. */
  providerVoiceId?: string;
  name: string;
  accent?: string | null;
  gender?: string | null;
  description?: string | null;
}

export interface NarrativeRecord {
  id: string;
  text: string;
  generatedAt: number;
  covers?: { entryId: string; contentTime?: string }[];
}

/**
 * Server-authoritative playback cue. The RoomConductor emits this the
 * moment a clip becomes the current one for the entire room. Every
 * listener (moderator + matchroom) plays the same bytes at the same
 * instant; late joiners seek to the live offset.
 */
export interface ModeratorPlayCue {
  narrationId: string;
  narrativeId: string;
  text: string;
  wordCount: number;
  audioUrl: string;
  durationMs: number;
  playbackStartedAt: number;
  serverNow: number;
}

export interface LatencySample {
  goalContentTime: string;
  transcriptionContentTime: string;
  rawDeltaSeconds: number;
  configuredOffsetSeconds: number;
  sourceName: string | null;
  receivedAt: number;
}
