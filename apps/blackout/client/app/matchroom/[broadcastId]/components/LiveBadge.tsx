"use client";

import { brand as C } from "../../../lib/palette";

export function LiveBadge({ label, live }: { label: string; live: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 10,
        fontWeight: 500,
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: live ? C.sage : C.driftwood,
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: live ? C.sage : C.driftwood,
          boxShadow: live ? `0 0 0 4px ${C.sage}33` : "none",
          animation: live ? "matchroom-pulse 1.8s ease-in-out infinite" : undefined,
          display: "inline-block",
        }}
      />
      {label}
      <style>{`@keyframes matchroom-pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.5 } }`}</style>
    </div>
  );
}
