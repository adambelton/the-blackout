"use client";

import type { ReactNode } from "react";
import { brand as C } from "../lib/palette";

export function DialogFooter({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        alignItems: "center",
        gap: 8,
        padding: "14px 22px",
        borderTop: `0.5px solid ${C.celadon}`,
        background: `${C.celadon}E0`,
        position: "sticky",
        bottom: 0,
        zIndex: 1,
      }}
    >
      {children}
    </div>
  );
}
