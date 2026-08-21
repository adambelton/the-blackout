"use client";

import type { Broadcast } from "@blackout/shared";
import { brand as C } from "../../lib/palette";

type BroadcastStatus = Broadcast["status"];

export function StatusLabel({ status }: { status: BroadcastStatus }) {
  const color = {
    draft: C.stone,
    scheduled: C.driftwood,
    live: C.forest,
    complete: C.stone,
    archived: C.stone,
  }[status] ?? C.stone;
  const text = {
    draft: "Draft",
    scheduled: "Scheduled",
    live: "Live",
    complete: "Complete",
    archived: "Archived",
  }[status] ?? status;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color,
      }}
    >
      {text}
    </span>
  );
}
