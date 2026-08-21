"use client";

import { brand as C } from "../../../lib/palette";

export function PlaceholderGlyph({ label }: { label: string }) {
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: C.driftwood,
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        fontWeight: 500,
      }}
    >
      {label}
    </div>
  );
}
