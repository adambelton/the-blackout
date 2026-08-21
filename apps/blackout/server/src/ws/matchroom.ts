import type { WebSocket as WsWebSocket } from "ws";
import { getBroadcast } from "../lib/broadcasts.js";
import { ensureRoomConductor } from "../conductor/index.js";
import { matchroomTransform } from "./matchroom-transform.js";

// Re-exported so existing consumers (broadcast-view) keep their import
// path stable. The implementation lives in matchroom-transform.ts so
// it can be unit-tested without dragging in the full server graph.
export { toViewerEntry, matchroomTransform } from "./matchroom-transform.js";

/**
 * Read-only WebSocket for the consumer matchroom.
 *
 * Thin subscriber to the per-broadcast RoomConductor. The conductor owns
 * the Kairos feed subscription, synthesis, scheduling and fan-out;
 * this handler just:
 *   1. Validates the broadcast exists, is live, and is linked to Kairos.
 *   2. Registers the socket with the conductor via a matchroom-specific
 *      transform (drops non-event feed entries, reshapes to viewer DTO).
 *   3. Ignores any inbound messages — viewers can't control the broadcast.
 *
 * The conductor emits `connected`, `narrative`, `preload`, `play`,
 * `generation_skipped`, and `feed_entry` cues. `feed_entry` goes through
 * `toViewerEntry` for the matchroom's audience; everything else passes
 * through as the conductor emits it.
 */
export function handleMatchroomConnection(
  ws: WsWebSocket,
  opts: { broadcastId: string | null },
): void {
  let unsubscribe: (() => void) | null = null;

  (async () => {
    if (!opts.broadcastId) {
      ws.send(JSON.stringify({ type: "error", message: "broadcastId query param is required" }));
      ws.close();
      return;
    }

    const broadcast = await getBroadcast(opts.broadcastId).catch(() => null);
    if (!broadcast) {
      ws.send(JSON.stringify({ type: "error", message: `Broadcast ${opts.broadcastId} not found` }));
      ws.close();
      return;
    }

    if (broadcast.status !== "live") {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Broadcast is not live — matchroom subscription requires an active broadcast",
        }),
      );
      ws.close();
      return;
    }

    if (!broadcast.kairosBroadcastId) {
      ws.send(JSON.stringify({ type: "error", message: "Broadcast has not been linked to Kairos" }));
      ws.close();
      return;
    }

    const conductor = await ensureRoomConductor(broadcast.id);
    if (!conductor) {
      ws.send(
        JSON.stringify({
          type: "error",
          message: "Room conductor unavailable — broadcast may have just ended",
        }),
      );
      ws.close();
      return;
    }

    unsubscribe = await conductor.addClient(ws, matchroomTransform);
  })().catch((err) => {
    console.error("[matchroom] init failed:", (err as Error).message);
    try {
      ws.send(JSON.stringify({ type: "error", message: `Init failed: ${(err as Error).message}` }));
    } catch {
      // socket already closed
    }
  });

  // Viewer clients don't send control messages. Any incoming message is
  // logged and ignored — the matchroom must never become a secondary
  // control surface by accident.
  ws.on("message", (data) => {
    console.log("[matchroom] ignoring client message:", data.toString().slice(0, 80));
  });

  ws.on("close", () => {
    unsubscribe?.();
    console.log("[ws] matchroom disconnected");
  });
}

