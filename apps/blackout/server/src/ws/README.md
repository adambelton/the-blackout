# ws/ — the two WebSocket endpoints

The real-time surface. Two paths, two audiences: `/ws/moderator` (writer/admin — the live control surface, read-write) and `/ws/matchroom` (any authenticated member — the viewer, read-only). Both are thin subscribers to the per-broadcast `RoomConductor` ([`../conductor/README.md`](../conductor/README.md)) — the conductor owns the Kairos feed subscription, synthesis, scheduling, and fan-out; these handlers just orchestrate the connection and the per-audience cue transform. The WS upgrade itself (cookie validation, path routing) is in `src/index.ts` — Hono middleware doesn't see raw upgrades, so the session cookie is validated on the raw `upgrade` event and the path is routed manually (moderator → writer/admin only; matchroom → any authenticated user; unknown → 404 the socket).

## What's here

- **`matchroom.ts`** — the matchroom WS handler: validate the broadcast exists, is live, and is Kairos-linked → `ensureRoomConductor` → register with `addClient(ws, matchroomTransform)` → unregister on close. The transform is the no-spoilers gate.
- **`matchroom-transform.ts`** — pure transform helpers (separate so the rules are unit-testable without the server graph). `matchroomTransform` — the cue whitelist: which conductor cues a viewer is allowed to receive (the playback contract — `connected`/`narrative`/`preload`/`play`/`phase`/`illustration` and the bundle cues `passage_*`/`broadcast_status_changed` — plus the reveal-gated `feed_entry` *reshaped*, never operator-only diagnostics like `latency_sample`; returning `null` drops the cue). `toViewerEntry` — the `feed_entry` reshape: drop noise inside it (transcription, moderator notes, pressure/zone signals) and project match events into the viewer DTO. *Audio is canonical* — this transform is one of the places that enforces "nothing visible before the narrator has spoken it" (the other is the bundle's reveal markers).
- **`moderator.ts`** — the moderator WS handler: validate the broadcast → `ensureRoomConductor` → register with `addClient(ws, /* near-passthrough */)` → send `checkServices()` status on connect; handle inbound frames — binary frames are audio chunks relayed to the runner's transcription pipe (`pushAudioChunkToRunner` — dropped silently if no runner is active; capture races activation), text frames are moderator-typed notes relayed to the runner (`pushModeratorMessageToRunner`); also exposes activation/completion (`activateBroadcast` / `completeBroadcast` from `kairos-bridge`). The moderator sees nearly everything the conductor fans out — the raw `feed_entry` stream (via `toFeedEntry`), the `latency_sample` calibration cues, the playback cues — because it's the operator console.
- **`moderator-feed-shape.ts`** — pure transform from a Kairos feed entry into the moderator's feed shape (separate so it's unit-testable and so `buildModeratorView` can reshape historical entries with the *same* rules the live WS uses). Preserves the engine's taxonomy: `source` = the Kairos source name as-pushed (`match_events` / `match_action` / `match_pressure` / `moderator` / `narrative_context` / `narrative_voice`), `subType` = the data-level classification (`GOAL` / `KICKOFF` / `atmosphere` / `event_texture` / `PRESSURE_UPDATE` / …). Raw-stats entries (pressure/trend/ball/xG rows) are filtered (stored on Kairos for analysis but would swamp the scroll pane); other unknown sources pass through with their source intact.

## How it fits

- **Upstream:** `src/index.ts` owns the upgrade — two `WebSocketServer({noServer:true})` instances (routing upgrades manually keeps each path independent — a non-matching path on one instance would otherwise destroy a socket the other already accepted), `validateSession(req)` on the raw `IncomingMessage`, the role check, then handoff to the handler.
- **Downstream:** both handlers `ensureRoomConductor(broadcastId)` and `addClient(ws, transform)`; the conductor's `fanOut` runs every cue through the registered transform before sending. The moderator handler also calls `pushAudioChunkToRunner` / `pushModeratorMessageToRunner` (into `lib/broadcast-runner.ts`'s transcription pipe / moderator-note path) and `activateBroadcast` / `completeBroadcast` (`lib/kairos-bridge.ts`), and `checkServices()` (`lib/services.ts`). The bootstrap counterparts to the live streams are `buildBroadcastView` (matchroom) / `buildModeratorView` (moderator) in `lib/`, which reshape the *historical* state with the same transforms (`toViewerEntry` / `toFeedEntry`) — so the bootstrap and the live stream agree.

## Contract

### Provided
- `ws://server/ws/moderator?broadcastId=…` (writer/admin) — the cue stream (nearly everything the conductor fans out, `feed_entry` reshaped via `toFeedEntry`, plus `latency_sample`), accepts binary audio chunks + text notes, exposes activation/completion. `ws://server/ws/matchroom?broadcastId=…` (any authenticated user) — the cue stream filtered to the playback + reveal contract (the matchroom whitelist), `feed_entry` reshaped to the viewer DTO via `toViewerEntry`, no operator diagnostics. Both: the conductor's clock contract (compute audio offset from `serverNow − playbackStartedAt`).
- The pure transforms (`matchroomTransform` / `toViewerEntry` / `toFeedEntry`) — also used by the bootstrap view builders so live and replay agree.

### Depended on
- `src/index.ts` for the upgrade + cookie validation + role check + path routing.
- `../conductor/` — `ensureRoomConductor`, `addClient(ws, transform)`, the `ConductorCue` union (the moderator near-passes it through; the matchroom whitelists it).
- `lib/broadcast-runner.ts` (`pushAudioChunkToRunner` / `pushModeratorMessageToRunner`), `lib/kairos-bridge.ts` (`activateBroadcast` / `completeBroadcast`), `lib/services.ts` (`checkServices`), `lib/broadcasts.ts` (`getBroadcast`), `lib/kairos.ts` (`KairosFeedEntry` type).
- `@blackout/shared` (`TeamSide` etc. for the viewer/feed DTOs).

## Open work

- **The moderator WS protocol is loosely typed** — text + binary frames without a discriminated inbound message union; the inspector audit flagged this. Tightening it (a typed moderator-channel protocol) is the same work that resolves the `ConnectedCue` name collision (the conductor's legacy `ConnectedCue` `currentPlay` vs the shared `Connected` `currentPassage`, both on `connected`). Tracked server-wide in [`../../README.md`](../../README.md) and cross-app in [`../../../README.md`](../../../README.md) § Open work.
- **The matchroom is still consuming the legacy playback cues** (`narrative`/`play`/`illustration`), not the bundle cues (`passage_*`) — the conductor fans both; Sub-piece 4c flips the matchroom, 4d retires the legacy cues. → [`docs/matchroom-reveal-architecture-scoping.md`](../../../../docs/matchroom-reveal-architecture-scoping.md).

## See also

- [`../../README.md`](../../README.md) — the backend as a service; the web-facing-surface and the conductor-authority sections.
- [`../conductor/README.md`](../conductor/README.md) — the conductor these handlers subscribe to; the full cue vocabulary; the clock contract.
- [`../lib/README.md`](../lib/README.md) — `broadcast-runner` (the transcription/note relay targets), `kairos-bridge` (activation/completion), `services`, the view builders that use the same transforms.
- [`../routes/README.md`](../routes/README.md) — the HTTP surface; the `buildBroadcastView`/`buildModeratorView` bootstrap that pairs with these live streams.
- `apps/blackout/client/app/matchroom/README.md` / `apps/blackout/client/app/moderator/README.md` — the clients of these endpoints. *(pending)*
