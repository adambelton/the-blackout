import type { CSSProperties } from "react";
import { brand as C } from "../lib/palette";

export function SectionRule({ style }: { style?: CSSProperties }) {
  return (
    <hr
      style={{
        border: 0,
        borderTop: `0.5px solid ${C.celadon}`,
        margin: "2rem 0",
        ...style,
      }}
    />
  );
}
