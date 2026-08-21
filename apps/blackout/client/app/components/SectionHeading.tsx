import type { ReactNode } from "react";
import { brand as C } from "../lib/palette";

export function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2
      style={{
        fontSize: "1.5rem",
        fontWeight: 300,
        letterSpacing: "-0.03em",
        lineHeight: 1.3,
        color: C.forest,
        margin: "0 0 1rem",
      }}
    >
      {children}
    </h2>
  );
}
