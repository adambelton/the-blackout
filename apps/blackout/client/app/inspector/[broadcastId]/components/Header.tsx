"use client";

import type { Broadcast, BroadcastHealth } from "@blackout/shared";
import { PageHeader } from "../../../components/PageHeader";
import { BriefField } from "./BriefField";
import { FlowHealthRow } from "./FlowHealthRow";

export function Header({
  broadcast,
  voice,
  context,
  broadcastId,
  health,
}: {
  broadcast: Broadcast | null;
  voice: string;
  context: string;
  broadcastId: string;
  health: BroadcastHealth | null;
}) {
  return (
    <div style={{ padding: "24px 32px 0" }}>
      <PageHeader
        back={{ href: `/moderator/${broadcastId}`, label: "Moderator" }}
        title="Pipeline inspector"
        broadcast={broadcast}
      >
        <BriefField label="id" value={broadcastId.slice(0, 8) + "…"} mono />
        <BriefField label="voice" value={voice || "—"} />
        <BriefField label="context" value={context || "—"} />
      </PageHeader>
      <FlowHealthRow health={health} />
    </div>
  );
}
