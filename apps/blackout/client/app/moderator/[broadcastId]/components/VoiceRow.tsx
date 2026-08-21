"use client";

import { brand as C } from "../../../lib/palette";
import type { TtsVoice } from "./types";

export function VoiceRow({
  voice,
  selected,
  rowRef,
  onSelect,
  onPreview,
  previewLoading,
  previewPlaying,
}: {
  voice: TtsVoice;
  selected: boolean;
  // Only attached to the currently-selected voice so the picker can
  // scroll it into view when opened. Undefined for unselected rows.
  rowRef?: React.RefObject<HTMLDivElement | null>;
  onSelect: () => void;
  onPreview: () => void;
  previewLoading: boolean;
  previewPlaying: boolean;
}) {
  return (
    <div
      ref={rowRef}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 14px",
        borderTop: `0.5px solid ${C.celadon}60`,
        background: selected ? `${C.forest}0C` : "transparent",
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: selected ? C.forest : C.umber,
          }}
        >
          {voice.name}
        </div>
        {voice.description ? (
          <div style={{ fontSize: 11, color: C.stone }}>{voice.description}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onPreview}
        style={{
          fontFamily: "inherit",
          fontSize: 10,
          color: C.stone,
          padding: "3px 8px",
          border: "none",
          background: "transparent",
          cursor: "pointer",
        }}
      >
        {previewLoading ? "…" : previewPlaying ? "Playing" : "▶"}
      </button>
      {selected ? (
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.forest,
          }}
        >
          Selected
        </span>
      ) : (
        <button
          type="button"
          onClick={onSelect}
          style={{
            fontFamily: "inherit",
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.driftwood,
            padding: "3px 8px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          Select
        </button>
      )}
    </div>
  );
}
