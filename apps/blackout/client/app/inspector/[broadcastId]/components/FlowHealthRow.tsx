"use client";

import type { BroadcastHealth } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";
import { FlowPill } from "./FlowPill";
import { computeFlowDrift, contentTooltip, formatMmm } from "./utils";

/** Broadcast-level flow health — wall / content / prose / target.
 * In a healthy broadcast all four converge. Drift between any two
 * surfaces a different failure mode (see broadcast-health.ts). */
export function FlowHealthRow({ health }: { health: BroadcastHealth | null }) {
  if (!health || health.cycleCount === 0) return null;
  const drift = computeFlowDrift(health);
  return (
    <div
      style={{
        marginTop: 12,
        display: "flex",
        gap: 10,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.stone,
        }}
      >
        flow
      </span>
      <FlowPill
        label="wall"
        value={formatMmm(health.wallSeconds)}
        tone="neutral"
        title="Wall-clock since the first cycle fired."
      />
      <FlowPill
        label="content"
        value={formatMmm(health.contentSeconds)}
        tone={drift.contentBehindWall > 60 ? "warn" : "neutral"}
        title={contentTooltip(health)}
      />
      <FlowPill
        label="prose"
        value={formatMmm(health.proseSeconds)}
        tone={drift.proseBehindContent > 60 ? "warn" : "neutral"}
        title="Prose duration produced (wordCount × 60 / WPM)."
      />
      <FlowPill
        label="target"
        value={formatMmm(health.targetSeconds)}
        tone="neutral"
        title="Curator's word-budget target (recommendedWordCount × 60 / WPM)."
      />
      <span
        style={{
          fontSize: 11,
          color: C.driftwood,
          marginLeft: 4,
          fontFamily: MONO,
        }}
        title="Per-cycle counts that produced the totals above."
      >
        {health.cycleCount} cycles · {health.generationCount} gens
      </span>
    </div>
  );
}
