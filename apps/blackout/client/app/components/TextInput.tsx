"use client";

import type { DetailedHTMLProps, InputHTMLAttributes } from "react";
import { brand as C } from "../lib/palette";

export function TextInput(
  props: DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>,
) {
  return (
    <input
      type="text"
      {...props}
      style={{
        fontFamily: "inherit",
        fontSize: 13,
        color: C.umber,
        padding: "9px 12px",
        borderRadius: 8,
        border: `0.5px solid ${C.celadon}`,
        background: C.ivory,
        width: "100%",
        boxSizing: "border-box",
        outline: "none",
        transition: "border-color 160ms ease",
        ...(props.style ?? {}),
      }}
      onFocus={(e) => {
        e.currentTarget.style.borderColor = C.driftwood;
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        e.currentTarget.style.borderColor = C.celadon;
        props.onBlur?.(e);
      }}
    />
  );
}
