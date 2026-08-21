"use client";

import { brand as C } from "../../../lib/palette";

export function SubjectLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: C.driftwood, fontSize: 12 }}>
      {children}
    </span>
  );
}
