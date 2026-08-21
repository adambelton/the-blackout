"use client";

import { brand as C } from "../../../lib/palette";
import { eventLabel, eventText, formatMinute } from "../derivations";
import type { ViewerEvent } from "../derivations";

export function EventRow({ event }: { event: ViewerEvent }) {
  const kind = event.eventType;
  const isRed = kind === "RED_CARD";
  const label = eventLabel(kind);
  const text = eventText(event);
  const timeLabel = formatMinute(event.minute, event.extraMinute, event.contentTime);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "10px 16px",
        border: `0.5px solid ${C.celadon}1F`,
        borderRadius: 8,
        animation: "matchroom-card-entrance 520ms ease-out",
      }}
    >
      <span
        style={{
          fontSize: 11,
          color: C.driftwood,
          fontWeight: 500,
          width: 36,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.04em",
        }}
      >
        {timeLabel}
      </span>
      <span
        style={{
          fontSize: 10,
          color: isRed ? "#C47A6A" : C.sage,
          fontWeight: 500,
          letterSpacing: "0.12em",
          textTransform: "uppercase",
          width: 84,
        }}
      >
        {label}
      </span>
      <span style={{ fontSize: 13, color: C.ivory, fontWeight: 300, flex: 1 }}>{text}</span>
    </div>
  );
}
