"use client";

import type { TtsVoiceRecord } from "@blackout/shared";
import { BROADCAST_TTS_PROVIDER_LABELS } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";

export function VoiceRecord({
  voice,
  onClick,
}: {
  voice: TtsVoiceRecord;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "14px 18px",
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        marginBottom: 8,
        background: "transparent",
        color: C.umber,
        cursor: "pointer",
        textAlign: "left",
        width: "100%",
        fontFamily: "inherit",
        transition: "border-color 180ms ease",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.driftwood; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.celadon; }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 2,
          }}
        >
          <span
            style={{
              fontSize: 15,
              fontWeight: 300,
              letterSpacing: "-0.02em",
              color: C.umber,
            }}
          >
            {voice.name}
          </span>
          {voice.isDefault ? (
            <span
              style={{
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: "0.12em",
                textTransform: "uppercase",
                color: C.forest,
                background: `${C.forest}14`,
                padding: "2px 6px",
                borderRadius: 100,
              }}
            >
              Default
            </span>
          ) : null}
        </div>
        <div
          style={{
            fontSize: 11,
            color: C.driftwood,
            marginTop: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {BROADCAST_TTS_PROVIDER_LABELS[voice.provider]}
          {voice.description ? ` · ${voice.description}` : ""}
        </div>
      </div>
      <div
        style={{
          fontSize: 11,
          color: C.stone,
          fontFamily: "ui-monospace, Menlo, monospace",
          flexShrink: 0,
        }}
      >
        {voice.speed != null ? `${voice.speed}×` : "1.0×"}
      </div>
    </button>
  );
}
