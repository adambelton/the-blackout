"use client";

import type { Broadcast } from "@blackout/shared";
import { formatMatchDate } from "../lib/format";
import { brand } from "../lib/palette";

/**
 * Fixture subtitle used in the header of every admin / writer
 * surface (studio, moderator, inspector). Consistent wording and
 * format across the three pages so the match's identity reads the
 * same wherever the operator lands.
 *
 * Shape: `Home vs Away — Competition · Fri 3 May 14:30`. Missing
 * bits drop out gracefully (competition or date absent → joiner is
 * omitted).
 */

export function FixtureMeta({
  broadcast,
  color = brand.driftwood,
  fontSize = 13,
}: {
  broadcast: Broadcast | null;
  /** Override text colour for dark-theme surfaces. Defaults to the
   * brand driftwood (light theme). */
  color?: string;
  /** Override font size. Defaults to 13px, matching the subtitle
   * weight across the admin surfaces. */
  fontSize?: number;
}) {
  if (!broadcast) {
    return (
      <div style={{ fontSize, color, letterSpacing: "0.01em" }}>
        Loading broadcast…
      </div>
    );
  }

  const { homeTeam, awayTeam, competition, matchDate } = broadcast;
  const teams = homeTeam && awayTeam ? `${homeTeam} vs ${awayTeam}` : "—";
  const date = matchDate ? formatMatchDate(matchDate) : "";

  const parts = [teams];
  if (competition) parts.push(competition);
  const head = parts.join(" — ");
  const text = date ? `${head} · ${date}` : head;

  return (
    <div style={{ fontSize, color, letterSpacing: "0.01em" }}>{text}</div>
  );
}
