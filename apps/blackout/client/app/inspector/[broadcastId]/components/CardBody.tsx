"use client";

import { brand as C } from "../../../lib/palette";

export function CardBody({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 6,
        color: C.umber,
        fontSize: 13,
        lineHeight: 1.55,
        fontWeight: 300,
        wordBreak: "break-word",
      }}
    >
      {children}
    </div>
  );
}
