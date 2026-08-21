"use client";

import { brand as C } from "../../../lib/palette";
import type { BroadcastStatus, ServiceStatus } from "@blackout/shared";
import { ServicePill } from "./ServicePill";
import { BroadcastStatePill } from "./BroadcastStatePill";

export function StatusBar({
  services,
  status,
  connected,
}: {
  services: ServiceStatus[];
  status: BroadcastStatus;
  connected: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 18,
        padding: "10px 16px",
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        background: "#fff",
        flexWrap: "wrap",
      }}
    >
      <ServicePill
        label="Server"
        ok={connected}
        tooltip={connected ? "Blackout server reachable" : "Disconnected — retrying"}
      />
      <span style={{ width: 1, height: 14, background: C.celadon }} />
      {services.map((s) => (
        <ServicePill
          key={s.name}
          label={s.name}
          ok={s.status === "ok"}
          unconfigured={s.status === "unconfigured"}
          tooltip={s.message ?? s.status}
        />
      ))}
      <div style={{ marginLeft: "auto" }}>
        <BroadcastStatePill status={status} />
      </div>
    </div>
  );
}
