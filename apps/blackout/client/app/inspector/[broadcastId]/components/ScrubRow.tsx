"use client";

import { forwardRef } from "react";
import type { PipelineCycleSummary } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";
import { driftBandColour, triggerMarker, scrubTooltip } from "./utils";

export const ScrubRow = forwardRef<HTMLButtonElement, {
  cycle: PipelineCycleSummary;
  selected: boolean;
  onClick: () => void;
}>(function ScrubRow({ cycle, selected, onClick }, ref) {
  const driftColour = driftBandColour(cycle.drift.driftBand);
  const triggerMark = triggerMarker(cycle.flushTrigger, cycle.triggerReason);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      title={scrubTooltip(cycle)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        padding: "3px 10px",
        border: "none",
        background: selected ? `${C.driftwood}1A` : "transparent",
        cursor: "pointer",
        fontFamily: MONO,
        fontSize: 10,
        color: C.stone,
        borderLeft: selected ? `2px solid ${C.driftwood}` : "2px solid transparent",
        textAlign: "left",
      }}
    >
      <span style={{ color: triggerMark.colour, width: 8, flexShrink: 0 }}>
        {triggerMark.glyph}
      </span>
      <span
        style={{
          flex: 1,
          height: 6,
          background: driftColour,
          borderRadius: 2,
          opacity: cycle.generationId ? 1 : 0.35,
        }}
      />
    </button>
  );
});
