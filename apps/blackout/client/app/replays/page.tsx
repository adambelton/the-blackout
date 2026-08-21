import Link from "next/link";
import type { Broadcast } from "@blackout/shared";
import { PublicLayout } from "../components/PublicLayout";
import { brand as C } from "../lib/palette";
import { formatMatchDateParts } from "../lib/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

async function fetchCompletedBroadcasts(): Promise<Broadcast[]> {
  try {
    const res = await fetch(`${API_URL}/broadcasts`, { cache: "no-store" });
    if (!res.ok) return [];
    const all: Broadcast[] = await res.json();
    return all
      .filter((b) => b.status === "complete")
      .sort((a, b) => new Date(b.matchDate).getTime() - new Date(a.matchDate).getTime());
  } catch {
    return [];
  }
}

export const metadata = {
  title: "Replays — The Blackout",
};

export default async function ReplaysPage() {
  const broadcasts = await fetchCompletedBroadcasts();

  return (
    <PublicLayout wordmark="compact">
      <style>{`
        .replay-card:hover { border-color: ${C.driftwood} !important; }
      `}</style>

      <h1
        style={{
          fontSize: "2rem",
          fontWeight: 300,
          letterSpacing: "-0.03em",
          margin: "0 0 0.375rem",
          color: C.umber,
        }}
      >
        Replays
      </h1>
      <p
        style={{
          fontSize: "0.9375rem",
          color: C.driftwood,
          margin: "0 0 2rem",
          lineHeight: 1.6,
        }}
      >
        Past broadcasts, available to replay in full.
      </p>

      {broadcasts.length === 0 ? (
        <p style={{ color: C.stone, fontSize: "0.9375rem" }}>
          No completed broadcasts yet.
        </p>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {broadcasts.map((b) => {
            const { date } = formatMatchDateParts(b.matchDate);
            return (
              <li key={b.id} style={{ marginBottom: 8 }}>
                <Link
                  href={`/matchroom/${b.id}`}
                  className="replay-card"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 16,
                    padding: "14px 18px",
                    border: `0.5px solid ${C.celadon}`,
                    borderRadius: 10,
                    textDecoration: "none",
                    color: C.umber,
                    transition: "border-color 180ms ease",
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: "0.9375rem",
                        fontWeight: 300,
                        letterSpacing: "-0.02em",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {b.homeTeam} vs {b.awayTeam}
                    </div>
                    <div style={{ fontSize: 12, color: C.driftwood, marginTop: 2 }}>
                      {b.competition} · {date}
                    </div>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      letterSpacing: "0.12em",
                      textTransform: "uppercase",
                      color: C.stone,
                      flexShrink: 0,
                    }}
                  >
                    Replay
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </PublicLayout>
  );
}
