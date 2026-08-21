"use client";

import { brand as C } from "../../lib/palette";

export function AdminAction({
  label,
  danger,
  onClick,
}: {
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); onClick(); }}
      style={{
        fontFamily: "inherit",
        fontSize: 11,
        color: danger ? C.crimson : C.stone,
        padding: "4px 10px",
        border: `0.5px solid ${danger ? `${C.crimson}40` : C.celadon}`,
        borderRadius: 100,
        background: "transparent",
        cursor: "pointer",
        transition: "border-color 180ms ease, color 180ms ease",
        letterSpacing: "0.04em",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = danger ? C.crimson : C.driftwood;
        e.currentTarget.style.color = danger ? C.crimson : C.umber;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = danger ? `${C.crimson}40` : C.celadon;
        e.currentTarget.style.color = danger ? C.crimson : C.stone;
      }}
    >
      {label}
    </button>
  );
}
