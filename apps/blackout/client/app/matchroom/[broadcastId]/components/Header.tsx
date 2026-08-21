"use client";

import Link from "next/link";
import { brand as C } from "../../../lib/palette";
import { BrandMark } from "./BrandMark";
import { LiveBadge } from "./LiveBadge";

export function Header({ minuteLabel, live }: { minuteLabel: string; live: boolean }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
      <Link
        href="/"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          textDecoration: "none",
          color: "inherit",
          borderRadius: 8,
          transition: "opacity 160ms ease",
        }}
        aria-label="Back to The Blackout"
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.75"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
      >
        <BrandMark size={28} />
        <div style={{ fontSize: 18, fontWeight: 300, letterSpacing: "-0.02em", color: C.ivory }}>
          <span style={{ fontSize: 11, color: C.driftwood, display: "block", lineHeight: 1, marginBottom: 1 }}>
            The
          </span>
          Blackout
        </div>
      </Link>
      <LiveBadge label={minuteLabel} live={live} />
    </div>
  );
}
