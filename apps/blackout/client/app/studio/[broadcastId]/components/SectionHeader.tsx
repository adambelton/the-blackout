"use client";

import { brand as C } from "../../../lib/palette";

export function SectionHeader({ label, meta }: { label: string; meta?: string }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "baseline",
        borderBottom: `0.5px solid ${C.celadon}`,
        paddingBottom: 6,
        marginBottom: 16,
      }}
    >
      <span
        style={{
          fontSize: 11,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.umber,
          fontWeight: 500,
        }}
      >
        {label}
      </span>
      {meta ? (
        <span style={{ fontSize: 11, color: C.stone }}>{meta}</span>
      ) : null}
    </div>
  );
}
