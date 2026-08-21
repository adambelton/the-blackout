"use client";

import { brand as C } from "../../../lib/palette";

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        color: C.stone,
        fontStyle: "italic",
        fontSize: 12,
        padding: 12,
        textAlign: "center",
      }}
    >
      {children}
    </div>
  );
}
