import type { WebSocket as WsWebSocket } from "ws";
import type { KairosFeedEntry } from "../lib/kairos.js";
import { activateBroadcast, completeBroadcast } from "../lib/kairos-bridge.js";
import { ensureRoomConductor } from "../conductor/index.js";
import { getBroadcast } from "../lib/broadcasts.js";
import {
  pushAudioChunkToRunner,
  pushModeratorMessageToRunner,
} from "../lib/broadcast-runner.js";
import { checkServices } from "../lib/services.js";
import { toFeedEntry } from "./moderator-feed-shape.js";

// Re-exported so the bootstrap builder (apps/blackout/server/src/lib/moderator-view.ts)
// and any future consumer can import the shape mapper from a single
// well-known location alongside the WS handler that uses it. Implementation
// lives in moderator-feed-shape.ts so it can be tested in isolation.
export { toFeedEntry } from "./moderator-feed-shape.js";

/**
 * Handles an incoming WebSocket connection from the moderator client.
 *
 * Thin subscriber to the per-broadcast RoomConductor — same shape as
 * the matchroom WS, but with a control surface for activation,
 * completion, and moderator-typed notes. Source ownership
 * (Sportmonks polling, Deepgram transcription, pressure derivation,
 * latency-sample correlation) belongs to the BroadcastRunner; the
 * moderator WS is read-only against the runner-driven pipeline.
 */
export function handleModeratorConnection(
  ws: WsWebSocket,
  opts: { broadcastId: string | null },
): void {
  let conductorUnsubscribe: (() => void) | null = null;
  let broadcastActive = false;
  let binaryFrameCount = 0;

  /**
   * Attach this moderator WS to the broadcast's RoomConductor — one
   * conductor per live broadcast owns the Kairos feed subscription and
   * fans out `feed_entry`, `narrative`, `preload`, `play`,
   * `phase`, `generation_skipped`, and `latency_sample` cues to every
   * connected client. The moderator-specific transform reshapes raw
   * Kairos feed entries via `toFeedEntry` before they reach the UI.
   *
   * Safe to call repeatedly — a prior subscription is torn down first.
   * Only meaningful once the broadcast is live; conductors aren't
   * created for pending broadcasts.
   */
  const subscribeToConductor = async () => {
    if (!opts.broadcastId) return;
    if (conductorUnsubscribe) {
      conductorUnsubscribe();
      conductorUnsubscribe = null;
    }
    const conductor = await ensureRoomConductor(opts.broadcastId);
    if (!conductor) return;
    conductorUnsubscribe = await conductor.addClient(ws, (cue) => {
      if (!cue || typeof cue !== "object") return cue;
      const c = cue as { type?: string; entry?: unknown };
      if (c.type === "feed_entry") {
        const ui = toFeedEntry(c.entry as KairosFeedEntry);
        if (!ui) return null;
        return { type: "feed_entry", entry: ui };
      }
      return cue;
    });
  };

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

    if (!broadcast.kairosBroadcastId) {
      ws.send(JSON.stringify({ type: "error", message: "Broadcast has not been linked to Kairos" }));
      ws.close();
      return;
    }

    broadcastActive = broadcast.status === "live";
    ws.send(JSON.stringify({ type: "connected", broadcast }));

    // Conductors only exist for live broadcasts — if the moderator is
    // connecting to a pending broadcast, skip the subscription; the
    // activate_broadcast handler will subscribe once it's live.
    if (broadcastActive) await subscribeToConductor();
  })().catch((err) => {
    console.error("[moderator] init failed:", err.message);
    ws.send(JSON.stringify({ type: "error", message: `Init failed: ${err.message}` }));
  });

  checkServices().then((services) => {
    ws.send(JSON.stringify({ type: "service_status", services }));
    for (const s of services) {
      console.log(`[services] ${s.name}: ${s.status}${s.message ? ` (${s.message})` : ""}`);
    }
  });

  ws.on("message", async (data, isBinary) => {
    // Binary frames are audio chunks captured in the moderator's
    // browser and forwarded to the broadcast runner's Deepgram pipe.
    // Pre-activation chunks (capture starts as soon as audio is
    // playing) are silently dropped — the runner registry doesn't have
    // an entry for the broadcast yet, and that's fine.
    if (isBinary) {
      if (!opts.broadcastId) return;
      const buf = Buffer.isBuffer(data)
        ? data
        : Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.from(data as ArrayBuffer);
      const ok = pushAudioChunkToRunner(opts.broadcastId, buf);
      // Diagnostic — sample-logged so we don't spam (every 20 chunks
      // = ~5s at 250ms timeslice).
      binaryFrameCount++;
      if (binaryFrameCount % 20 === 0) {
        console.log(
          `[ws] binary frames received for ${opts.broadcastId.slice(0, 8)}: ${binaryFrameCount}, last=${buf.length}b, routed=${ok}`,
        );
      }
      return;
    }

    try {
      const message = JSON.parse(data.toString());

      if (message.type === "activate_broadcast") {
        if (broadcastActive) {
          ws.send(JSON.stringify({ type: "broadcast_status", status: "live" }));
          return;
        }
        try {
          const updated = await activateBroadcast(opts.broadcastId!);
          broadcastActive = updated.status === "live";
          ws.send(
            JSON.stringify({ type: "broadcast_status", status: updated.status, broadcast: updated }),
          );
          // Broadcast is now live — activateBroadcast started the runner
          // and ensured the conductor exists. Subscribe this moderator WS
          // to the conductor's fan-out so entries, narratives, and
          // playback cues start flowing back to the UI.
          if (broadcastActive) await subscribeToConductor();
          console.log(`[moderator] activated broadcast ${updated.id}`);
        } catch (err) {
          console.error("[moderator] activation failed:", (err as Error).message);
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Activation failed: ${(err as Error).message}`,
            }),
          );
        }
        return;
      }

      if (message.type === "complete_broadcast") {
        try {
          const updated = await completeBroadcast(opts.broadcastId!);
          broadcastActive = false;
          ws.send(
            JSON.stringify({ type: "broadcast_status", status: updated.status, broadcast: updated }),
          );
          console.log(`[moderator] completed broadcast ${updated.id}`);
        } catch (err) {
          console.error("[moderator] completion failed:", (err as Error).message);
          ws.send(
            JSON.stringify({
              type: "error",
              message: `Completion failed: ${(err as Error).message}`,
            }),
          );
        }
        return;
      }

      if (message.type === "moderator_message") {
        const text = typeof message.text === "string" ? message.text.trim() : "";
        if (!text) return;
        const accepted = pushModeratorMessageToRunner(opts.broadcastId!, text);
        if (!accepted) {
          ws.send(
            JSON.stringify({
              type: "error",
              message: "Moderator message dropped — broadcast is not live",
            }),
          );
        }
      }
    } catch {
      console.error("[ws] failed to parse message:", data.toString());
    }
  });

  ws.on("close", () => {
    conductorUnsubscribe?.();
    conductorUnsubscribe = null;
    console.log("[ws] moderator disconnected");
  });
}
