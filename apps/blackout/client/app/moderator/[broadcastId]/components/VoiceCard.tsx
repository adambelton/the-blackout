"use client";

import { brand as C } from "../../../lib/palette";
import { BROADCAST_TTS_PROVIDER_LABELS } from "@blackout/shared";
import type { BroadcastTtsProvider } from "@blackout/shared";

export function VoiceCard({
  name,
  description,
  provider,
  expanded,
  disabled,
  previewDisabled,
  onToggle,
  onPreview,
  previewLoading,
  previewPlaying,
}: {
  name: string;
  description: string | null;
  provider: BroadcastTtsProvider | undefined;
  expanded: boolean;
  disabled: boolean;
  previewDisabled: boolean;
  onToggle: () => void;
  onPreview: () => void;
  previewLoading: boolean;
  previewPlaying: boolean;
}) {
  const initials = name.slice(0, 2).toUpperCase();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "10px 12px",
        borderRadius: 8,
        border: `0.5px solid ${expanded ? C.driftwood : C.celadon}`,
        background: "#fff",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "border-color 160ms ease",
        opacity: disabled ? 0.55 : 1,
      }}
      onClick={() => { if (!disabled) onToggle(); }}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); }
      }}
    >
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          background: C.celadon,
          display: "grid",
          placeItems: "center",
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: "0.04em",
          color: C.forest,
          flexShrink: 0,
        }}
      >
        {initials}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
            color: C.umber,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {name}
        </div>
        {provider ? (
          <div style={{ fontSize: 11, color: C.stone, letterSpacing: "0.02em" }}>
            {BROADCAST_TTS_PROVIDER_LABELS[provider]}
            {description ? ` · ${description}` : ""}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        disabled={previewDisabled}
        onClick={(e) => {
          e.stopPropagation();
          if (previewDisabled) return;
          onPreview();
        }}
        style={{
          fontFamily: "inherit",
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.stone,
          padding: "5px 10px",
          border: `0.5px solid ${C.celadon}`,
          borderRadius: 100,
          background: "transparent",
          cursor: previewDisabled ? "not-allowed" : "pointer",
          transition: "color 160ms ease, border-color 160ms ease",
        }}
        onMouseEnter={(e) => {
          if (previewDisabled) return;
          e.currentTarget.style.color = C.umber;
          e.currentTarget.style.borderColor = C.driftwood;
        }}
        onMouseLeave={(e) => {
          if (previewDisabled) return;
          e.currentTarget.style.color = C.stone;
          e.currentTarget.style.borderColor = C.celadon;
        }}
      >
        {previewLoading ? "…" : previewPlaying ? "Playing" : "▶ Preview"}
      </button>
    </div>
  );
}
