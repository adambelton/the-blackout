"use client";

import type { ReactNode } from "react";

export function DialogBody({ children }: { children: ReactNode }) {
  return <div style={{ padding: "18px 22px" }}>{children}</div>;
}
