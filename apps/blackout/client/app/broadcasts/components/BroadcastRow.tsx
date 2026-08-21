"use client";

import Link from "next/link";
import type { Broadcast } from "@blackout/shared";
import { brand as C } from "../../lib/palette";
import { formatMatchDateParts } from "../../lib/format";
import { StatusDot } from "./StatusDot";
import { StatusLabel } from "./StatusLabel";
import { AdminAction } from "./AdminAction";

export function BroadcastRow({
  broadcast: b,
  dimmed,
  isAdmin,
  onDelete,
  onArchive,
}: {
  broadcast: Broadcast;
  dimmed?: boolean;
  isAdmin: boolean;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
}) {
  const { date: dateStr, time: timeStr } = formatMatchDateParts(b.matchDate);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "14px 18px",
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        marginBottom: 8,
        opacity: dimmed ? 0.7 : 1,
        transition: "border-color 180ms ease",
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = C.driftwood; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = C.celadon; }}
    >
      <StatusDot status={b.status} />
      <Link
        href={`/moderator/${b.id}`}
        style={{
          flex: 1,
          minWidth: 0,
          textDecoration: "none",
          color: C.umber,
        }}
      >
        <div
          style={{
            fontSize: 15,
            fontWeight: 300,
            letterSpacing: "-0.02em",
            color: C.umber,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {b.homeTeam} vs {b.awayTeam}
        </div>
        <div style={{ fontSize: 12, color: C.driftwood, marginTop: 2 }}>
          {b.competition} · {dateStr} {timeStr}
        </div>
      </Link>
      <StatusLabel status={b.status} />
      {b.fixtureId && (
        <span
          style={{
            fontSize: 11,
            color: C.stone,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          #{b.fixtureId}
        </span>
      )}
      {isAdmin && (
        <div style={{ display: "flex", gap: 6 }}>
          {b.status === "complete" && (
            <AdminAction label="Archive" onClick={() => onArchive(b.id)} />
          )}
          {b.status !== "live" && b.status !== "archived" && (
            <AdminAction label="Delete" danger onClick={() => onDelete(b.id)} />
          )}
        </div>
      )}
    </div>
  );
}
