"use client";

import { brand as C } from "../../../lib/palette";

export function GenerationPauseBanner({
  pause,
  now,
}: {
  pause: { reason: string; retryAt: number | null; triggerReason?: string };
  now: number;
}) {
  const remaining =
    pause.retryAt != null ? Math.max(0, Math.ceil((pause.retryAt - now) / 1000)) : null;
  return (
    <div
      style={{
        marginTop: 12,
        padding: "10px 14px",
        border: `0.5px solid ${C.warn}40`,
        background: `${C.warn}14`,
        color: C.warn,
        borderRadius: 10,
        fontSize: 13,
      }}
    >
      <strong style={{ fontWeight: 500 }}>Generation paused</strong>
      {" · "}
      {pause.reason}
      {pause.triggerReason ? ` (${pause.triggerReason})` : ""}
      {remaining != null ? ` · retry in ${remaining}s` : ""}
    </div>
  );
}
