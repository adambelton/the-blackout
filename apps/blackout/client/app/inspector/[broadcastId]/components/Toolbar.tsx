"use client";

import { useMemo } from "react";
import type {
  PipelineCycleSummary,
  PipelineCycleDetail,
  PipelineGeneration,
} from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";
import { ToolbarBtn } from "./ToolbarBtn";
import { TimingPill } from "./TimingPill";
import { CycleFlowPills } from "./CycleFlowPills";
import {
  computeContentSpan,
  computeSubjectMomentSpan,
  formatTs,
  formatTriggerLabel,
  describeFlushTrigger,
} from "./utils";

export function Toolbar({
  cycles,
  cycleIndex,
  onChange,
  detail,
  generation,
}: {
  cycles: PipelineCycleSummary[];
  cycleIndex: number;
  onChange: (i: number) => void;
  detail: PipelineCycleDetail | null;
  generation: PipelineGeneration | null;
}) {
  const summary = cycles[cycleIndex];
  const positionLabel = summary
    ? `cycle ${cycles.length - cycleIndex} of ${cycles.length}`
    : "—";
  const contentSpan = useMemo(() => computeContentSpan(detail), [detail]);
  const contentMoment = useMemo(() => computeSubjectMomentSpan(detail), [detail]);
  // Drift comes from the server (summary.drift) so the per-cycle
  // pills here use the same arithmetic as the scrub strip below.
  // Eliminates the duplicated client-side computation we used to
  // do here for the selected cycle only.
  const drift = summary?.drift ?? null;
  const { reasonColour, reasonBg } = useMemo(() => {
    if (!summary) return { reasonColour: C.stone, reasonBg: `${C.celadon}80` };
    if (summary.triggerReason === "external") {
      return { reasonColour: C.driftwood, reasonBg: `${C.driftwood}1A` };
    }
    if (!summary.generationId) {
      return { reasonColour: C.crimson, reasonBg: `${C.crimson}14` };
    }
    return { reasonColour: C.forest, reasonBg: `${C.forest}14` };
  }, [summary]);

  return (
    <div
      style={{
        display: "flex",
        gap: 8,
        padding: "14px 32px",
        borderBottom: `0.5px solid ${C.celadon}`,
        alignItems: "center",
        flexWrap: "wrap",
      }}
    >
      <ToolbarBtn
        onClick={() => onChange(cycles.length - 1)}
        disabled={cycleIndex >= cycles.length - 1}
      >
        ⇤ First
      </ToolbarBtn>
      <ToolbarBtn onClick={() => onChange(cycleIndex + 1)} disabled={cycleIndex >= cycles.length - 1}>
        ← Prev
      </ToolbarBtn>
      <ToolbarBtn onClick={() => onChange(cycleIndex - 1)} disabled={cycleIndex <= 0}>
        Next →
      </ToolbarBtn>
      <ToolbarBtn onClick={() => onChange(0)} disabled={cycleIndex === 0}>
        Latest ⇥
      </ToolbarBtn>
      {summary ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginLeft: 8,
            flex: 1,
            flexWrap: "wrap",
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              padding: "4px 10px",
              borderRadius: 100,
              background: reasonBg,
              color: reasonColour,
            }}
            title={describeFlushTrigger(detail?.flushTrigger ?? null)}
          >
            {formatTriggerLabel(summary.triggerReason, detail?.flushTrigger ?? null)}
            {!summary.generationId ? " · skipped" : ""}
          </span>
          <span style={{ fontSize: 12, color: C.driftwood }}>{positionLabel}</span>
          <span style={{ fontSize: 12, color: C.stone, fontFamily: MONO }}>
            {formatTs(summary.triggeredAt)}
          </span>
          <span
            style={{
              fontSize: 11,
              color: C.stone,
              fontFamily: MONO,
              padding: "2px 10px",
              borderRadius: 100,
              background: `${C.celadon}80`,
            }}
            title="Entries selected by curation / annotations produced this cycle"
          >
            {summary.entryCount}e · {summary.annotationCount}a
          </span>
          {contentMoment ? (
            <span
              title={contentMoment.stretched ? "Content-time span exceeds 60s — sources crossed multiple windows" : "Content-time window — phase + phaseSecond range across the cycle's entries"}
              style={{
                fontSize: 11,
                color: contentMoment.stretched ? C.warn : C.forest,
                fontFamily: MONO,
                padding: "2px 10px",
                borderRadius: 100,
                background: contentMoment.stretched ? `${C.warn}14` : `${C.forest}14`,
              }}
            >
              {contentMoment.text}
            </span>
          ) : null}
          {contentSpan ? (
            <span
              title={contentSpan.stretched ? "Wall-clock arrival span exceeds the cadence window" : "Wall-clock arrival span — heterogeneity in when entries landed"}
              style={{
                fontSize: 11,
                color: contentSpan.stretched ? C.warn : C.stone,
                fontFamily: MONO,
                padding: "2px 10px",
                borderRadius: 100,
                background: contentSpan.stretched ? `${C.warn}14` : `${C.celadon}80`,
              }}
            >
              arr: {contentSpan.text}
            </span>
          ) : null}
          <TimingPill timing={detail?.timingMs ?? null} />
          <CycleFlowPills drift={drift} />
        </div>
      ) : null}
    </div>
  );
}
