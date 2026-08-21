"use client";

import type { ReactNode } from "react";
import { brand as C } from "../lib/palette";

export function FieldError({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <div
      style={{
        fontSize: 12,
        color: C.crimson,
        background: `${C.crimson}14`,
        border: `0.5px solid ${C.crimson}40`,
        borderRadius: 8,
        padding: "8px 12px",
        marginBottom: 12,
      }}
    >
      {children}
    </div>
  );
}
