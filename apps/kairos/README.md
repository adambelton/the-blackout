# apps/kairos/ — the Kairos service

The domain-agnostic narrative orchestration engine. Two halves: `server/` (the Hono engine on :5050) and `client/` (the local admin workbench for inspecting and tuning profile content on :3001).

For where Kairos sits in the overall system (and the one-way seam from the Blackout consumer side), see [`../README.md`](../README.md). For the founding philosophy ("Chronos is the raw stream — events, commentary, research, moderator input; Kairos is what the engine produces — the meaningful moment extracted from the stream"), see the root [`CLAUDE.md`](../../CLAUDE.md) § Kairos.

## What's here

- **[`server/`](server/README.md)** — `@kairos/server`. Hono on Node.js on :5050. Stateful. The engine: takes typed source entries + a brief, batches by content time, enriches (services that track themes / character arcs / momentum / etc.), curates (the one subtractive stage), generates (Sonnet for prose, Haiku for imagery, in parallel), emits over a feed WebSocket. **Domain-agnostic** — no football, no Sportmonks, no Blackout source names, no imports from `@blackout/server` or `@blackout/shared`. The football lives in the consumer's source adapters and in the event-profile / service-spec content the consumer ships.

- **[`client/`](client/README.md)** — `@kairos/client`. Next.js 16 App Router workbench for inspecting and editing the `generation`, `imagery`, and per-service specifications that form the engine's content layer. It has a separate authentication boundary from the Blackout experience.

## How the halves fit

```
   apps/kairos/client/                       apps/kairos/server/
   :3001                                      :5050
   ┌───────────────────────────┐  HTTP   ┌──────────────────────────────────────────────┐
   │   client                  │ ──────▶ │  server                                      │
   │   email/password sign-in  │         │  consumer routes (Bearer KAIROS_API_KEY) ← apps/blackout/server
   │   Better Auth session     │         │  admin routes   (Better Auth session)        ← apps/kairos/client
   │   kairos-auth.* cookie    │         │                                              │
   │   scoped to               │         │                                              │
   │   configured cookie scope            │                                              │
   └───────────────────────────┘         └──────────────────────────────────────────────┘
```

Two distinct auth surfaces on `server/`:
- **Consumer routes** (`POST /broadcasts`, `POST /broadcasts/:id/entries`, `GET /broadcasts/:id/*`, the feed WS, etc.) — service-token middleware. Used by `apps/blackout/server`. Untouched by the admin app.
- **Admin routes** (CRUD on `event_profiles` and `service_specs`) — Better Auth session middleware. Used by `client/`. Same factory pattern as `@blackout/auth`, separate package ([`@kairos/auth`](../../packages/kairos/auth/README.md), shipped K6.3a). Auth tables (`users` / `sessions` / `accounts` / `verifications`) live in Kairos's Postgres (owned by `apps/kairos/server`'s drizzle setup; the admin app reads/writes them but doesn't own the migration).

## Domain-agnostic discipline

Kairos doesn't import from `@blackout/server` or `@blackout/shared`. A type genuinely needed on both sides of the seam is **duplicated**, not shared — Kairos owns it (it's the engine), the Blackout side mirrors it (today: `packages/blackout/shared/types/pipeline-cycle.ts` is that hand-maintained mirror; the longer-term direction is a Kairos-owned types package the Blackout imports — tracked in [`../README.md`](../README.md) § Open work and [`../../packages/README.md`](../../packages/README.md) § Open work). "Moderator" is *not* a domain leak — it's the generic role of "the person driving the broadcast" (debate, courtroom, political event all have one).

## See also

- [`../README.md`](../README.md) — `apps/` — the running-processes overview.
- [`server/README.md`](server/README.md) — the engine in detail: pipeline stages, data shapes, the consumer contract, lifecycle, dev/deploy.
- [`../blackout/README.md`](../blackout/README.md) — the consumer side that uses Kairos today.
- [`../../docs/kairos-architecture.md`](../../docs/kairos-architecture.md) — canonical engine architecture (being decomposed into the `server/src/` READMEs; still the reference for what those READMEs cover until that work completes).
- [`../../docs/prompts-as-content-design.md`](../../docs/prompts-as-content-design.md) — the design that brings `client/` into existence (K6.3a/b) and the broader prompts-as-content lift.
