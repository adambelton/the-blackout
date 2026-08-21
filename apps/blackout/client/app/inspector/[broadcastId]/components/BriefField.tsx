"use client";

import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";

export function BriefField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div
      style={{
        fontSize: 12,
        color: C.stone,
        maxWidth: 340,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
      title={value}
    >
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
      <span
        style={{
          color: C.umber,
          fontFamily: mono ? MONO : "inherit",
        }}
      >
        {value}
      </span>
    </div>
  );
}
