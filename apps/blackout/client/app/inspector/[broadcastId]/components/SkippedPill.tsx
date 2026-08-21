"use client";

import { brand as C } from "../../../lib/palette";

export function SkippedPill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 100,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        background: `${C.crimson}14`,
        color: C.crimson,
        border: `0.5px solid ${C.crimson}40`,
      }}
    >
      {children}
    </span>
  );
}
