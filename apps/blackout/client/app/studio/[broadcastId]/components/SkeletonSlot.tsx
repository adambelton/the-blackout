"use client";

import { brand as C } from "../../../lib/palette";
import { DisabledActionRow } from "./DisabledActionRow";

export function SkeletonSlot() {
  return (
    <article
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        background: C.ivory,
      }}
    >
      <div
        style={{
          aspectRatio: "4 / 3",
          borderRadius: 6,
          background: C.celadon,
          animation: "studio-skel-pulse 1400ms ease-in-out infinite",
        }}
      />
      <DisabledActionRow />
    </article>
  );
}
