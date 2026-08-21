"use client";

import { useState } from "react";
import { brand as C } from "../../../lib/palette";

export function Marginalia() {
  const [open, setOpen] = useState(false);
  const listenerCount = 1;

  return (
    <aside
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        height: "100vh",
        zIndex: 10,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          right: 0,
          bottom: 0,
          width: 1,
          background: C.celadon,
          opacity: 0.18,
        }}
      />

      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`Open the marginalia (${listenerCount} listening)`}
        className="mr-marginalia-trigger"
        style={{
          pointerEvents: open ? "none" : "auto",
          position: "absolute",
          right: 14,
          top: 225,
          background: "transparent",
          border: `0.5px solid ${C.celadon}33`,
          padding: "6px 10px",
          borderRadius: 999,
          color: C.driftwood,
          fontSize: 11,
          fontWeight: 400,
          fontVariantNumeric: "tabular-nums",
          letterSpacing: "0.04em",
          opacity: open ? 0 : 0.7,
          transition: "opacity 200ms ease-out",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontFamily: "inherit",
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: C.sage,
            display: "inline-block",
          }}
        />
        <span>{listenerCount}</span>
      </button>

      <div
        className={`mr-marginalia-panel${open ? " is-open" : ""}`}
        style={{
          pointerEvents: open ? "auto" : "none",
          position: "absolute",
          top: 0,
          right: open ? 0 : -288,
          width: 280,
          height: "100vh",
          background: C.umber,
          borderLeft: `0.5px solid ${C.celadon}33`,
          padding: "40px 28px",
          transition: "right 280ms cubic-bezier(0.34, 1.4, 0.64, 1), opacity 200ms ease-out",
          opacity: open ? 1 : 0,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <h2
            style={{
              fontSize: 11,
              fontWeight: 500,
              color: C.driftwood,
              letterSpacing: "0.16em",
              textTransform: "uppercase",
              margin: 0,
            }}
          >
            The Marginalia
          </h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close the marginalia"
            className="mr-marginalia-close"
            style={{
              background: "transparent",
              border: "none",
              color: C.driftwood,
              cursor: "pointer",
              fontSize: 18,
              fontWeight: 300,
              padding: "0 4px",
              lineHeight: 1,
              fontFamily: "inherit",
            }}
          >
            ×
          </button>
        </div>

        <p
          style={{
            fontSize: 13,
            color: C.driftwood,
            lineHeight: 1.7,
            fontWeight: 300,
            margin: 0,
          }}
        >
          A place for listeners to talk amongst themselves while the
          broadcast is in flight.{" "}
          <em style={{ fontStyle: "italic", color: C.stone }}>Coming soon.</em>
        </p>

        <div
          style={{
            marginTop: "auto",
            fontSize: 11,
            color: C.stone,
            display: "flex",
            alignItems: "center",
            gap: 6,
            letterSpacing: "0.04em",
          }}
        >
          <span
            style={{
              width: 5,
              height: 5,
              borderRadius: "50%",
              background: C.sage,
              display: "inline-block",
            }}
          />
          <span>{listenerCount} listening</span>
        </div>
      </div>
    </aside>
  );
}
