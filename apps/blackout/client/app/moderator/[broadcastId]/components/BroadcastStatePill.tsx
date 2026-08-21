"use client";

import { brand as C } from "../../../lib/palette";
import type { BroadcastStatus } from "@blackout/shared";

export function BroadcastStatePill({ status }: { status: BroadcastStatus }) {
  if (status === "live") {
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          padding: "5px 12px 5px 10px",
          borderRadius: 100,
          background: `${C.forest}14`,
          color: C.forest,
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: C.forest,
            boxShadow: `0 0 0 3px ${C.forest}30`,
            animation: "moderator-pulse 1.8s ease-in-out infinite",
          }}
        />
        Broadcast live
        <style>{`@keyframes moderator-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.55 } }`}</style>
      </span>
    );
  }
  const label =
    status === "complete"
      ? "Broadcast complete"
      : status === "scheduled"
        ? "Scheduled"
        : "Draft";
  const color =
    status === "complete" ? C.stone : status === "scheduled" ? C.driftwood : C.stone;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color,
      }}
    >
      {label}
    </span>
  );
}
