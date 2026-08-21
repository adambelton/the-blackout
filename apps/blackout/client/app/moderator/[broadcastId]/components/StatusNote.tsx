"use client";

import { brand as C } from "../../../lib/palette";

export function StatusNote({
  active,
  activeColor,
  label,
}: {
  active: boolean;
  activeColor: string;
  label: string;
}) {
  return (
    <span style={{ fontSize: 11, color: C.stone, marginLeft: 4 }}>
      <span
        style={{
          display: "inline-block",
          width: 5,
          height: 5,
          borderRadius: "50%",
          background: active ? activeColor : C.stone,
          marginRight: 5,
          verticalAlign: "middle",
        }}
      />
      {label}
    </span>
  );
}
