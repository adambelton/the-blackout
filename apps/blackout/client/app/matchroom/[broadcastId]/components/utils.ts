import { STORAGE_KEYS } from "@/lib/storage-keys";
import type { ReplayProgress } from "./types";

/** Re-exported so existing call sites under apps/blackout/client/app/matchroom keep
 * their import; the canonical key now lives in `lib/storage-keys.ts`. */
export const REPLAY_PROGRESS_KEY = STORAGE_KEYS.replayProgress;

export function loadReplayProgress(broadcastId: string, tag: string): ReplayProgress {
  if (typeof window === "undefined") return { index: 0, audioOffsetMs: 0 };
  const raw = window.localStorage.getItem(REPLAY_PROGRESS_KEY(broadcastId));
  if (!raw) return { index: 0, audioOffsetMs: 0 };
  try {
    const parsed = JSON.parse(raw) as {
      tag?: unknown;
      index?: unknown;
      audioOffsetMs?: unknown;
    };
    if (parsed.tag !== tag) return { index: 0, audioOffsetMs: 0 };
    const index = typeof parsed.index === "number" && parsed.index >= 0 ? parsed.index : 0;
    const audioOffsetMs =
      typeof parsed.audioOffsetMs === "number" && parsed.audioOffsetMs >= 0
        ? parsed.audioOffsetMs
        : 0;
    return { index, audioOffsetMs };
  } catch {
    return { index: 0, audioOffsetMs: 0 };
  }
}

export function saveReplayProgress(
  broadcastId: string,
  tag: string,
  index: number,
  audioOffsetMs: number,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    REPLAY_PROGRESS_KEY(broadcastId),
    JSON.stringify({ tag, index, audioOffsetMs }),
  );
}
