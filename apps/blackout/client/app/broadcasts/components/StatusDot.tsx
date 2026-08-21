"use client";

import type { CSSProperties } from "react";
import type { Broadcast } from "@blackout/shared";
import { brand as C } from "../../lib/palette";

type BroadcastStatus = Broadcast["status"];

export function StatusDot({ status }: { status: BroadcastStatus }) {
  const base: CSSProperties = {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
  };
  if (status === "live") {
    return (
      <span
        style={{
          ...base,
          background: C.forest,
          boxShadow: `0 0 0 3px ${C.forest}26`,
        }}
      />
    );
  }
  const color = {
    draft: C.stone,
    scheduled: C.driftwood,
    complete: C.celadon,
    archived: C.celadon,
  }[status] ?? C.stone;
  return <span style={{ ...base, background: color }} />;
}
