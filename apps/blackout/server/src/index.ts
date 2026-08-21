import "./env.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { WebSocketServer } from "ws";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { broadcastRoutes } from "./routes/broadcasts.js";
import { studioRoutes } from "./routes/studio.js";
import { inspectorRoutes } from "./routes/inspector.js";
import { radioSourceRoutes } from "./routes/radio-sources.js";
import { ttsRoutes } from "./routes/tts.js";
import { storageRoutes } from "./routes/storage.js";
import { adminRoutes } from "./routes/admin.js";
import { handleModeratorConnection } from "./ws/moderator.js";
import { handleMatchroomConnection } from "./ws/matchroom.js";
import { loadSportmonksTypes } from "./lib/sportmonks-types.js";
import { stopAllBroadcastRunners, startBroadcastRunner, isBroadcastRunnerActive } from "./lib/broadcast-runner.js";
import { rehydrateLiveBroadcasts } from "./lib/rehydration.js";
import { listBroadcasts } from "./lib/broadcasts.js";
import { ensureRoomConductor, stopAllRoomConductors } from "./conductor/index.js";
import { flushTelemetry } from "./lib/telemetry.js";
import { authContext } from "./lib/auth-middleware.js";

// Warm the Sportmonks types cache at startup so the event source can
// resolve type_ids locally without every live-feed row carrying a full
// `.type` object. Failure here is non-fatal — helpers fall back to null
// and the source logs unknowns.
loadSportmonksTypes().catch((err) => {
  console.warn(`[server] sportmonks types cache warm failed: ${err.message}`);
});

// Rehydrate every broadcast still marked `live` after a process
// restart — conductor + broadcast-runner both. Implementation +
// rationale in `lib/rehydration.ts`.
(async () => {
  try {
    const { count } = await rehydrateLiveBroadcasts({
      listBroadcasts,
      ensureRoomConductor,
      isBroadcastRunnerActive,
      startBroadcastRunner,
    });
    if (count > 0) {
      console.log(`[server] rehydrated ${count} room conductor(s) + runner(s)`);
    }
  } catch (err) {
    console.warn(
      `[server] room conductor rehydration failed: ${(err as Error).message}`,
    );
  }
})();

const app = new Hono();

// Origin-locked CORS. Only origins in ALLOWED_ORIGINS (comma-separated)
// can send cookies; any other origin hitting this server gets CORS-
// blocked at the browser. Defaults to localhost:3000 for dev so the
// web can talk to us locally; another environment can add origins via env.
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);
app.use(
  "/*",
  cors({
    origin: allowedOrigins,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// Validates the Better Auth session cookie on every request and
// attaches `user` + `session` to the Hono context. Routes that need
// authentication use `requireAuth` / `requireRole(...)` on top.
app.use("/*", authContext);

app.route("/", healthRoute);
app.route("/", broadcastRoutes);
app.route("/", studioRoutes);
app.route("/", inspectorRoutes);
app.route("/", radioSourceRoutes);
app.route("/", ttsRoutes);
app.route("/", storageRoutes);
app.route("/", adminRoutes);

const port = parseInt(process.env.PORT || "4000", 10);

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
});

// Two WebSocket paths, two handlers: the moderator (read-write control
// surface) and the matchroom (read-only viewer). Both WSS instances are
// `noServer` — the `ws` library would otherwise attach an upgrade
// listener per instance, and a non-matching path causes the *other*
// instance to destroy the socket a sibling instance has already accepted.
// Routing upgrades manually keeps each path independent.
const wss = new WebSocketServer({ noServer: true });
const matchroomWss = new WebSocketServer({ noServer: true });

(server as Server).on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

  // WebSocket handshakes don't go through Hono middleware — they hit
  // the raw `upgrade` event on the HTTP server. Validate the session
  // cookie here before accepting the upgrade. Cookie is sent
  // automatically by the browser when the origin is allowed.
  // Surface validation errors loudly — silently swallowing them
  // produced a long debug session in 2026-04-27.
  const session = await validateSession(req).catch((err) => {
    console.error(`[ws upgrade] validateSession threw for ${url.pathname}:`, err);
    return null;
  });
  const role = session?.user?.role as string | null | undefined;

  if (url.pathname === "/ws/moderator") {
    // Moderator console is writer + admin.
    if (role !== "admin" && role !== "writer") {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const broadcastId = url.searchParams.get("broadcastId");
      console.log(`[ws] moderator connected (broadcast ${broadcastId ?? "none"})`);
      wss.emit("connection", ws, req);
      handleModeratorConnection(ws, { broadcastId });
    });
    return;
  }
  if (url.pathname === "/ws/matchroom") {
    // The prototype matchroom requires an authenticated listener.
    if (!session?.user) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    matchroomWss.handleUpgrade(req, socket, head, (ws) => {
      const broadcastId = url.searchParams.get("broadcastId");
      console.log(`[ws] matchroom connected (broadcast ${broadcastId ?? "none"})`);
      matchroomWss.emit("connection", ws, req);
      handleMatchroomConnection(ws, { broadcastId });
    });
    return;
  }
  // Unknown WS path — close with a 404-equivalent so the client sees a
  // clean handshake failure rather than a hung connection.
  socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
  socket.destroy();
});

/**
 * Validate the Better Auth session from a raw HTTP upgrade request.
 * Builds a minimal Headers object from the Node `IncomingMessage` so
 * the `auth.api.getSession` call (which expects a web-style Headers
 * instance) can read the cookie.
 */
async function validateSession(req: import("node:http").IncomingMessage) {
  const { auth } = await import("./lib/auth.js");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value != null) {
      headers.set(key, value);
    }
  }
  return auth.api.getSession({ headers });
}

console.log("[server] WebSocket endpoints at ws://localhost:" + port + "/ws/moderator and /ws/matchroom");

// Graceful shutdown so tsx-watch restarts don't hit EADDRINUSE. Force-close
// any lingering WS connections and close the HTTP server, then exit.
const shutdown = async (signal: string) => {
  console.log(`[server] received ${signal}, shutting down…`);
  // Stop any running broadcast runners so broadcasts don't get left
  // `live` with zombie transcription / polling when we restart.
  try {
    await stopAllBroadcastRunners();
  } catch (err) {
    console.error("[server] broadcast-runner shutdown error:", (err as Error).message);
  }
  // Shut down every room conductor — closes Kairos subscriptions,
  // cancels playback timers, and forcibly disconnects subscribed clients
  // so tsx-watch doesn't leak file handles or WS connections across
  // restarts.
  stopAllRoomConductors();
  // Flush buffered PostHog events before the process exits so we
  // don't lose the final narration-played + phase-transitioned events
  // of a match.
  await flushTelemetry();
  for (const client of wss.clients) {
    try { client.terminate(); } catch {}
  }
  for (const client of matchroomWss.clients) {
    try { client.terminate(); } catch {}
  }
  wss.close(() => {
    matchroomWss.close(() => {
      (server as Server).close(() => process.exit(0));
    });
  });
  // Belt-and-braces: exit even if close handlers hang.
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
