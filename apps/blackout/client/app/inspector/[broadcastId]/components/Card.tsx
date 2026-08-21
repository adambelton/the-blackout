"use client";

import { brand as C } from "../../../lib/palette";

export function Card({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      style={{
        background: C.ivory,
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 8,
        padding: "10px 12px",
        marginBottom: 10,
        fontSize: 12,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
