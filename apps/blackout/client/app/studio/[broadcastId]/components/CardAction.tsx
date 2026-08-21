"use client";

import { brand as C } from "../../../lib/palette";

export function CardAction({
  onClick,
  primary,
  subdued,
  disabled,
  children,
}: {
  onClick?: () => void;
  primary?: boolean;
  subdued?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        padding: "6px 12px",
        fontSize: 11.5,
        fontFamily: "inherit",
        letterSpacing: "0.02em",
        background: primary ? C.forest : "transparent",
        color: primary ? C.ivory : subdued ? C.stone : C.umber,
        border: primary
          ? "none"
          : `0.5px solid ${C.celadon}`,
        borderRadius: 999,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.45 : 1,
      }}
    >
      {children}
    </button>
  );
}
