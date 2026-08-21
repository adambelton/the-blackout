"use client";

import { brand as C } from "../../../lib/palette";

export function SourceLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        color: C.forest,
        fontWeight: 500,
        fontSize: 10,
        textTransform: "uppercase",
        letterSpacing: "0.12em",
      }}
    >
      {children}
    </span>
  );
}
