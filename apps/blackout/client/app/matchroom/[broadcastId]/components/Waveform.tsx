"use client";

import { brand as C } from "../../../lib/palette";

export function Waveform({ active }: { active: boolean }) {
  const heights = [6, 12, 8, 14, 7];
  return (
    <div style={{ display: "flex", gap: 2, alignItems: "center" }}>
      {heights.map((h, i) => (
        <span
          key={i}
          style={{
            width: 2,
            height: h,
            background: active ? C.sage : C.driftwood,
            borderRadius: 2,
            display: "inline-block",
            animation: active ? `matchroom-wave 1s ease-in-out ${i * 0.1}s infinite` : undefined,
            opacity: active ? 1 : 0.4,
          }}
        />
      ))}
      <style>{`@keyframes matchroom-wave { 0%,100% { transform: scaleY(0.5); } 50% { transform: scaleY(1); } }`}</style>
    </div>
  );
}
