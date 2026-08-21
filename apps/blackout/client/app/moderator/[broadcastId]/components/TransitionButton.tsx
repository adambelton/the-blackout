"use client";

import { brand as C } from "../../../lib/palette";
import type { BroadcastStatus } from "@blackout/shared";
import { pillStyles } from "./utils";

export function TransitionButton({
  status,
  scheduleBlockers,
  goLiveBlockers,
  connected,
  isActivating,
  onSchedule,
  onGoLive,
  onEnd,
}: {
  status: BroadcastStatus;
  scheduleBlockers: string[];
  goLiveBlockers: string[];
  connected: boolean;
  isActivating: boolean;
  onSchedule: () => void;
  onGoLive: () => void;
  onEnd: () => void;
}) {
  if (status === "draft") {
    const blocked = scheduleBlockers.length > 0;
    return (
      <button
        type="button"
        onClick={onSchedule}
        disabled={blocked}
        title={blocked ? `Blocked — ${scheduleBlockers.join("; ")}` : "Schedule broadcast"}
        style={pillStyles(blocked ? "ghostDisabled" : "ghost")}
      >
        Schedule broadcast
      </button>
    );
  }
  if (status === "scheduled") {
    const blocked = goLiveBlockers.length > 0;
    const disabled = blocked || !connected || isActivating;
    const label = isActivating ? "Activating…" : "Go live";
    const title = blocked
      ? `Blocked — ${goLiveBlockers.join("; ")}`
      : !connected
        ? "Waiting for WS…"
        : isActivating
          ? "Kairos is initialising — this takes ~15s"
          : "Activate broadcast";
    return (
      <button
        type="button"
        onClick={onGoLive}
        disabled={disabled}
        title={title}
        style={pillStyles(disabled ? "ghostDisabled" : "primary")}
      >
        {label}
      </button>
    );
  }
  if (status === "live") {
    return (
      <button
        type="button"
        onClick={onEnd}
        disabled={!connected}
        title={connected ? "Complete the broadcast" : "Waiting for WS…"}
        style={pillStyles("destructive")}
      >
        End broadcast
      </button>
    );
  }
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: "0.12em",
        textTransform: "uppercase",
        color: C.stone,
      }}
    >
      Broadcast complete
    </div>
  );
}
