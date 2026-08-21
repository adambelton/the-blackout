import type { ReactNode } from "react";
import { brand as C } from "../lib/palette";

export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1
      style={{
        fontSize: "2.25rem",
        fontWeight: 300,
        letterSpacing: "-0.04em",
        lineHeight: 1.1,
        color: C.umber,
        margin: "0 0 2rem",
      }}
    >
      {children}
    </h1>
  );
}
