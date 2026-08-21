"use client";

import { brand as C } from "../../../lib/palette";

export function ToolbarBtn({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        fontFamily: "inherit",
        fontSize: 12,
        padding: "6px 14px",
        borderRadius: 100,
        background: "transparent",
        color: disabled ? C.stone : C.umber,
        border: `0.5px solid ${C.celadon}`,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "border-color 160ms ease",
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.borderColor = C.driftwood;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = C.celadon;
      }}
    >
      {children}
    </button>
  );
}
