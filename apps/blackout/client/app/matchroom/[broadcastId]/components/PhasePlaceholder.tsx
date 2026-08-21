"use client";

import { brand as C } from "../../../lib/palette";
import type { Phase } from "../derivations";

export function PhasePlaceholder({ phase }: { phase: Phase }) {
  const { headline, body } = phaseCopy(phase);
  return (
    <div
      style={{
        background: "rgba(255,255,255,0.025)",
        borderLeft: `2px solid ${C.driftwood}66`,
        padding: "24px 28px",
        borderRadius: 6,
        minHeight: 120,
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.driftwood,
          marginBottom: 12,
        }}
      >
        {headline}
      </div>
      <div
        style={{
          fontSize: 15,
          lineHeight: 1.7,
          color: C.stone,
          fontStyle: "italic",
        }}
      >
        {body}
      </div>
    </div>
  );
}

function phaseCopy(phase: Phase): { headline: string; body: string } {
  switch (phase) {
    case "pre_ramp":
      return {
        headline: "Pre-match",
        body: "The stadium lights hold. The crowd gathers. The narrator is clearing their throat.",
      };
    case "warming":
      return {
        headline: "Almost here",
        body: "The teams are in the tunnel. Any moment now.",
      };
    case "halftime":
      return {
        headline: "Half-time",
        body: "The whistle blows. The noise lowers a notch. We'll be back for the second half.",
      };
    case "full_time_winddown":
      return {
        headline: "Full-time",
        body: "The whistle has gone. A final word, and we'll let the night settle.",
      };
    case "complete":
      return {
        headline: "Broadcast complete",
        body: "Thanks for listening. The lights are going down.",
      };
    default:
      return { headline: "", body: "" };
  }
}
