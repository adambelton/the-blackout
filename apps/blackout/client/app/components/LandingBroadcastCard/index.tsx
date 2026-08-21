"use client";

import { useEffect, useState } from "react";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { apiGet } from "@/lib/api";
import { routes } from "@/lib/routes";
import type { Broadcast } from "./types";
import { ForestBroadcastCard } from "./ForestBroadcastCard";

export function LandingBroadcastCard() {
  const enabled = useFeatureFlagEnabled("matchroom-enabled");
  const [broadcastQuery, setBroadcastQuery] = useState<{
    status: "idle" | "loading" | "settled";
    broadcast: Broadcast | null;
  }>({ status: "idle", broadcast: null });

  useEffect(() => {
    if (!enabled) return;

    setBroadcastQuery({ status: "loading", broadcast: null });
    const controller = new AbortController();
    apiGet<Broadcast[]>(routes.broadcasts.list(), { signal: controller.signal })
      .then((list) =>
        setBroadcastQuery({ status: "settled", broadcast: pickNextBroadcast(list) }),
      )
      .catch(() => setBroadcastQuery({ status: "settled", broadcast: null }));

    return () => controller.abort();
  }, [enabled]);

  if (enabled && broadcastQuery.broadcast) {
    return <ForestBroadcastCard broadcast={broadcastQuery.broadcast} />;
  }
  if (enabled && broadcastQuery.status !== "settled") return null;
  if (enabled === undefined) return null;
  return null;
}

function pickNextBroadcast(list: Broadcast[]): Broadcast | null {
  if (!Array.isArray(list)) return null;
  const live = list.find((b) => b.status === "live");
  if (live) return live;

  const now = Date.now();
  const upcoming = list
    .filter(
      (b) =>
        b.status === "scheduled" &&
        !isNaN(Date.parse(b.matchDate)) &&
        Date.parse(b.matchDate) >= now,
    )
    .sort((a, b) => Date.parse(a.matchDate) - Date.parse(b.matchDate));

  return upcoming[0] ?? null;
}
