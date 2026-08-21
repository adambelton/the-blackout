# Blackout Server — working notes for AI-assisted dev

Stateful Hono backend on :4000. The room conductor: source capture (Sportmonks, the moderator's transcribed radio audio), commentary distillation, the Kairos feed subscription, TTS + illustration synthesis, the per-passage canonical bundle the matchroom walks, WebSocket fan-out to matchroom + moderator clients. Does **no** prose generation — that's [Kairos](../../kairos/server/README.md)'s job.

**Read [`README.md`](README.md) first** for what the server owns, the source-capture and Kairos-feed pipelines, the conductor's authority + cue vocabulary, the seams, the broadcast lifecycle, dev/deploy. Each `src/<module>/README.md` is the checkpoint for that module. This file carries only the rules that bite when you edit `apps/blackout/server/**`; it does not restate the architecture.

## Working rules

The full rule set — paid-endpoint auth, diagnostic transport independence, module boundaries, room-conductor authority — lives in the [`blackout-server` skill](../../../.claude/skills/blackout-server/SKILL.md) and auto-loads on `apps/blackout/server/**` reads. The load-bearing ones:

- **All Kairos communication goes through `src/lib/kairos.ts`** — the typed HTTP/WS client. No direct DB or internal imports across the module boundary; a route handler or the conductor calling Kairos's HTTP directly is a seam violation. The dependency is one-way: the server depends on Kairos, Kairos doesn't know its consumer.
- **Paid endpoints are auth-gated.** Anything touching a paid third-party API (TTS providers, Replicate, the inspector's Kairos proxies) is behind `requireAuth` / `requireRole("writer","admin")` — and TTS surfaces are gated *again* on the broadcast's `ttsEnabled` kill switch (role gets you access; the switch gates whether synthesis fires).
- **The conductor is the single authoritative clock.** `setTimeout(onClipEnd, durationMs)` is the truth; clients react. Don't add a parallel timeline anywhere. *Audio is canonical* — nothing visible (text, events, score, illustration) before the narrator has spoken it; the matchroom transform whitelist + the bundle's reveal markers enforce it; operator-only cues (`feed_entry`, `latency_sample`) never reach the matchroom.
- **Cross-app changes touch both sides.** `apps/blackout/server` and `apps/kairos/server` are one product behind a deliberate HTTP/WS seam. If a change touches the contract (routes, WS messages, shared concepts, naming, docs), update both — and `packages/blackout/shared` if a type moves — in the same pass.
- **Server-side API clients live in `src/lib/`** (Kairos, Sportmonks, the TTS providers, Replicate, R2, Anthropic; Deepgram's in `src/pipeline/`). **Shared types from `@blackout/shared`** — `SOURCE` (the source-name constants), the bundle types, the content-time helpers.
- **ESM** (`"type": "module"`) — `.js` extensions in relative imports. Env in `.env` (gitignored; documented in `.env.example`; validated in `env.ts`, live-broadcast subset via `assertLiveBroadcastEnv`).
- **Broadcast lifecycle:** `draft → scheduled → live → complete → archived` (the row status; the conductor's `BroadcastPhase` FSM — `warming` / `live_first_half` / `halftime` / `live_second_half` / `full_time_winddown` / `complete` — is a separate thing, driven by Sportmonks whistles). `kairosBroadcastId` links the two sides.

## Migration discipline

The canonical statement is in the [root `CLAUDE.md`](../../../CLAUDE.md) / the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md), and applies here unchanged: edit `src/db/schema.ts`, run `pnpm db:generate`, commit the SQL + `meta/_journal.json` + `meta/<idx>_snapshot.json` together; never hand-write structural DDL; never mix `db:push` and `db:migrate` on the same database.

## Scope

The concept prototype is complete and active development is paused. If work resumes, build only what is needed to explore a concrete question. Error handling, graceful degradation, and recovery remain first-class because the server owns the live broadcast clock. Keep the Kairos seam narrow (`lib/kairos.ts` only), avoid extending the largest conductor and runner modules, and split them when tests make that safe.
