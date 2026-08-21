"use client";

import type { ButtonHTMLAttributes, CSSProperties } from "react";
import { brand as C } from "../lib/palette";

type ButtonVariant = "primary" | "ghost" | "destructive";

interface PillButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  fullWidth?: boolean;
}

export function PillButton({
  variant = "ghost",
  fullWidth,
  children,
  disabled,
  style,
  ...rest
}: PillButtonProps) {
  const base: CSSProperties = {
    fontFamily: "inherit",
    fontSize: 13,
    fontWeight: variant === "primary" ? 500 : 400,
    padding: "9px 18px",
    borderRadius: 100,
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 160ms ease, border-color 160ms ease, color 160ms ease",
    opacity: disabled ? 0.5 : 1,
    width: fullWidth ? "100%" : undefined,
  };

  const variantStyle: Record<ButtonVariant, CSSProperties> = {
    primary: {
      background: C.umber,
      color: C.ivory,
      border: "none",
    },
    ghost: {
      background: "transparent",
      color: C.umber,
      border: `0.5px solid ${C.celadon}`,
    },
    destructive: {
      background: "transparent",
      color: C.crimson,
      border: `0.5px solid ${C.crimson}40`,
    },
  };

  return (
    <button
      disabled={disabled}
      {...rest}
      style={{ ...base, ...variantStyle[variant], ...style }}
      onMouseEnter={(e) => {
        if (disabled) return;
        if (variant === "primary") e.currentTarget.style.background = "#3A5432";
        if (variant === "ghost") e.currentTarget.style.borderColor = C.driftwood;
        if (variant === "destructive") e.currentTarget.style.borderColor = `${C.crimson}80`;
        rest.onMouseEnter?.(e);
      }}
      onMouseLeave={(e) => {
        if (variant === "primary") e.currentTarget.style.background = C.umber;
        if (variant === "ghost") e.currentTarget.style.borderColor = C.celadon;
        if (variant === "destructive") e.currentTarget.style.borderColor = `${C.crimson}40`;
        rest.onMouseLeave?.(e);
      }}
    >
      {children}
    </button>
  );
}
