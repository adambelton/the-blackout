"use client";

import { brand as C } from "../../../lib/palette";

function capitalise(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ServicePill({
  label,
  ok,
  unconfigured,
  tooltip,
}: {
  label: string;
  ok: boolean;
  unconfigured?: boolean;
  tooltip: string;
}) {
  const color = unconfigured ? C.driftwood : ok ? C.forest : C.crimson;
  return (
    <span
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        fontSize: 12,
        color: C.stone,
      }}
    >
      <span
        style={{ width: 6, height: 6, borderRadius: "50%", background: color }}
      />
      {capitalise(label)}
    </span>
  );
}
