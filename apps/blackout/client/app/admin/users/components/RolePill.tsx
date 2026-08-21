"use client";

import { brand as C } from "../../../lib/palette";

export function RolePill({
  label,
  active,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || active}
      style={{
        fontFamily: "inherit",
        fontSize: 11,
        letterSpacing: "0.06em",
        color: active ? C.ivory : C.stone,
        padding: "4px 12px",
        border: `0.5px solid ${active ? C.umber : C.celadon}`,
        borderRadius: 100,
        background: active ? C.umber : "transparent",
        cursor: active || disabled ? "default" : "pointer",
        transition: "border-color 180ms ease, background 180ms ease, color 180ms ease",
        opacity: disabled && !active ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (!active && !disabled) {
          e.currentTarget.style.borderColor = C.driftwood;
          e.currentTarget.style.color = C.umber;
        }
      }}
      onMouseLeave={(e) => {
        if (!active && !disabled) {
          e.currentTarget.style.borderColor = C.celadon;
          e.currentTarget.style.color = C.stone;
        }
      }}
    >
      {label}
    </button>
  );
}
