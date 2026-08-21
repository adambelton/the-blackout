"use client";

import { brand as C } from "../../../lib/palette";

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      style={{
        position: "relative",
        width: 34,
        height: 20,
        background: value ? C.forest : C.celadon,
        borderRadius: 100,
        cursor: "pointer",
        transition: "background 180ms ease",
        border: "none",
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: value ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 180ms ease",
          boxShadow: `0 1px 2px ${C.umber}1F`,
        }}
      />
    </button>
  );
}
