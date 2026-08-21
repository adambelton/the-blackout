"use client";

import Link from "next/link";
import { brand as C } from "../../../lib/palette";
import { PillButton } from "../../../components/PillButton";

export function Topbar({ onAdd }: { onAdd: () => void }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        marginBottom: 16,
      }}
    >
      <div>
        <Link
          href="/broadcasts"
          style={{
            fontSize: 13,
            color: C.stone,
            textDecoration: "none",
            transition: "color 160ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = C.umber; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = C.stone; }}
        >
          ← Broadcasts
        </Link>
        <h1
          style={{
            fontSize: 32,
            fontWeight: 300,
            letterSpacing: "-0.03em",
            margin: "6px 0 4px",
            color: C.umber,
          }}
        >
          TTS voices
        </h1>
        <p
          style={{
            fontSize: 13,
            color: C.driftwood,
            margin: 0,
            lineHeight: 1.5,
            maxWidth: 560,
          }}
        >
          Admin-curated voice catalogue. Writers pick from this list in the moderator console.
          The default voice is used when no voice has been selected for a broadcast.
        </p>
      </div>
      <PillButton variant="primary" onClick={onAdd}>Add voice</PillButton>
    </div>
  );
}
