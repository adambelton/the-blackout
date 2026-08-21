"use client";

import { brand as C } from "../../../lib/palette";

export function ImageryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 8, fontSize: 12, color: C.umber, lineHeight: 1.55 }}>
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.stone,
          marginRight: 8,
        }}
      >
        {label}
      </span>
      {children}
    </div>
  );
}
