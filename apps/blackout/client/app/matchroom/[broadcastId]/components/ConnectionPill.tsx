"use client";

import { brand as C } from "../../../lib/palette";

export function ConnectionPill({
  connection,
}: {
  connection: "connecting" | "open" | "closed" | "error" | "scheduled";
}) {
  const label =
    connection === "open" ? "Connected"
      : connection === "connecting" ? "Connecting…"
        : connection === "scheduled" ? "Scheduled"
          : connection === "error" ? "Connection error"
            : "Disconnected";
  const color =
    connection === "open" ? C.sage
      : connection === "error" ? C.crimson
        : C.driftwood;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color }}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: color,
          display: "inline-block",
        }}
      />
      {label}
    </div>
  );
}
