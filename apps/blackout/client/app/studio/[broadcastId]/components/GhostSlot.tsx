"use client";

import { brand as C } from "../../../lib/palette";
import { DisabledActionRow } from "./DisabledActionRow";

export function GhostSlot() {
  return (
    <article
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        border: `0.5px dashed ${C.celadon}`,
        borderRadius: 10,
        background: "transparent",
      }}
    >
      <div
        style={{
          aspectRatio: "4 / 3",
          borderRadius: 6,
          background: `${C.celadon}55`,
        }}
      />
      <DisabledActionRow />
    </article>
  );
}
