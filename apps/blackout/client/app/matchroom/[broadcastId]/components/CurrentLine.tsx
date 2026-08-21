"use client";

import { brand as C } from "../../../lib/palette";

export const TYPEWRITER_LINE_HEIGHT_PX = 31;
export const TYPEWRITER_VISIBLE_LINES = 5;
export const TYPEWRITER_HEIGHT_PX = TYPEWRITER_VISIBLE_LINES * TYPEWRITER_LINE_HEIGHT_PX;

export function CurrentLine({
  text,
  visibleChars,
  isPlaying,
}: {
  text: string;
  visibleChars: number;
  isPlaying: boolean;
}) {
  const revealed = text.slice(0, Math.max(0, visibleChars));
  const prefix = revealed.slice(0, -1);
  const lastChar = revealed.slice(-1);

  return (
    <span style={{ whiteSpace: "pre" }}>
      {prefix}
      {lastChar ? (
        <span
          key={visibleChars}
          style={{ animation: "matchroom-char-strike 90ms ease-out" }}
        >
          {lastChar}
        </span>
      ) : null}
      {isPlaying ? (
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 2,
            height: 16,
            marginLeft: 2,
            marginBottom: -2,
            background: C.driftwood,
            opacity: 0.6,
            animation: "matchroom-cursor 1s ease-in-out infinite",
            borderRadius: 1,
          }}
        />
      ) : null}
    </span>
  );
}
