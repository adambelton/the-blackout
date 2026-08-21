# routes/ — the HTTP surface

The Hono route modules. This is Kairos's REST API — the public surface a consumer talks to (the WebSocket feed is separate, in [`../ws/`](../ws/README.md)). `app.ts` mounts them all behind CORS + the `apiKeyAuth` bearer-token middleware (`/health` exempt; no keys configured ⇒ 503 fail-closed; WS upgrades gated separately in `server.ts` with the same check). The full endpoint table — verbs, bodies, status codes, what each guarantees — is in [`../../README.md`](../../README.md) § The consumer contract; this README is the map of which module owns what and what each module reaches into.

## What's here

- **`health.ts`** — `GET /health` → `{ status: "ok", timestamp }`. The one unauthenticated route; Fly's health check and uptime monitors hit it.
- **`profiles.ts`** — `GET /profiles`, `GET /profiles/:name`. Reads `event_profiles` directly.
- **`specs.ts`** — `GET /specs`, `GET /specs/:service/:profile`, `POST /specs/:service/:profile/:version/promote`. The promote is transactional: archive the current `active` spec (+ `archivedAt`), activate the target (+ `activatedAt`). Rejects 409 if the target is already `active` or `archived`. Reads/writes `service_specs` directly.
- **`broadcasts.ts`** — the big one. Broadcasts CRUD (`POST/GET/PATCH/DELETE /broadcasts[/:id]`); source management (`POST/GET/PATCH/DELETE /broadcasts/:id/sources[/:sourceId]` — with `validateSourceInput`: `enrichment_tags` only on `event` sources, `canonical` only on `event`/`moderator`); feed entries (`POST /broadcasts/:id/entries` — routes by status: `active` ⇒ `runtime.feed.push`; `pending` + ambient ⇒ direct INSERT for pre-activation seeding; `pending` + non-ambient ⇒ 409; `GET /broadcasts/:id/entries` ⇒ a fresh `Feed(id).query(...)`, runtime-independent); pipeline cycles (`GET /broadcasts/:id/cycles` — list with per-cycle drift computed via `broadcast-health.ts::computeCycleDrift` against the previous row + the matching generation's word count; `GET …/cycles/:cycleId` — the full snapshot); flow-health (`GET /broadcasts/:id/health` — `broadcast-health.ts::computeBroadcastHealth` over all cycles + generations; the inspector polls this, doesn't subscribe); service snapshots (`GET /broadcasts/:id/services[/:serviceName]` ⇒ `runtime.pipeline.getSnapshots()`, 409 if not active); pacing feedback (`POST /broadcasts/:id/feedback` ⇒ `runtime.stateTracker.recordPacingSignal(...)`, validates the `signal` enum + positive wpm, returns the updated `estimatedWpm`).
- **`narrative.ts`** — `POST /broadcasts/:id/narrative/generate` (off-schedule cycle — body `{ consumerPrompt: string }` **required**, 400 without; `runtime.pipeline.flush({consumerPrompt})` → enrich → curate → generate; the HTTP response is just confirmation the cycle ran — the caller typically waits for the WS `narrative` cue; *the function's doc-string still says "Bypasses the curator" — stale, the bypass path was retired 2026-04-26, see Open work*); `GET /broadcasts/:id/generations[/:generationId]` — reads `generations` directly.
- **`content-pool.ts`** — `GET/POST/PATCH/DELETE /broadcasts/:id/pool[/:itemId]`. The content-pool CRUD the consumer's content studio pushes prepared illustrations into. Each item: `{ prompt (required), tags, consumer_metadata }` — `consumer_metadata` is opaque (the consumer stores a pointer to its own bytes). Uses `db/content-pool.ts` (the content-pool repo, distinct from `db/client.ts`'s postgres connection pool).

## How it fits

Route handlers are the API layer — they translate HTTP ⇄ the runtime + the repositories. They reach into: `db/` (the repositories — `getBroadcastWithConfig`, `createBroadcastRow`, etc. — and a few direct `db.select(...)` queries for read endpoints); `broadcast.ts` (`ensureRuntime`, `transitionStatus`, `stopRuntime` — lazily rehydrating an `active` broadcast's runtime on first reference); `feed.ts` (`new Feed(id).query(...)` for the runtime-independent entries read); `broadcast-health.ts` (the pure flow-health/drift maths); and **the `BroadcastRuntime`'s internals** — `runtime.feed.push`, `runtime.pipeline.getSnapshots()` / `.flush(...)`, `runtime.stateTracker.recordPacingSignal(...)` / `.getEstimatedWpm()`. There's no `BroadcastRuntime` facade — the routes know the runtime's composition (feed + pipeline + stateTracker). Acceptable for an API layer; a facade (`runtime.pushEntry`, `runtime.recordPacing`, `runtime.snapshotServices`, `runtime.requestCycle`) would tighten the seam (Open work). The `body.foo ?? body.fooCamelCase` pattern throughout accepts both snake_case (the on-wire convention) and camelCase request keys.

**Working looks like:** every non-health request that lacks a valid `Authorization: Bearer` token getting 401 (and a 503 if the server has no keys configured at all); a `POST …/entries` on an active broadcast returning the persisted entry 201 and that entry flowing into the pipeline + the WS subscribers; `GET …/health` and `GET …/cycles` returning numbers the inspector can render; `POST …/narrative/generate` without a `consumerPrompt` returning 400.

## Contract

### Provided
The REST surface in [`../../README.md`](../../README.md) § The consumer contract — that table *is* the contract. Stable shapes; both snake_case and camelCase keys accepted on requests; snake_case on responses.

### Depended on
- `db/` repositories + the table shapes (route handlers do some direct queries).
- `broadcast.ts` lifecycle functions (`ensureRuntime` / `transitionStatus` / `stopRuntime`) and the `BroadcastRuntime` struct's fields (`feed`, `pipeline`, `stateTracker`).
- `broadcast-health.ts`'s `computeBroadcastHealth` / `computeCycleDrift`.
- `enums.ts`'s type-guards (`isBroadcastStatus`, `isPacingSignal`, `isSourceType`) and the `PACING_SIGNALS` const.
- The `apiKeyAuth` middleware (mounted by `app.ts`) — handlers assume an authenticated caller.

## Open work

- **`narrative.ts`'s `generate` doc-string is stale** — says "Bypasses the curator — produces prose from the current feed state"; the actual code requires a `consumerPrompt` and routes through enrich → curate → generate (the curator-bypass `generateNow` was retired 2026-04-26). Trivial in-code fix.
- **No `BroadcastRuntime` facade** — route handlers reach into `runtime.feed` / `runtime.pipeline` / `runtime.stateTracker` directly. A facade would mean the HTTP layer doesn't need to know the runtime's internal composition. Low priority.

## See also

- [`../../README.md`](../../README.md) — Kairos as a service: the full endpoint table, auth, the broadcast lifecycle.
- [`../README.md`](../README.md) — the internal architecture; what the runtime these routes drive actually does.
- [`../ws/README.md`](../ws/README.md) — the WebSocket feed (the *other* half of the consumer surface).
- [`../db/README.md`](../db/README.md) — the repositories + tables route handlers read/write.
