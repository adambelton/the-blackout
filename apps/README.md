# apps/ — the two services

The Blackout is two services running together: the **Blackout consumer side** (a Next.js client + a stateful Hono backend — the room conductor) and **Kairos** (a domain-agnostic narrative orchestration engine). The seam between them is the only deliberate decoupling in the system; everything else (auth, shared types, the playback clock, source capture, presentation) lives within one service or the other. This README is the checkpoint for *how the two services fit* — what each owns, the contract at the seam, and what a healthy running system looks like. For service internals, see the per-service READMEs. For what the product *is*, read the [root README](../README.md) and [`docs/product-brief.md`](../docs/product-brief.md).

```
apps/blackout/   → The Blackout consumer side. Two halves (client + server) of one product —
                   client renders, server is the room conductor. Football lives here.
                   See ./blackout/README.md for the internal architecture.

apps/kairos/     → The Kairos service. Server (the engine on :5050) + admin client
                   (the content workbench on :3001).
                   Domain-agnostic. See ./kairos/README.md.
```

(Also in the repo: `packages/blackout/shared/` (`@blackout/shared` — the Blackout side's types hub, used by both halves of `blackout/`), `packages/blackout/auth/` (`@blackout/auth` — the Better Auth factory for the Blackout halves), and `packages/kairos/auth/` (`@kairos/auth` — the parallel Better Auth factory for both halves of `kairos/`). **Kairos doesn't consume any of the `@blackout/*` packages**; the Blackout side doesn't consume `@kairos/auth`. See [`../packages/README.md`](../packages/README.md).)

## What each service is for

- **`blackout/`** — the consumer side. It captures the football-specific sources (Sportmonks events, the moderator's transcribed radio audio), distils commentary into structured texture, manages the broadcast lifecycle, pushes typed feed entries to Kairos, receives narratives back, synthesises TTS + illustrations, owns the playback clock (`setTimeout` on the server is the truth), authors the per-passage canonical bundle, fans WebSocket cues to matchroom + moderator clients in lockstep with the narrator's audio. **Football lives here** — Sportmonks, club briefs, the radio offset, the no-spoilers reveal rules, the moderator console.

- **`kairos/`** — the engine. Given typed source entries and a brief that frames what matters, it batches them into content-time-coherent windows, enriches them (services tracking themes / character arcs / momentum / etc.), curates the result (one subtractive stage — decides what's kept), and generates a short authored passage in a configurable voice with covers (per-entry reveal anchors) and an imagery decision. **Domain-agnostic** — no football types, no Sportmonks, no Blackout source names, no imports from `@blackout/server` or `@blackout/shared`. The football is supplied by the consumer (source adapters + event-profile / service-spec content shipped per broadcast).

## How they talk

```
   apps/blackout/server                          apps/kairos/server
   :4000                                         :5050
   ┌──────────────────────────┐  HTTP REST   ┌────────────────────────────┐
   │  room conductor          │ ───────────▶ │  pipeline + generation     │
   │  source capture          │              │                            │
   │  TTS + illustration      │ ◀─────────── │  feed WS (read-only)       │
   │  WebSocket fan-out       │  Bearer      │  /broadcasts/:id/feed      │
   │  matchroom + moderator   │  KAIROS_API_ │   sync · entry · narrative │
   │                          │  KEY         │   · imagery_decision · …   │
   └──────────────────────────┘              └────────────────────────────┘
   Knows about Kairos.                       Doesn't know its consumer.
   src/lib/kairos.ts is the client.          Domain-agnostic.
```

**One seam. One direction.** The Blackout depends on Kairos at runtime; Kairos has neither compile-time nor runtime knowledge of its consumer. There's no shared TypeScript across the seam — the wire is HTTP + WebSocket. A shape genuinely needed on both sides is duplicated, not shared (and it's almost always Kairos that owns it; the Blackout side mirrors). The intra-service seams (`client ↔ server` within Blackout; `consumer-routes ↔ admin-routes` within Kairos) live in the per-service READMEs.

### blackout-server → kairos-server

- **Client:** [`apps/blackout/server/src/lib/kairos.ts`](blackout/server/src/lib/kairos.ts) is the typed HTTP/WS client; [`apps/blackout/server/src/lib/kairos-bridge.ts`](blackout/server/src/lib/kairos-bridge.ts) wraps the per-broadcast lifecycle; [`apps/blackout/server/src/lib/kairos-heartbeat.ts`](blackout/server/src/lib/kairos-heartbeat.ts) pings the feed WS every 15s and terminates on missed pong (needed because Kairos restarts under `tsx watch` leave consumer sockets half-open and TCP keepalive alone takes minutes).

- **REST (blackout-server → kairos-server):** `POST /broadcasts` (create pending broadcast with sources), `PATCH /broadcasts/:id` (status transitions, config), `POST /broadcasts/:id/entries` (push feed entries), `POST /broadcasts/:id/feedback` (pacing signals — slow_down / speed_up / on_track + measured wpm), `POST /broadcasts/:id/narrative/generate` (off-schedule cycle; body `{ consumerPrompt: string }` required), `GET /broadcasts/:id/*` (entries, cycles, generations, services, health — inspector reads), `GET/POST/PATCH/DELETE /broadcasts/:id/pool` (content-pool: pre-prepared illustrations the imagery selector can pick from), `GET /profiles`, `GET /specs`, `POST /specs/:service/:profile/:version/promote`.

- **WebSocket (kairos-server → blackout-server, read-only):** `ws://kairos/broadcasts/:id/feed` — on connect: `sync` (all entries so far); then `entry` (a pushed entry echoed back — the conductor relies on this to receive its own synthetic phase markers), `narrative` (the generated passage: `{ id, text, covers, batchEntryIds, batchContentTime, imagery, … }`), `imagery_decision` (fired the moment Haiku's imagery call returns, ahead of the Sonnet narrative, so the server's image pipeline can start early), `generation_skipped` (rate-limited), `cycle_complete` (a `pipeline_cycles` row landed — inspector signal).

- **Auth:** every Kairos request from blackout-server carries `Authorization: Bearer <KAIROS_API_KEY>`; Kairos validates against its `KAIROS_API_KEYS` allowlist (comma-separated). `/health` is exempt. This is the **consumer-routes** surface — distinct from Kairos's admin-routes (Better Auth session cookie issued by `apps/kairos/client` for spec/profile editing; email/password sign-in, sign-up disabled). See [`kairos/README.md`](kairos/README.md) for the auth-surface split.

- **The consumer's stamping responsibility:** Kairos batches entries by *content time*, but only as accurately as the consumer stamps. The blackout-server's `broadcast-runner` stamps every entry's `data` payload with `phase` + `phaseSecond` (from its calibrated radio-offset estimate, continuously refined by matching distilled commentary against canonical Sportmonks events), plus optional `contentTime` (human-readable match-clock marker), `closingExtensionSeconds` + `closingPrompt` (mark a phase boundary worth pinning the next cycle's drain to, e.g. the half-time whistle), `sourceId` (stable external id — used for dedup and parent/child grouping), `parentSourceId` (links a `match_action` event_texture entry to its canonical Sportmonks event). Kairos doesn't interpret any of these football meanings — it just batches on the ordinal, dedups on `sourceId`, and groups parent/children at prompt-render time. Entries without `phase` fall through every cadence flush harmlessly.

- **Contract blackout-server depends on:** Kairos returns one `narrative` per generated cycle with `covers` (a strict subset of the cycle's entries the prose actually cites, each with an optional `charOffset` into the prose) and `batchEntryIds` (everything the cycle observed, superset of covers — the server reveals these at audio-end if uncited, so nothing the cycle saw is invisible); `batchContentTime` (earliest match-clock marker in the batch, monotonic — the server drives the match clock from this); `imagery` decisions are advisory (`pool` / `generate` / `hold`); curation is the sole authority on what reaches the generator (the server never second-guesses it); `consumerPrompt` is spliced verbatim into the generator's user message (the server owns the wording — that's how domain-specific moments like a half-time reflection get expressed without leaking football into Kairos's API).

### blackout-client ↛ kairos-server

Never directly. Anything the web surface needs from the engine (the pipeline inspector at `apps/blackout/client/app/inspector/`) goes through blackout-server routes that proxy or aggregate Kairos's `GET /broadcasts/:id/*` reads. If you find frontend code with a Kairos URL in it, that's a seam violation. The discipline is [`blackout/README.md`](blackout/README.md)'s.

## Domain-agnostic discipline

`apps/blackout/server` and `apps/blackout/client` import from `@blackout/shared` and `@blackout/auth`. `apps/kairos/server` **does not** — it has no dependency on either package. The seam between Kairos and the Blackout is the HTTP/WS wire; Kairos doesn't compile-couple to its consumer. A shape genuinely needed on both sides is **duplicated, not shared** — Kairos owns its API enums; the Blackout side mirrors them (`packages/blackout/shared/types/pipeline-cycle.ts` is that hand-maintained mirror today; the longer-term direction is a Kairos-owned types package the Blackout imports — see [`../packages/README.md`](../packages/README.md) § Open work).

"Moderator" is **not** a domain leak — it's the generic role of "the person driving the broadcast" (a debate, courtroom, political event all have one). Football leaks that are real and tracked: `PHASE_BASE` / `LIVE_PHASES` hardcoding football phase names ([`../docs/kairos-domain-leak-open-items.md`](../docs/kairos-domain-leak-open-items.md)).

Blackout code (and whoever edits it) can read and change Kairos freely — there's no IP wall. The rule is just that Kairos doesn't learn about football and doesn't compile-couple to its consumer. That's what keeps the engine focused and the system clean.

## What a working system looks like

`pnpm run dev` from the repo root starts four processes in parallel via Turborepo: blackout-client on :3000, blackout-server on :4000, kairos-server on :5050, kairos-client on :3001.

A live broadcast in healthy steady state, at service-level resolution:

1. A broadcast is created in the content studio (blackout-client) and goes `draft → scheduled → live → complete` (Blackout lifecycle); the matching Kairos broadcast goes `pending → active → complete`. Activation refuses if Kairos doesn't have a non-empty `narrative_voice` and `narrative_context` entry (the generator has no fallback voice/brief).
2. During `live`: the Blackout side captures sources (radio audio in the moderator's UK-resident browser → blackout-server's Deepgram pipeline → the distiller's Haiku classifier into structured `atmosphere` + `event_texture`; Sportmonks `match_events` polled on the side), stamps each entry with the calibrated radio offset, and pushes them to Kairos.
3. Kairos runs a cycle roughly every 45s (the cadence): drain entries whose content ordinal ≤ (highest observed − 60s DELAY) → enrich (services, parallel) → curate (tiered, parallel-within-tier) → generate (Sonnet for prose, Haiku for imagery, in parallel) → emit `imagery_decision` then `narrative` over the feed WS.
4. blackout-server receives the narrative, synthesises TTS (ElevenLabs), generates or selects an illustration (Replicate or the pre-prepared pool), authors the per-passage canonical bundle, and schedules timing cues — one server-side clock.
5. blackout-client (matchroom + moderator console) reveals text / events / score / illustration in step with the narrator's audio; nothing visible before the narrator has spoken it.
6. The moderator can type live editorial directives (steering that applies to every passage from then on) and trigger off-schedule beats via `consumerPrompt`. Pacing feedback (how fast the TTS voice actually read the last clip) flows back to Kairos and adjusts the next cycle's word-count target.

Health probes: blackout-server `GET http://localhost:4000/health`, kairos-server `GET http://localhost:5050/health`.

## Runtime status

The hosted infrastructure has been retired. This repository no longer contains deployment configurations or automatic deployment workflows. Local development still uses two Postgres databases; the `predev` hooks apply migrations and run the schema drift checks before starting each service.

## Open work — cross-service

Items that span both services live here. App-internal WIP lives in that app's README; component WIP lives deeper still.

- **Matchroom reveal architecture — replay variant.** Live + replay share one `Passage` / `CanonicalState` contract (live = server-anchored, replay = client-owned). The admin progressive-rerun variant and a few completed-state polish items are still owed. → [`../docs/matchroom-reveal-architecture-scoping.md`](../docs/matchroom-reveal-architecture-scoping.md).
- **Kairos prompts-as-content (Phases 5–7) + Blackout broadcast templates.** Kairos side: lift `TASK_INSTRUCTIONS` / `IMAGERY_INSTRUCTIONS` / `formatMode` out of generator code into versioned `generation` + `imagery` *service specs*. K6.1 landed the schema scaffolding (2026-05-14); K6.2 lifts the content. Blackout side: a reusable **broadcast template** bundling {`event_profile` choice, source roster + enrichment tags, `BroadcastConfig`, default voice} that compiles down to the per-broadcast Kairos payload. → [`../docs/prompts-as-content-design.md`](../docs/prompts-as-content-design.md).
- **Kairos-owned types package** — `packages/blackout/shared/types/pipeline-cycle.ts` is a hand-maintained mirror of Kairos's API output shapes; a Kairos-side change has to be re-typed by hand. Lift it into a package Kairos owns and the Blackout imports. → [`../packages/README.md`](../packages/README.md) § Open work.
- **`BroadcastStatus` / `ConnectedCue` name collisions** between `packages/blackout/shared` and app-local types — cross-app rename. → [`../docs/codebase-audit-2026-05-10.md`](../docs/codebase-audit-2026-05-10.md).

## See also

- [Root README](../README.md) — what The Blackout is, getting started, the stack.
- [`blackout/README.md`](blackout/README.md) — the Blackout consumer side (client + server + their internal seam).
- [`kairos/README.md`](kairos/README.md) — the Kairos engine (server + planned admin client).
- [`../packages/README.md`](../packages/README.md) — the shared packages (Blackout side only).
- [`../docs/the-blackout-architecture.md`](../docs/the-blackout-architecture.md) — canonical consumer-side architecture, being decomposed into the per-server READMEs.
- [`../docs/kairos-architecture.md`](../docs/kairos-architecture.md) — canonical engine architecture, being decomposed into the per-module READMEs under `kairos/server/src/`.
- [`../docs/STATUS.md`](../docs/STATUS.md) — at-a-glance dashboard.
