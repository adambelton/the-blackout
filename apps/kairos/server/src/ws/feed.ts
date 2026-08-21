import type { WebSocket } from "ws";
import type { BroadcastRuntime } from "../broadcast.js";

/**
 * Handle a WebSocket subscription to a broadcast's feed.
 * Sends all existing entries as a sync batch, then streams new entries.
 * Read-only — the client subscribes, it doesn't write.
 */
export function handleFeedSubscription(ws: WebSocket, runtime: BroadcastRuntime): void {
  const entries = runtime.feed.getAll();
  ws.send(JSON.stringify({ type: "sync", entries }));

  runtime.subscribers.add(ws);

  ws.on("close", () => {
    runtime.subscribers.delete(ws);
    console.log(`[ws] feed subscriber disconnected from broadcast ${runtime.broadcastId}`);
  });

  console.log(`[ws] feed subscriber connected to broadcast ${runtime.broadcastId} (${entries.length} entries synced)`);
}
