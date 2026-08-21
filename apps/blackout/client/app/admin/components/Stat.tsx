"use client";

import { brand as C } from "../../lib/palette";

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ textAlign: "right", minWidth: 80 }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          color: C.stone,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 12,
          color: C.umber,
          fontVariantNumeric: "tabular-nums",
          marginTop: 2,
        }}
      >
        {value}
      </div>
    </div>
  );
}
