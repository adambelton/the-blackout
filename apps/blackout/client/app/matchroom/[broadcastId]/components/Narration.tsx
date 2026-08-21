"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { brand as C } from "../../../lib/palette";
import {
  CurrentLine,
  TYPEWRITER_HEIGHT_PX,
  TYPEWRITER_LINE_HEIGHT_PX,
  TYPEWRITER_VISIBLE_LINES,
} from "./CurrentLine";
import type { Narrative } from "./types";

function splitTextIntoLines(text: string, container: HTMLElement): string[] {
  if (!text.trim()) return [];

  const tokens = text.match(/(\s+|\S+)/g) ?? [];
  if (tokens.length === 0) return [];

  const styles = window.getComputedStyle(container);
  const ghost = document.createElement("div");
  ghost.style.position = "absolute";
  ghost.style.visibility = "hidden";
  ghost.style.left = "-9999px";
  ghost.style.top = "0";
  ghost.style.width = `${container.clientWidth}px`;
  ghost.style.fontFamily = styles.fontFamily;
  ghost.style.fontSize = styles.fontSize;
  ghost.style.fontWeight = styles.fontWeight;
  ghost.style.lineHeight = styles.lineHeight;
  ghost.style.letterSpacing = styles.letterSpacing;
  ghost.style.padding = "0";
  ghost.style.margin = "0";
  ghost.style.whiteSpace = "pre-wrap";
  ghost.style.wordBreak = "normal";

  const spans: HTMLSpanElement[] = [];
  for (const token of tokens) {
    const s = document.createElement("span");
    s.textContent = token;
    ghost.appendChild(s);
    spans.push(s);
  }

  document.body.appendChild(ghost);

  const lines: string[] = [];
  let currentLineText = "";
  let currentTop: number | null = null;
  for (let i = 0; i < spans.length; i++) {
    const top = spans[i].offsetTop;
    if (currentTop === null || Math.abs(top - currentTop) < 1) {
      currentLineText += tokens[i];
      currentTop = top;
    } else {
      lines.push(currentLineText);
      currentLineText = tokens[i];
      currentTop = top;
    }
  }
  if (currentLineText) lines.push(currentLineText);

  document.body.removeChild(ghost);
  return lines;
}

export function Narration({
  current,
  revealRatio,
  isPlaying,
  isReplay,
}: {
  current: Narrative | null;
  revealRatio: number;
  isPlaying: boolean;
  isReplay?: boolean;
}) {
  const text = current?.text ?? "";
  const visibleChars = Math.floor(revealRatio * text.length);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [allLines, setAllLines] = useState<string[]>([]);
  const passageStartIdxRef = useRef(0);
  const lastPassageIdRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container || !text || !current) return;
    if (current.id === lastPassageIdRef.current) return;
    const newLines = splitTextIntoLines(text, container);
    passageStartIdxRef.current = allLines.length;
    setAllLines((prev) => [...prev, ...newLines]);
    lastPassageIdRef.current = current.id;
  }, [text, current?.id, allLines.length]);

  const passageStart = passageStartIdxRef.current;
  const currentPassageLines = allLines.slice(passageStart);
  let charsLeft = visibleChars;
  let currentLineIdxInPassage = 0;
  for (let i = 0; i < currentPassageLines.length; i++) {
    if (charsLeft >= currentPassageLines[i].length && i < currentPassageLines.length - 1) {
      charsLeft -= currentPassageLines[i].length;
      currentLineIdxInPassage = i + 1;
    } else {
      currentLineIdxInPassage = i;
      break;
    }
  }
  const activeIdx = passageStart + currentLineIdxInPassage;
  const visibleInCurrent =
    currentPassageLines.length === 0
      ? 0
      : Math.max(
          0,
          Math.min(currentPassageLines[currentLineIdxInPassage].length, charsLeft),
        );

  return (
    <div style={{ padding: "0 8px", width: "100%" }}>
      <div
        ref={containerRef}
        style={{
          height: TYPEWRITER_HEIGHT_PX,
          overflow: "hidden",
          display: "block",
          fontSize: 17,
          fontWeight: 300,
          lineHeight: `${TYPEWRITER_LINE_HEIGHT_PX}px`,
          letterSpacing: "-0.01em",
          color: C.ivory,
          textAlign: "left",
          position: "relative",
        }}
      >
        {current && allLines.length > 0 ? (
          (() => {
            const visibleLineCount = TYPEWRITER_VISIBLE_LINES;
            return allLines.map((line, i) => {
              const fromBottom = activeIdx - i;
              if (fromBottom < 0 || fromBottom > visibleLineCount) return null;
              const isCurrent = i === activeIdx;
              const fade = 1 - fromBottom / (visibleLineCount + 1);
              return (
                <div
                  key={i}
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: fromBottom * TYPEWRITER_LINE_HEIGHT_PX,
                    height: TYPEWRITER_LINE_HEIGHT_PX,
                    opacity: Math.max(0, fade),
                    transition:
                      "bottom 260ms cubic-bezier(0.85, 0, 0.15, 1), opacity 260ms ease-out",
                  }}
                >
                  {isCurrent ? (
                    <CurrentLine
                      text={line}
                      visibleChars={visibleInCurrent}
                      isPlaying={isPlaying}
                    />
                  ) : (
                    line
                  )}
                </div>
              );
            });
          })()
        ) : isReplay ? null : (
          <span style={{ color: C.driftwood, opacity: 0.55 }}>
            The narrator hasn&rsquo;t taken a first breath yet. Passages will appear here as they&rsquo;re generated.
          </span>
        )}
      </div>
      <style>{`
        @keyframes matchroom-cursor {
          0%, 100% { opacity: 0.2; }
          50% { opacity: 0.8; }
        }
        @keyframes matchroom-char-strike {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}
