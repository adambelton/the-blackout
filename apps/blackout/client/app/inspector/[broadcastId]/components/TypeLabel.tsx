"use client";

import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";

export function TypeLabel({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontSize: 9,
        color: C.stone,
        fontFamily: MONO,
        padding: "1px 6px",
        borderRadius: 100,
        background: `${C.celadon}60`,
        textTransform: "lowercase",
        letterSpacing: "0.04em",
      }}
    >
      {children}
    </span>
  );
}
