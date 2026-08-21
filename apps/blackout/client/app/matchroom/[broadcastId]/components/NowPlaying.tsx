"use client";

import type { CSSProperties } from "react";
import { brand as C } from "../../../lib/palette";
import { TunerIcon } from "./TunerIcon";
import { Waveform } from "./Waveform";

export function NowPlaying({
  radioOn,
  onTurnOn,
  voiceLabel,
  playing,
  ttsEnabled,
}: {
  radioOn: boolean;
  onTurnOn: () => void;
  voiceLabel: string;
  playing: boolean;
  ttsEnabled: boolean;
}) {
  const pillStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "14px 18px",
    background: "rgba(255,255,255,0.03)",
    border: `0.5px solid ${C.celadon}1F`,
    borderRadius: 100,
    maxWidth: 460,
    margin: "0 auto",
    width: "100%",
    boxSizing: "border-box",
  };

  if (!ttsEnabled) {
    return (
      <div style={{ ...pillStyle, cursor: "default", justifyContent: "center" }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.driftwood,
          }}
        >
          Text only
        </span>
        <span style={{ fontSize: 12, color: C.celadon, opacity: 0.7 }}>
          Narration appears below; audio is off for this broadcast.
        </span>
      </div>
    );
  }

  if (!radioOn) {
    return (
      <button
        type="button"
        onClick={onTurnOn}
        style={{
          ...pillStyle,
          cursor: "pointer",
          color: C.ivory,
          fontFamily: "inherit",
          textAlign: "left",
          transition: "background 160ms ease, border-color 160ms ease",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.06)";
          e.currentTarget.style.borderColor = `${C.sage}66`;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = "rgba(255,255,255,0.03)";
          e.currentTarget.style.borderColor = `${C.celadon}1F`;
        }}
        aria-label="Tune in to the author's voice"
      >
        <TunerIcon color={C.sage} size={14} />
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: C.sage,
          }}
        >
          Tune in
        </span>
        <span style={{ fontSize: 12, color: C.celadon, flex: 1 }}>
          The Author&rsquo;s Voice
        </span>
        <Waveform active={false} />
      </button>
    );
  }

  return (
    <div style={pillStyle}>
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: playing ? C.sage : C.driftwood,
        }}
      />
      <span
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: playing ? C.sage : C.driftwood,
        }}
      >
        Now
      </span>
      <span style={{ fontSize: 12, color: C.celadon, flex: 1 }}>{voiceLabel}</span>
      <Waveform active={playing} />
    </div>
  );
}
