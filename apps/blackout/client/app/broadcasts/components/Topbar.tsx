"use client";

import Link from "next/link";
import { brand as C } from "../../lib/palette";

export function Topbar({
  isAdmin,
  onNewBroadcast,
}: {
  isAdmin: boolean;
  onNewBroadcast: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "flex-end",
        marginBottom: 32,
      }}
    >
      <div>
        <Link
          href="/"
          style={{
            fontSize: 13,
            color: C.stone,
            textDecoration: "none",
            transition: "color 160ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = C.umber; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = C.stone; }}
        >
          ← Home
        </Link>
        <h1
          style={{
            fontSize: 32,
            fontWeight: 300,
            letterSpacing: "-0.03em",
            margin: "6px 0 0",
            color: C.umber,
          }}
        >
          Broadcasts
        </h1>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {isAdmin && (
          <Link
            href="/admin/users"
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              color: C.umber,
              padding: "9px 16px",
              border: `0.5px solid ${C.celadon}`,
              borderRadius: 100,
              background: "transparent",
              textDecoration: "none",
              cursor: "pointer",
              transition: "border-color 180ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.driftwood; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.celadon; }}
          >
            Users
          </Link>
        )}
        {isAdmin && (
          <Link
            href="/admin/tts-voices"
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              color: C.umber,
              padding: "9px 16px",
              border: `0.5px solid ${C.celadon}`,
              borderRadius: 100,
              background: "transparent",
              textDecoration: "none",
              cursor: "pointer",
              transition: "border-color 180ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.driftwood; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.celadon; }}
          >
            Voices
          </Link>
        )}
        {isAdmin && (
          <Link
            href="/admin/radio-sources"
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              color: C.umber,
              padding: "9px 16px",
              border: `0.5px solid ${C.celadon}`,
              borderRadius: 100,
              background: "transparent",
              textDecoration: "none",
              cursor: "pointer",
              transition: "border-color 180ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = C.driftwood; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = C.celadon; }}
          >
            Radio sources
          </Link>
        )}
        {isAdmin && (
          <button
            type="button"
            onClick={onNewBroadcast}
            style={{
              fontFamily: "inherit",
              fontSize: 13,
              color: C.ivory,
              padding: "9px 18px",
              border: "none",
              borderRadius: 100,
              background: C.umber,
              cursor: "pointer",
              fontWeight: 500,
              transition: "background 180ms ease",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = C.forest; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = C.umber; }}
          >
            New broadcast
          </button>
        )}
      </div>
    </div>
  );
}
