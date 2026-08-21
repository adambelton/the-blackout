"use client";

import { brand as C } from "../../../lib/palette";

export function CardMeta({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        marginTop: 8,
        paddingTop: 8,
        borderTop: `0.5px dashed ${C.celadon}`,
        fontSize: 11,
        color: C.stone,
      }}
    >
      {children}
    </div>
  );
}
