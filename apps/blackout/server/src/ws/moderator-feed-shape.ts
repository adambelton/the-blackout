/**
 * Pure transform from a Kairos feed entry into the moderator's feed
 * shape. Lives outside the WS handler so it can be unit-tested
 * without pulling in the DB / conductor / storage graph, and so the
 * bootstrap builder (`buildModeratorView`) can reshape historical
 * entries with the exact same rules the live WS path uses.
 *
 * The output preserves the engine's taxonomy: `source` is the Kairos
 * source name as-pushed (`match_events` / `match_action` /
 * `match_pressure` / `moderator` / `narrative_context` /
 * `narrative_voice`), `subType` is the data-level classification
 * (`GOAL` / `KICKOFF` / `atmosphere` / `event_texture` /
 * `PRESSURE_UPDATE` / etc.). The operator sees the same shape the
 * runner pushes — adding a new source/subType surfaces automatically.
 *
 * Stats entries (raw pressure / trend / ball / xG) are still filtered
 * — they're stored on Kairos for analysis but would swamp the
 * scroll pane. Other unknown sources pass through with their source
 * name so they're at least visible.
 */

import { isKairosSourceName, type ModeratorFeedEntry, type TeamSide } from "@blackout/shared";
import type { KairosFeedEntry } from "../lib/kairos.js";

export function toFeedEntry(entry: KairosFeedEntry): ModeratorFeedEntry | null {
  const d = entry.data as Record<string, unknown>;
  const rawSourceName = (entry as unknown as { sourceName?: string; source?: string })
    .sourceName ?? entry.source;

  // Drop entries from sources outside the operator's working set —
  // unknown legacy sources (`transcription` before the distillation
  // cutover; production no longer pushes it) and `match_stats`
  // (analysis-only on Kairos; would swamp the operator scroll pane).
  // Order matters for narrowing: KairosSourceName guard first so the
  // sourceName variable narrows to the union; then the match_stats
  // exclusion narrows further.
  if (!isKairosSourceName(rawSourceName)) return null;
  if (rawSourceName === "match_stats") return null;
  const sourceName = rawSourceName;

  const content =
    (typeof d.content === "string" && d.content) ||
    (typeof d.text === "string" && d.text) ||
    "";

  const minute = typeof d.minute === "number" ? d.minute : null;
  const extraMinute = typeof d.extraMinute === "number" ? d.extraMinute : null;
  // Read Kairos's `subjectTime` (input vocabulary) and write `contentTime`
  // on the outbound ModeratorFeedEntry (consumer vocabulary). The
  // transformation happens at the seam — see `docs/vocabulary.md` § Time.
  const contentTime = typeof d.subjectTime === "string" ? d.subjectTime : undefined;
  const ts =
    typeof entry.timestamp === "number"
      ? entry.timestamp
      : Date.parse((entry as unknown as { created_at?: string }).created_at ?? "") || Date.now();

  // Data-level subType for sources that carry one. `match_events` and
  // `match_pressure` use `eventType` (or the legacy `timelineType` for
  // pressure). `match_action` uses `kind` (atmosphere / event_texture).
  // Pure ambient sources (moderator / narrative_*) don't have a subType.
  const eventType =
    typeof d.eventType === "string"
      ? d.eventType
      : typeof d.timelineType === "string"
        ? d.timelineType
        : undefined;
  const kind = typeof d.kind === "string" ? d.kind : undefined;
  const subType =
    sourceName === "match_action" ? kind : eventType;

  // Event-shape metadata: pulled for sources whose entries describe
  // observable moments. Match-events and match-pressure get the full
  // shape; match-action gets the structural fields it carries
  // (parentSourceId for event_texture).
  if (sourceName === "match_events" || sourceName === "match_pressure") {
    const t = d.team as
      | { side?: TeamSide; name?: string }
      | TeamSide
      | null
      | undefined;
    const side = typeof t === "string" ? t : t?.side;
    const teamName =
      typeof t === "object" && t ? t.name : typeof d.teamName === "string" ? d.teamName : undefined;

    return {
      id: entry.id,
      source: sourceName,
      ...(subType ? { subType } : {}),
      content,
      minute,
      extraMinute,
      contentTime,
      timestamp: ts,
      metadata: {
        eventType: d.eventType ?? d.timelineType,
        player: d.player,
        team: side,
        teamName,
        result: d.result,
        isGoal: d.eventType === "GOAL",
      },
    };
  }

  if (sourceName === "match_action") {
    const parentSourceId =
      typeof d.parentSourceId === "string" ? d.parentSourceId : undefined;
    const eventClass =
      typeof d.eventClass === "string" ? d.eventClass : undefined;
    return {
      id: entry.id,
      source: sourceName,
      ...(subType ? { subType } : {}),
      content,
      minute,
      extraMinute,
      contentTime,
      timestamp: ts,
      metadata: {
        ...(parentSourceId ? { parentSourceId } : {}),
        ...(eventClass ? { eventClass } : {}),
      },
    };
  }

  if (sourceName === "moderator") {
    return {
      id: entry.id,
      source: sourceName,
      content,
      minute,
      extraMinute,
      contentTime,
      timestamp: ts,
    };
  }

  if (sourceName === "narrative_context" || sourceName === "narrative_voice") {
    return {
      id: entry.id,
      source: sourceName,
      content,
      minute: null,
      extraMinute: null,
      timestamp: ts,
    };
  }

  // Every KairosSourceName is handled by an explicit branch above;
  // this is unreachable. TypeScript needs a return statement, so use
  // the never-shaped fallback.
  const _exhaustive: never = sourceName;
  void _exhaustive;
  return null;
}
