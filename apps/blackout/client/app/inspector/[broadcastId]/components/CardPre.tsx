"use client";

import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";

export function CardPre({ children }: { children: React.ReactNode }) {
  return (
    <pre
      style={{
        margin: "6px 0 0 0",
        padding: 8,
        background: `${C.celadon}40`,
        borderRadius: 6,
        overflowX: "auto",
        fontSize: 11,
        fontFamily: MONO,
        whiteSpace: "pre-wrap",
        wordBreak: "break-all",
        color: C.umber,
      }}
    >
      {children}
    </pre>
  );
}
