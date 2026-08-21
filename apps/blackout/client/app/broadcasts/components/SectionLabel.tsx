"use client";

import type { ReactNode } from "react";
import { brand as C } from "../../lib/palette";

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: C.stone,
        marginBottom: 12,
        marginTop: 32,
      }}
    >
      {children}
    </div>
  );
}
