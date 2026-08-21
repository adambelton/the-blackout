"use client";

import type { RadioSource } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { Stat } from "./Stat";

export function SourceRow({
  source,
  onClick,
}: {
  source: RadioSource;
  onClick: () => void;
}) {
  const observed =
    source.lastObservedOffsetSeconds != null
      ? `${source.lastObservedOffsetSeconds.toFixed(1)}s · ${source.observationCount} obs`
      : null;

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
            fontSize: 15,
            fontWeight: 300,
            letterSpacing: "-0.02em",
            color: C.umber,
          }}
        >
          {source.name}
        </div>
        <div
          style={{
            fontSize: 11,
            color: C.driftwood,
            marginTop: 2,
            fontFamily: "ui-monospace, Menlo, monospace",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {source.streamUrl}
        </div>
      </div>
      <Stat label="Offset" value={`${source.defaultOffsetSeconds}s`} />
      <Stat label="Observed" value={observed ?? "—"} />
    </button>
  );
}
