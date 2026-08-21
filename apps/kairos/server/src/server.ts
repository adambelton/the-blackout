// rail-trigger: watched-paths needs packages/** for cross-workspace changes
import "./env.js";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { timingSafeEqual } from "node:crypto";
import { sql } from "./db/client.js";
import { createApp } from "./app.js";
import { ensureRuntime } from "./broadcast.js";
import { handleFeedSubscription } from "./ws/feed.js";

const app = createApp();
const port = parseInt(process.env.PORT || "5050", 10);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[kairos] listening on http://localhost:${info.port}`);
});

// WS upgrade requests don't go through Hono middleware, so gate them
// here with the same Bearer-token check. `noServer: true` lets us
// inspect the request before upgrading; unauthorized handshakes are
// rejected at the HTTP layer rather than accepted and then closed.
const wss = new WebSocketServer({ noServer: true });

function validApiKeys(): string[] {
  return (process.env.KAIROS_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function hasValidKey(presented: string | null): boolean {
  if (!presented) return false;
  const keys = validApiKeys();
  if (keys.length === 0) return false;
  const p = Buffer.from(presented);
  return keys.some((valid) => {
    const v = Buffer.from(valid);
    return v.length === p.length && timingSafeEqual(v, p);
  });
}

(server as Server).on("upgrade", (req, socket, head) => {
  const match = req.url?.match(/^\/broadcasts\/([^/]+)\/feed$/);
  if (!match) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? null;
  if (!hasValidKey(bearer)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, async (ws) => {
    const broadcastId = match[1];
    const runtime = await ensureRuntime(broadcastId);
    if (!runtime) {
      ws.close(4004, `Broadcast ${broadcastId} is not active`);
      return;
    }
    handleFeedSubscription(ws, runtime);
  });
});

console.log(`[kairos] WebSocket endpoint at ws://localhost:${port}/broadcasts/:broadcastId/feed`);

process.on("SIGTERM", async () => {
  const { flushTelemetry } = await import("./telemetry.js");
  await flushTelemetry();
  await sql.end();
  process.exit(0);
});
