/**
 * Single home for every localStorage key the apps/blackout/client frontend
 * writes. Two patterns were drifting before this consolidation
 * (audit 2026-05-10):
 *   - matchroom replay progress: keyed `blackout.matchroom.replay.<id>.progress`
 *   - moderator console autoplay: keyed `blackout.console.autoplay.<id>`
 *
 * Centralising them here means a key rename is a one-place edit and
 * a quick `grep "STORAGE_KEYS"` shows every browser-persisted slot
 * the app uses.
 *
 * Each key takes the broadcast id (or whatever scoping value applies)
 * as an argument and returns the full string. The `blackout.` prefix
 * is conventional — keep it on every key so a third-party storage
 * inspector can identify our slots at a glance.
 */

export const STORAGE_KEYS = {
  /** Matchroom replay-walk progress (passage index + audio offset).
   * Set on every audio time-update; restored on mount when the
   * matchroom enters replay mode. Per-broadcast. */
  replayProgress: (broadcastId: string): string =>
    `blackout.matchroom.replay.${broadcastId}.progress`,

  /** Moderator console autoplay preference. Per-browser, per-broadcast
   * — one writer's choice doesn't leak across machines. */
  consoleAutoplay: (broadcastId: string): string =>
    `blackout.console.autoplay.${broadcastId}`,
} as const;
