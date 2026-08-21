"use client";

import type { BroadcastStatus } from "@blackout/shared";
import { brand } from "../lib/palette";

/**
 * Broadcast lifecycle pill — draft / scheduled / live / complete.
 * Spartan: uppercase track, colour only. Used in the header of the
 * content studio today; any surface that wants a compact status
 * indicator can drop this in without re-defining the mapping.
 */
export function StatusPill({ status }: { status: BroadcastStatus }) {
  const { label, color } = PALETTE[status];
  return (
    <span
      style={{
        fontSize: 10,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        fontWeight: 500,
        color,
      }}
    >
      {label}
    </span>
  );
}

const PALETTE: Record<BroadcastStatus, { label: string; color: string }> = {
  draft: { label: "Draft", color: brand.driftwood },
  scheduled: { label: "Scheduled", color: brand.forest },
  live: { label: "Live", color: brand.crimson },
  complete: { label: "Complete", color: brand.stone },
  archived: { label: "Archived", color: brand.stone },
};
