"use client";

import { brand as C } from "../../../lib/palette";

export function Fixture({
  home,
  away,
  competition,
  homeScore,
  awayScore,
  contentMinute,
  live,
}: {
  home: string;
  away: string;
  competition: string;
  homeScore: number;
  awayScore: number;
  contentMinute: string | null;
  live: boolean;
}) {
  return (
    <div className="mr-fixture" style={{ textAlign: "center", marginTop: 16 }}>
      <div
        className="mr-fixture-competition"
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: C.driftwood,
        }}
      >
        {competition || " "}
      </div>
      <div
        className="mr-fixture-headline"
        style={{
          fontSize: 40,
          fontWeight: 300,
          letterSpacing: "-0.04em",
          lineHeight: 1.1,
          color: C.ivory,
          marginTop: 8,
        }}
      >
        {home} vs {away}
      </div>

      <div
        className="mr-fixture-scoreline"
        style={{
          display: "grid",
          gridTemplateColumns: "1fr auto 1fr",
          gridTemplateRows: "auto auto auto",
          columnGap: 20,
          rowGap: 4,
          alignItems: "center",
          marginTop: 20,
        }}
      >
        <div
          className="mr-fixture-teamname"
          style={{ gridColumn: 1, gridRow: 1, justifySelf: "end", fontSize: 13, color: C.ivory, fontWeight: 500, letterSpacing: "0.04em" }}
        >
          {home}
        </div>
        <div
          className="mr-fixture-teamname"
          style={{ gridColumn: 3, gridRow: 1, justifySelf: "start", fontSize: 13, color: C.ivory, fontWeight: 500, letterSpacing: "0.04em" }}
        >
          {away}
        </div>

        <div
          className="mr-fixture-digit"
          style={{ gridColumn: 1, gridRow: 2, justifySelf: "end", fontSize: 32, fontWeight: 300, color: C.ivory, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", lineHeight: 1 }}
        >
          {homeScore}
        </div>
        <div
          className="mr-fixture-digit"
          style={{ gridColumn: 2, gridRow: 2, color: C.stone, fontSize: 32, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1 }}
        >
          —
        </div>
        <div
          className="mr-fixture-digit"
          style={{ gridColumn: 3, gridRow: 2, justifySelf: "start", fontSize: 32, fontWeight: 300, color: C.ivory, fontVariantNumeric: "tabular-nums", letterSpacing: "-0.02em", lineHeight: 1 }}
        >
          {awayScore}
        </div>

        <div
          className="mr-fixture-minute"
          style={{
            gridColumn: 2,
            gridRow: 3,
            fontSize: 11,
            fontWeight: 500,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: live ? C.sage : C.driftwood,
            marginTop: 4,
            opacity: contentMinute ? 1 : 0,
            transition: "opacity 240ms ease-out",
          }}
          aria-hidden={!contentMinute}
        >
          {contentMinute ?? " "}
        </div>
      </div>
    </div>
  );
}
