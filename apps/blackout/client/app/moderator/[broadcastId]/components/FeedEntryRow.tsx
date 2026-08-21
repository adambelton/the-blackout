"use client";

import { brand as C } from "../../../lib/palette";
import type { ModeratorFeedEntry } from "@blackout/shared";

/** Per-source colour palette for the feed-row source label.
 * Mirrors the Kairos source taxonomy directly; unknown sources
 * fall back to a neutral stone so a future source surfaces
 * automatically without a UI change. */
const FEED_SOURCE_COLORS: Record<string, string> = {
  match_events: C.forest,
  match_pressure: C.celadon,
  match_action: C.driftwood,
  transcription: C.driftwood,
  moderator: "#9C7D3A",
  narrative_context: C.stone,
  narrative_voice: C.stone,
};

export function FeedEntryRow({ entry, covered }: { entry: ModeratorFeedEntry; covered: boolean }) {
  const isGoal = entry.subType === "GOAL";
  const color = FEED_SOURCE_COLORS[entry.source] ?? C.stone;
  // Render `source · subType` — gives the operator the runner's
  // contract verbatim (`match_events · GOAL`, `match_action ·
  // atmosphere`, `match_pressure · PRESSURE_UPDATE`). When there's
  // no subType the source name reads alone.
  const sourceLabel = entry.subType
    ? `${entry.source} · ${entry.subType}`
    : entry.source;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "54px 160px 1fr auto",
        gap: 10,
        padding: "8px 2px",
        borderBottom: `0.5px solid ${C.celadon}70`,
        fontSize: 13,
        lineHeight: 1.55,
      }}
    >
      <span
        style={{
          fontVariantNumeric: "tabular-nums",
          fontSize: 11,
          fontWeight: 500,
          color: C.driftwood,
          paddingTop: 1,
        }}
      >
        {entry.contentTime
          ? `${entry.contentTime}'`
          : entry.minute != null
            ? `${entry.minute}${entry.extraMinute != null && entry.extraMinute > 0 ? `+${entry.extraMinute}` : ""}'`
            : ""}
      </span>
      <span
        style={{
          fontSize: 9,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color,
          paddingTop: 2,
        }}
      >
        {sourceLabel}
      </span>
      <span
        style={{
          color: isGoal ? C.forest : C.umber,
          fontWeight: isGoal ? 500 : 300,
        }}
      >
        {entry.content}
      </span>
      <span
        style={{
          fontSize: 11,
          color: C.forest,
          paddingTop: 3,
          opacity: covered ? 1 : 0,
        }}
      >
        ✓
      </span>
    </div>
  );
}
