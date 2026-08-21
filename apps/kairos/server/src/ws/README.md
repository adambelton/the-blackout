# ws/ — the feed WebSocket

The consumer's read-only stream of a broadcast's life. The REST surface ([`../routes/`](../routes/README.md)) is how the consumer *writes* to Kairos; this is how it *reads* the engine's output as it happens. One endpoint: `ws://…/broadcasts/:broadcastId/feed`.

## What's here

- **`feed.ts`** — `handleFeedSubscription(ws, runtime)`: send `{ type: "sync", entries }` (every entry pushed so far), add the socket to `runtime.subscribers`, remove it on close, log connect/disconnect. That's the whole module — the actual message-sending is done by the producers (`feed.ts`'s listener wiring in `broadcast.ts` emits `entry`; the `CyclePipeline`'s `onCyclePersisted` emits `cycle_complete`; the `NarrativeEngine` emits `imagery_decision` / `narrative` / `generation_skipped`), all of which iterate the same `runtime.subscribers` set this module registers into.

## How it fits

- **Upstream:** the WS upgrade isn't handled by Hono (Hono middleware doesn't see raw upgrades), so `server.ts` owns it: a `WebSocketServer({ noServer: true })` matches the path against `/broadcasts/:id/feed`, gates the handshake with the same bearer-token check as HTTP (401 the socket before upgrading if it fails — unauthorized handshakes are rejected at the HTTP layer, not accepted-then-closed), `ensureRuntime(broadcastId)` (lazily rehydrating an `active` broadcast's runtime), closes 4004 if the broadcast isn't active, then hands the socket to `handleFeedSubscription`.
- **Downstream:** the registered socket receives, in order: `sync` (on connect) → then a mix of `entry` (a pushed entry echoed back — the conductor relies on this to receive its own synthetic phase markers), `imagery_decision` (the moment the parallel Haiku imagery call returns, ahead of the Sonnet narrative — so the consumer's image pipeline starts in parallel), `narrative` (the generated passage — see [`../narrative/README.md`](../narrative/README.md) for the `NarrativeOutput` shape), `generation_skipped` (rate-limited), `cycle_complete` (a `pipeline_cycles` row landed — inspector signal). Read-only — the client never writes; all writes go through REST.
- **Heartbeat is one-directional today** — the consumer-side `kairos-heartbeat.ts` (in `apps/blackout/server`) pings every 15s and terminates on missed pong (needed because Kairos restarts under `tsx watch` leave consumer sockets half-open and TCP keepalive alone takes minutes). Server-side ping (Kairos pinging *its* subscribers) and a graceful-shutdown close-frame on SIGTERM are owed — ~20 lines, MVP infrastructure-hardening.

**Working looks like:** `[ws] feed subscriber connected to broadcast <id> (N entries synced)` on connect; the subscriber receiving `imagery_decision` then `narrative` then `cycle_complete` every cycle; `[ws] feed subscriber disconnected …` on close; an unauthenticated handshake getting `HTTP/1.1 401 Unauthorized` and the socket destroyed (not accepted-then-closed).

## Contract

### Provided
- One endpoint: `ws://…/broadcasts/:broadcastId/feed`, `Authorization: Bearer <token>` required on the handshake.
- The message stream: `sync` (once, on connect) → `entry` / `imagery_decision` / `narrative` / `generation_skipped` / `cycle_complete` (the message shapes are in [`../../README.md`](../../README.md) § WebSocket).
- Read-only — no client-to-server messages are interpreted.

### Depended on
- `server.ts` owns the upgrade + auth gate + the `ensureRuntime` / not-active checks; `handleFeedSubscription` assumes a valid, active-broadcast runtime.
- `broadcast.ts`'s `BroadcastRuntime` — specifically the `subscribers: Set<WebSocket>` field and `broadcastId`.
- The producers (`feed.ts` listener, `pipeline.ts`'s `onCyclePersisted`, `narrative/engine.ts`'s `broadcastToSubscribers`) all iterate the same `subscribers` set — this module just registers/deregisters; it doesn't define the message vocabulary.

## Open work

- **No server-side WS heartbeat / graceful-shutdown close-frame** — the ping is consumer→Kairos only. Tracked engine-wide in [`../../README.md`](../../README.md) and in MVP infrastructure-hardening.

## See also

- [`../../README.md`](../../README.md) — Kairos as a service: the full WebSocket message table, the heartbeat note.
- [`../routes/README.md`](../routes/README.md) — the REST surface (the *write* side of the consumer contract).
- [`../narrative/README.md`](../narrative/README.md) — the producer of `narrative` / `imagery_decision` / `generation_skipped`.
- `apps/blackout/server/src/lib/kairos.ts` + `kairos-heartbeat.ts` — the consumer side of this connection.
