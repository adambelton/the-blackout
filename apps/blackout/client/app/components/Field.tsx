"use client";

import type { ReactNode } from "react";
import { brand as C } from "../lib/palette";

interface FieldProps {
  label: string;
  hint?: string;
  children: ReactNode;
}

export function Field({ label, hint, children }: FieldProps) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.stone,
        }}
      >
        {label}
      </span>
      {children}
      {hint ? <span style={{ fontSize: 11, color: C.driftwood, marginTop: 2 }}>{hint}</span> : null}
    </label>
  );
}
