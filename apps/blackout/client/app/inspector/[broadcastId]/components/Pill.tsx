"use client";

import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";

export function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-block",
        margin: "2px 6px 2px 0",
        padding: "2px 10px",
        background: `${C.celadon}70`,
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 100,
        fontFamily: MONO,
        fontSize: 11,
        color: C.umber,
      }}
    >
      {children}
    </span>
  );
}
