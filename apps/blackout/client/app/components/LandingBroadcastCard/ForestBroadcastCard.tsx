"use client";

import Link from "next/link";
import { brand as C } from "../../lib/palette";
import { formatMatchDateParts } from "../../lib/format";
import type { Broadcast } from "./types";

export function ForestBroadcastCard({ broadcast }: { broadcast: Broadcast }) {
  const isLive = broadcast.status === "live";
  const label = isLive ? "LIVE NOW" : formatDateLabel(broadcast.matchDate);
  const title = `${broadcast.homeTeam} vs ${broadcast.awayTeam}`;
  const subtitle = broadcast.competition;

  return (
    <Link
      href={`/matchroom/${broadcast.id}`}
      style={{
        display: "block",
        textDecoration: "none",
        marginBottom: "2.5rem",
      }}
      aria-label={`Enter the matchroom for ${title}`}
    >
      <article
        style={{
          background: C.forest,
          borderRadius: 12,
          padding: "1.25rem 1.5rem 1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.5rem",
          minHeight: 140,
          transition: "transform 160ms ease, box-shadow 160ms ease",
        }}
      >
        <div
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: isLive ? C.sage : C.celadon,
            ...(isLive
              ? { animation: "matchroom-card-pulse 1.8s ease-in-out infinite" }
              : {}),
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: "1.75rem",
            fontWeight: 300,
            letterSpacing: "-0.03em",
            lineHeight: 1.15,
            color: C.ivory,
            marginTop: 2,
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: "0.875rem",
            fontWeight: 400,
            color: C.celadon,
            opacity: 0.85,
          }}
        >
          {subtitle}
        </div>
        <div style={{ marginTop: "auto", paddingTop: "0.75rem" }}>
          <span
            style={{
              display: "inline-block",
              padding: "0.5rem 1rem",
              background: C.umber,
              color: C.sage,
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              borderRadius: 100,
            }}
          >
            Join room
          </span>
        </div>
      </article>
      <style>{`
        @keyframes matchroom-card-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.55 } }
      `}</style>
    </Link>
  );
}

function formatDateLabel(iso: string): string {
  const { date: datePart, time } = formatMatchDateParts(iso);
  if (!datePart && !time) return "SCHEDULED";

  const date = new Date(iso);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (sameDay) {
    const afternoon = date.getHours() >= 17;
    return `${afternoon ? "TONIGHT" : "TODAY"} · ${time}`;
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const isTomorrow =
    date.getFullYear() === tomorrow.getFullYear() &&
    date.getMonth() === tomorrow.getMonth() &&
    date.getDate() === tomorrow.getDate();
  if (isTomorrow) return `TOMORROW · ${time}`;

  return `${datePart.toUpperCase().replace(",", "")} · ${time}`;
}

