"use client";

import { brand as C } from "../../../lib/palette";

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: C.stone,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}
