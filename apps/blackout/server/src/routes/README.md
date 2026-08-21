# routes/ — the HTTP surface

The Hono route modules — the web app's REST API into the server. `src/index.ts` mounts them all behind origin-locked CORS (`ALLOWED_ORIGINS`, credentials on) + the `authContext` middleware (validates the Better Auth session cookie on every request, attaches `user`+`session`); individual routes layer `requireAuth` / `requireRole("admin"|"writer")` on top. The WebSocket surface is separate (`src/ws/`). Most route handlers are thin: translate HTTP ⇄ the `lib/` repos + view builders + the Kairos client + the runner/conductor lifecycle.

## What's here

- **`broadcasts.ts`** — the broadcasts API: list / get (returns `buildBroadcastView` — the matchroom/replay bootstrap DTO) / get-moderator-view (`buildModeratorView`) / create / update (PATCH — `ttsEnabled` kill switch, voice, brief, status) / delete; the lifecycle actions: `linkBroadcastToKairos`, `activateBroadcast` (→ Kairos active + runner start + conductor), `completeBroadcast` (→ both complete + runner stop); `runner-status` (`getBroadcastRunnerStatus`); `reportPacing` (used by tests/tooling — the conductor reports pacing directly on clip-end). Schedule-blocker checks (`collectScheduleBlockers` from `@blackout/shared`) gate activation. Auth: writer/admin for the management actions; the matchroom-view GET is member-gated at the WS layer, not here (the REST GET is used by the web for the live/replay bootstrap and is behind `requireAuth`).
- **`studio.ts`** — the content-studio API: the illustration pool (generate via `lib/replicate`, push to Kairos's content pool via `lib/kairos` with the `illustrationId` stashed on `consumer_metadata`, list / update / delete; tags via `lib/tag-deriver`; prompt suggestions via `lib/prompt-suggester` with discarded prompts as negative context; discarded-prompt ledger), brief editing, the illustration CRUD against `broadcast_illustrations`. Writer/admin.
- **`admin.ts`** — admin-only: user management (`listUsers` / `setUserRole`), the TTS-voice catalogue CRUD (`listTtsVoices` / `createTtsVoice` / `updateTtsVoice` / `deleteTtsVoice` + a preview-synthesis endpoint via `lib/tts`).
- **`inspector.ts`** — the pipeline-inspector API (writer/admin): proxies/aggregates Kairos's read endpoints — `listCycles` / `getCycle` / `getBroadcastHealth` / `getGeneration` / `listBroadcastEntries` — and resolves narration/illustration storage URLs from `broadcast_narrations` / `broadcast_illustrations`. The web's `app/inspector/` consumes this; it never talks to Kairos directly.
- **`tts.ts`** — TTS preview + the voice list (writer/admin, *and* gated again on the broadcast's `ttsEnabled` kill switch — role gets you access, the broadcast's own switch gates whether synthesis actually fires; every TTS surface touches a paid provider).
- **`radio-sources.ts`** — the radio-source-catalogue CRUD (admin — platform content; writers inherit the list via the moderator dropdown but don't need CRUD).
- **`storage.ts`** — serves bytes only when the in-memory test/fallback provider is active. Auth-gated (`requireAuth`) because those bytes can include narration audio from a prototype broadcast. Normal development assets use the `blackout-dev` R2 bucket and do not pass through this route.
- **`health.ts`** — `GET /health`.

## How it fits

Route handlers reach into `lib/` (the repos — `broadcasts` / `tts-voices` / `radio-sources` / `users`; the view builders — `buildBroadcastView` / `buildModeratorView`; the Kairos client — inspector proxies, studio pool ops; the kairos-bridge — lifecycle; the clients — `replicate` / `tts` / `prompt-suggester` / `tag-deriver` / `storage`), `lib/broadcast-runner.ts` (`getBroadcastRunnerStatus`), `db/` (a few direct queries — studio illustrations and inspector storage-URL resolution), and `@blackout/shared` (`collectScheduleBlockers`, `SOURCE`, the view DTOs). They assume an authenticated caller where `requireAuth`/`requireRole` is applied (and the WS layer, not these routes, enforces the matchroom member gate). The `body.foo ?? body.fooCamelCase` snake/camel-tolerance pattern shows up where the web sends camelCase.

## Contract

### Provided
The REST API the web app consumes — broadcasts CRUD + lifecycle + the bootstrap views, the studio pool/brief/illustration ops, admin user + voice management, the inspector reads, TTS preview, the radio-source catalogue, storage serving, and health. Roles: public (`health`), `requireAuth` (matchroom-view GET, storage), `requireRole("writer","admin")` (studio, tts, inspector, the broadcast lifecycle actions), `requireRole("admin")` (admin routes, radio-sources). The `buildBroadcastView` shape is the matchroom/replay bootstrap contract — the web walks it on connect.

### Depended on
- `lib/` — the repos, the view builders, the Kairos client + bridge, the runner-status accessor, the clients, the auth middleware (`authContext` is mounted by `src/index.ts`; `requireAuth`/`requireRole` are applied per-route).
- `db/` — `broadcast_illustrations` and `broadcast_narrations` (direct queries in studio/inspector).
- `@blackout/shared` — `collectScheduleBlockers`, `SOURCE`, `BroadcastView` / `ArchiveNarration` etc.
- The WS layer for the matchroom member gate (these routes don't enforce it).

## Open work

- **No `BroadcastRuntime`/conductor facade** — handlers reach into the lib repos + the runner status; mostly thin and fine for an API layer. Low priority.
- The route surface is being decomposed *from* [`docs/the-blackout-architecture.md`](../../../../docs/the-blackout-architecture.md) into this README; that doc has drifted (predates the Design-A bundle architecture). Treat this + [`../../README.md`](../../README.md) as canonical for the routes.

## See also

- [`../../README.md`](../../README.md) — the backend as a service; the web-facing-surface section.
- [`../lib/README.md`](../lib/README.md) — the repos, view builders, Kairos client, clients, auth middleware these routes use.
- [`../ws/README.md`](../ws/README.md) — the WebSocket surface (the *other* half of the web-facing API; the matchroom member gate lives there).
- `apps/blackout/client/README.md` — the frontend that consumes these routes. *(pending)*
