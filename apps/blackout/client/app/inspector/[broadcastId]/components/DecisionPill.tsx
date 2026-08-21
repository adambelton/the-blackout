"use client";

import type { PipelineImageryDecision } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";

export function DecisionPill({ decision }: { decision: PipelineImageryDecision["decision"] }) {
  const colour = decision === "generate"
    ? C.driftwood
    : decision === "pool"
    ? C.forest
    : C.stone;
  return (
    <span
      style={{
        marginLeft: "auto",
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        padding: "2px 10px",
        borderRadius: 100,
        background: `${colour}1A`,
        color: colour,
      }}
    >
      {decision}
    </span>
  );
}
