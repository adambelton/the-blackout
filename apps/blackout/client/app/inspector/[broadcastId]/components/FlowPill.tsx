"use client";

import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";

export function FlowPill({
  label,
  value,
  tone,
  title,
}: {
  label: string;
  value: string;
  tone: "neutral" | "warn";
  title: string;
}) {
  const fg: string = tone === "warn" ? C.warn : C.umber;
  const bg: string = tone === "warn" ? `${C.warn}14` : `${C.celadon}80`;
  return (
    <span
      title={title}
      style={{
        fontSize: 12,
        fontFamily: MONO,
        padding: "4px 12px",
        borderRadius: 100,
        background: bg,
        color: fg,
        display: "inline-flex",
        gap: 6,
      }}
    >
      <span style={{ color: C.stone, fontSize: 10, alignSelf: "center" }}>{label}</span>
      <span>{value}</span>
    </span>
  );
}
