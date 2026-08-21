"use client";

import type { Broadcast, BroadcastStatus } from "@blackout/shared";
import { PageHeader } from "../../../components/PageHeader";
import { QuickLink } from "./QuickLink";
import { TransitionButton } from "./TransitionButton";
import { pillStyles } from "./utils";

export function Topbar({
  broadcast,
  status,
  scheduleBlockers,
  goLiveBlockers,
  connected,
  isActivating,
  isAdmin,
  captureActive,
  onSchedule,
  onGoLive,
  onEnd,
  onResumeCapture,
}: {
  broadcast: Broadcast | null;
  status: BroadcastStatus;
  scheduleBlockers: string[];
  goLiveBlockers: string[];
  connected: boolean;
  isActivating: boolean;
  isAdmin: boolean;
  captureActive: boolean;
  onSchedule: () => void;
  onGoLive: () => void;
  onEnd: () => void;
  onResumeCapture: () => void;
}) {
  // Surface a "Resume capture" affordance when the broadcast is live
  // server-side but the browser isn't capturing. Happens after a tab
  // refresh / navigation away — MediaRecorder needs a fresh user
  // gesture to restart, so the moderator has to click. Without this
  // button there's no recovery path short of ending and restarting
  // the broadcast.
  const showResume = status === "live" && !captureActive;
  return (
    <div style={{ marginBottom: 24 }}>
      <PageHeader
        back={{ href: "/broadcasts", label: "Broadcasts" }}
        title="Moderator console"
        broadcast={broadcast}
        border={false}
        paddingBottom={0}
      >
        <QuickLink
          href={broadcast ? `/studio/${broadcast.id}` : undefined}
          label="Studio ↗"
          title="Open the content studio in a new tab"
        />
        <QuickLink
          href={broadcast ? `/matchroom/${broadcast.id}` : undefined}
          label="Matchroom ↗"
          title="Open the matchroom in a new tab"
        />
        {isAdmin ? (
          <QuickLink
            href={broadcast ? `/inspector/${broadcast.id}` : undefined}
            label="Inspector ↗"
            title="Open the pipeline inspector in a new tab"
          />
        ) : null}
        {showResume ? (
          <button
            type="button"
            onClick={onResumeCapture}
            title="Re-arm browser audio capture for this live broadcast"
            style={pillStyles("primary")}
          >
            Resume capture
          </button>
        ) : null}
        <TransitionButton
          status={status}
          scheduleBlockers={scheduleBlockers}
          goLiveBlockers={goLiveBlockers}
          connected={connected}
          isActivating={isActivating}
          onSchedule={onSchedule}
          onGoLive={onGoLive}
          onEnd={onEnd}
        />
      </PageHeader>
    </div>
  );
}
