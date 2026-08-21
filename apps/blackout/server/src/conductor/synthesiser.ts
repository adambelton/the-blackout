import { parseBuffer } from "music-metadata";
import { db } from "../db/client.js";
import { broadcastNarrations } from "../db/schema.js";
import { generate, type TtsProvider } from "../lib/tts/index.js";
import { getStorage } from "../lib/storage/index.js";
import type { CanonicalState, RevealingCanonical } from "@blackout/shared";
import type { NarrationRecord } from "./types.js";

/**
 * Floor on per-clip words-per-minute. Hume occasionally produces an
 * outlier clip with long non-speech audio padding — narration #59 of
 * the 2026-04-26 FA Cup SF was 73.8s for 94 words = 76 wpm, vs ~140
 * wpm mean across the broadcast. Below this floor we resynthesise the
 * clip once; if the second attempt is also under, we accept it (rare
 * Hume prosody decision the second roll didn't fix; better to ship
 * the clip than block the cycle).
 *
 * 90 wpm is conservative — well below ElevenLabs / Hume / OpenAI
 * normal range (~140–170) but above the dramatic-pause floor that
 * em-dash-heavy prose can legitimately hit. The fix targets clear
 * outliers, not the long-pause editorial style.
 */
const MIN_CLIP_WPM = 90;

/**
 * Synthesise a single narrative into an audio artefact. Writes the bytes
 * to storage, persists a `broadcast_narrations` row, returns the record
 * the conductor will queue for playback.
 *
 * Sequential per-broadcast (the conductor guarantees this) — synthesis
 * takes 2–3s and ordering must match Kairos's emission order. Running
 * in parallel would risk narration #2 landing before #1.
 *
 * Duration comes from parsing the audio's MP3 headers — the TTS
 * providers don't reliably return duration metadata, and we can't fall
 * back to a word-rate estimate without risking the scheduler dropping
 * seconds of trailing audio or leaving audible gaps between clips.
 */
export async function synthesiseNarration(input: {
  broadcastId: string;
  narrativeId: string;
  text: string;
  provider: TtsProvider;
  voiceId: string;
  speed: number | undefined;
  /** Kairos's batch context for this generation — threaded through
   * unchanged for the reveal-gating contract on the client. */
  batchEntryIds: string[];
  /** Kairos's `covers` — entries the narrator EXPLICITLY references
   * in the prose (subset of batchEntryIds). Persisted so the
   * matchroom view can compute the reveal contract: hide a
   * canonical event card only while a narration that covers it is
   * mid-flight. */
  covers: { entryId: string; charOffset?: number }[];
  /** Content-time anchor for this narration — derived from the
   * earliest subject time in Kairos's cycle batch (server transforms
   * at the seam). Threaded through so the play cue can snap the
   * matchroom's content clock at audio start. Null when no batch
   * entry carried a numeric subject time. See
   * `docs/vocabulary.md` § Time. */
  contentTime: number | null;
  /** Per-passage canonical-state bundle composed by the conductor
   * (Design A — `docs/matchroom-reveal-architecture-scoping.md`).
   * `revealedCanonical` is the visible state at this passage's
   * audio-start; `revealingCanonical` is the deltas it will reveal
   * during audio. Persisted together so a conductor restart can
   * rebuild running canonical state by folding revealing forward, and
   * so the archive replay path can serve the bundles without
   * recomposition. */
  revealedCanonical: CanonicalState;
  revealingCanonical: RevealingCanonical;
}): Promise<NarrationRecord> {
  const wordCount = countWords(input.text);

  let audioBytes = await generateAndMeasure(input.provider, input.text, input.voiceId, input.speed);

  if (wordCount > 0 && computeWpm(wordCount, audioBytes.durationMs) < MIN_CLIP_WPM) {
    const firstWpm = computeWpm(wordCount, audioBytes.durationMs);
    console.warn(
      `[synthesiser] clip wpm ${firstWpm.toFixed(1)} below floor ${MIN_CLIP_WPM} for narrative ${input.narrativeId} (${wordCount}w / ${audioBytes.durationMs}ms) — resynthesising once`,
    );
    const retry = await generateAndMeasure(input.provider, input.text, input.voiceId, input.speed);
    const retryWpm = computeWpm(wordCount, retry.durationMs);
    if (retryWpm >= MIN_CLIP_WPM) {
      audioBytes = retry;
      console.log(
        `[synthesiser] resynth recovered: ${retryWpm.toFixed(1)} wpm for narrative ${input.narrativeId}`,
      );
    } else {
      console.warn(
        `[synthesiser] resynth still under floor (${retryWpm.toFixed(1)} wpm) — accepting first attempt for narrative ${input.narrativeId}`,
      );
    }
  }

  const durationMs = audioBytes.durationMs;

  const [row] = await db
    .insert(broadcastNarrations)
    .values({
      broadcastId: input.broadcastId,
      narrativeId: input.narrativeId,
      text: input.text,
      wordCount,
      // Object key precedes the row existing — use the narrativeId as
      // the stable filename. One audio artefact per Kairos narrative.
      audioKey: `broadcasts/${input.broadcastId}/narrations/${input.narrativeId}.mp3`,
      durationMs,
      voiceId: input.voiceId,
      provider: input.provider,
      // Persist the batch so /broadcasts/:id can reconstruct
      // `revealedEvents` at bootstrap without round-tripping to Kairos.
      batchEntryIds: input.batchEntryIds,
      // Persist covers so the matchroom view's reveal gate can
      // identify which event cards to hide while a narration that
      // explicitly references them is mid-flight.
      covers: input.covers,
      // Per-passage canonical bundle (Design A). Always written
      // together — revealedCanonical / revealingCanonical are paired,
      // never one-or-the-other.
      revealedCanonical: input.revealedCanonical,
      revealingCanonical: input.revealingCanonical,
    })
    .returning();

  await getStorage().put(row.audioKey, audioBytes.bytes, "audio/mpeg");

  return {
    id: row.id,
    broadcastId: row.broadcastId,
    narrativeId: row.narrativeId,
    text: row.text,
    wordCount: row.wordCount,
    audioKey: row.audioKey,
    durationMs: row.durationMs,
    voiceId: row.voiceId,
    provider: row.provider as TtsProvider,
    synthesizedAt: row.synthesizedAt,
    playbackStartedAt: row.playbackStartedAt,
    batchEntryIds: input.batchEntryIds,
    contentTime: input.contentTime,
  };
}

function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

interface SynthAttempt {
  bytes: Buffer;
  durationMs: number;
}

async function generateAndMeasure(
  provider: TtsProvider,
  text: string,
  voiceId: string,
  speed: number | undefined,
): Promise<SynthAttempt> {
  const audioBuffer = await generate(provider, text, voiceId, speed);
  const bytes = Buffer.from(audioBuffer);
  const metadata = await parseBuffer(bytes, "audio/mpeg", { duration: true });
  const durationMs = Math.round((metadata.format.duration ?? 0) * 1000);
  if (durationMs <= 0) {
    throw new Error(
      `Failed to determine audio duration — scheduler cannot queue a clip of unknown length`,
    );
  }
  return { bytes, durationMs };
}

function computeWpm(wordCount: number, durationMs: number): number {
  if (durationMs <= 0) return 0;
  return (wordCount / durationMs) * 60_000;
}
