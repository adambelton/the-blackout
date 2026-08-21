"use client";

import type { DetailedHTMLProps, SelectHTMLAttributes } from "react";
import { brand as C } from "../lib/palette";

export function SelectInput(
  props: DetailedHTMLProps<SelectHTMLAttributes<HTMLSelectElement>, HTMLSelectElement>,
) {
  return (
    <select
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
    />
  );
}
