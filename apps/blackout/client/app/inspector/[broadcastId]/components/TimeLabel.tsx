"use client";

import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";

export function TimeLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: C.driftwood, fontSize: 11, fontFamily: MONO, marginLeft: "auto" }}>
      {children}
    </span>
  );
}
