/**
 * Pure transform helpers for the matchroom (consumer) WebSocket.
 *
 * Lives separately from the WS handler so the rules can be unit-tested
 * without dragging in the full server graph (DB client, conductor,
 * storage). Anything that's about *what viewers can see* belongs here;
 * the WS handler just orchestrates the connection and delegates.
 *
 * Two concerns:
 *  1. `matchroomTransform` — the cue whitelist. Decides which conductor
 *     cues a viewer is allowed to receive (playback contract +
 *     reveal-gating, never operator-only diagnostics).
 *  2. `toViewerEntry` — the feed-entry reshape. Drops noise inside
 *     `feed_entry` (transcription, moderator notes, pressure/zone
 *     signals) and projects match events into the viewer DTO.
 */

import type { TeamSide } from "@blackout/shared";
import type { KairosFeedEntry } from "../lib/kairos.js";

/**
 * Cues the viewer is allowed to receive. The whitelist is a wall —
 * any new operator-only cue (latency_sample today, future runner
 * observations) defaults to "drop" rather than "leak to viewers"
 * unless explicitly added here.
 */
const VIEWER_CUE_TYPES = new Set([
  // Bundle-driven contract (Design A —
  // `docs/matchroom-reveal-architecture-scoping.md`). The matchroom
  // reads exclusively from these. Server still emits the legacy
  // cues (narrative / play / preload / phase / illustration /
  // feed_entry) for the moderator console — this whitelist drops
  // them client-side so matchroom listeners don't waste bandwidth or
  // parse cycles on cues they no longer handle.
  "connected",
  "generation_skipped",
  "passage_added",
  "passage_audio_ready",
  "passage_started",
  "passage_skipped",
  "passage_updated",
  "broadcast_status_changed",
]);

/**
 * Matchroom-specific cue transform. Called once per cue per client.
 * Whitelists the cues the viewer needs (playback contract + reveal
 * gating) and drops everything else — operator-only signals
 * (latency_sample, anything future the runner emits via
 * broadcastCue) must not reach viewers.
 *
 * `feed_entry` is no longer in the viewer whitelist (Sub-piece 4d
 * retired it in favour of bundle-driven event reveals). The reshape
 * helper `toViewerEntry` stays exported because the moderator-side
 * code path still uses it.
 */
export function matchroomTransform(cue: unknown): unknown | null {
  if (!cue || typeof cue !== "object") return cue;
  const c = cue as { type?: string };
  if (typeof c.type !== "string" || !VIEWER_CUE_TYPES.has(c.type)) return null;
  return cue;
}

/**
 * Shape a Kairos feed entry into the viewer's taxonomy. The matchroom
 * cares about three kinds of entries:
 *   - match events (goals, cards, subs) → rendered in the event ribbon
 *   - narrative_context / narrative_voice → ignored (presentation only)
 *   - transcription / moderator / match_stats → ignored (not viewer content)
 *
 * Everything else returns null and the conductor drops the forward.
 *
 * Output shape matches `BroadcastViewEvent` so the matchroom client
 * deals with a single flat shape whether the event arrived via WS or
 * REST bootstrap.
 */
export function toViewerEntry(
  entry: KairosFeedEntry,
): {
  id: string;
  eventType: string;
  content: string;
  minute: number | null;
  extraMinute: number | null;
  contentTime?: string;
  timestamp: number;
  player: string | null;
  relatedPlayer: string | null;
  team: TeamSide | null;
  teamName: string | null;
  isGoal: boolean;
} | null {
  const sourceName = (entry as unknown as { sourceName?: string; source?: string })
    .sourceName ?? entry.source;
  if (sourceName !== "match_events") return null;

  const d = entry.data as Record<string, unknown>;
  const eventType = (d.eventType ?? d.timelineType) as string | undefined;
  if (!eventType) return null;

  // Pressure/zone signals are useful moderator context but clutter the
  // viewer's event ribbon — only elevate real match events (goals,
  // cards, subs, VAR, etc.).
  if (eventType === "PRESSURE_UPDATE" || eventType === "ZONE_ENTRY" || eventType === "ZONE_MIDDLE") {
    return null;
  }

  const content = (typeof d.content === "string" && d.content) ||
    (typeof d.text === "string" && d.text) || "";

  const minute = typeof d.minute === "number" ? d.minute : null;
  const extraMinute = typeof d.extraMinute === "number" ? d.extraMinute : null;
  // Read Kairos's `subjectTime` (input vocabulary) and write `contentTime`
  // on the outbound matchroom-viewer event (consumer vocabulary). The
  // transformation happens at the seam — see `docs/vocabulary.md` § Time.
  const contentTime = typeof d.subjectTime === "string" ? d.subjectTime : undefined;
  const ts =
    typeof entry.timestamp === "number"
      ? entry.timestamp
      : Date.parse((entry as unknown as { created_at?: string }).created_at ?? "") || Date.now();

  const t = d.team as
    | { side?: TeamSide; name?: string }
    | TeamSide
    | null
    | undefined;
  const side = typeof t === "string" ? t : t?.side ?? null;
  const teamName =
    typeof t === "object" && t ? (t.name ?? null) : typeof d.teamName === "string" ? d.teamName : null;
  const player = typeof d.player === "string" ? d.player : null;
  const relatedPlayer = typeof d.relatedPlayer === "string" ? d.relatedPlayer : null;

  return {
    id: entry.id,
    eventType,
    content,
    minute,
    extraMinute,
    contentTime,
    timestamp: ts,
    player,
    relatedPlayer,
    team: side,
    teamName,
    isGoal: eventType === "GOAL",
  };
}
