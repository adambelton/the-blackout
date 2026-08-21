# The Blackout

Live AI-generated football narrative broadcast platform. A moderator transcribes live commentary, key events are detected, literary narrative is generated against loaded club and match context, read aloud by a narrator voice, and accompanied by illustrations — all orchestrated and delivered simultaneously to everyone in a shared room.

## Where to read before significant work

Three docs carry the load. Read the relevant ones before changing the corresponding surface:

- **`docs/prototype-status.md`** — prototype phase: foundation (goal, definition of done, scope, key unknowns, development discipline), phase 1–4 status across both Blackout and Kairos, live-test retros, and the prototype delivery test. Start here for the journey to the completed concept.
- **`docs/the-blackout-architecture.md`** — canonical consumer-side shape: source capture pipelines, room conductor, cue vocabulary, web surfaces, anti-patterns. The reference for any change to `apps/blackout/server` or `apps/blackout/client`.
- **`docs/kairos-architecture.md`** — canonical engine shape: enrichment, curation, generation, supporting systems, anti-patterns. The reference for any change to `apps/kairos/server` (also see `apps/kairos/server/CLAUDE.md`).

`docs/product-brief.md` (product + engine vision) and `docs/product-decisions.md` (decision log with retros) provide the why behind both.

`docs/vocabulary.md` is the dictionary — one place to look up any load-bearing term in the codebase (broadcast, passage, cycle, cover, marker, contentTime, canonical_emphasis, effective offset, etc.). Use it when a word's meaning is ambiguous; cross-reference it when adding new concepts so the vocabulary stays one document, not many drifting in code comments.

`docs/STATUS.md` is the at-a-glance dashboard — one-line state for what's in flight, what's blocked, what shipped recently. **Not a source of truth** — reasoning lives in the audit / debriefs / decision log. Refresh it when commits land or state shifts; if a status line wants to grow into a paragraph, the content belongs in the canonical doc that line links to.

**The codebase documents itself in layers.** A README at every meaningful level (the project, `apps/`, each app, each `src/` module) gives a resolution-appropriate explanation of what that piece is responsible for, how it talks to its neighbours, the contracts it provides and depends on, and what working looks like. One source of truth per fact, at the depth it belongs to; higher levels summarise + link down; WIP lives in the README beside the code and bubbles up as one-liners through the parents to `docs/STATUS.md`. README.md is descriptive (read on demand); CLAUDE.md is thin and imperative (always auto-loaded — it carries rules + pointers, not the architecture). The convention is **[`docs/documentation-system.md`](docs/documentation-system.md)** — read it before writing or changing any README/CLAUDE.md. The first vertical built to it is Kairos: start at [`apps/README.md`](apps/README.md) → [`apps/kairos/server/README.md`](apps/kairos/server/README.md). When you finish a piece of work: update the deepest doc it touched, then bubble the summary up the chain — that's part of "done."

## Working rules — auto-loaded skills

Repeated patterns and pitfalls live in `.claude/skills/` so they auto-load when relevant. These are for Claude consistency — read them as rules, not suggestions:

- **`workflow`** — cross-cutting: commits, dev stack ownership in support sessions, artefacts, vendor capability verification, cross-app changes, precedent vs convention, and build-step discipline.
- **`blackout-server`** — apps/blackout/server: paid-endpoint auth, diagnostic transport independence, module boundaries, room conductor authority.
- **`kairos-server`** — apps/kairos/server: domain-agnostic boundary, infrastructure vs content, flow over correctness for narrative, no judgment over fact (events first-class).
- **`blackout-client`** — apps/blackout/client: component composition, hook extraction (with current backlog), matchroom no-spoilers reveal gating, WS unions, API access discipline.
- **`blackout-shared`** — packages/blackout/shared: the Blackout side's types hub (Kairos doesn't consume it — duplicate cross-seam types, don't share), WS contracts, no shadowing of shared unions, name-collision discipline.
- **`migrations`** — drizzle discipline; auto-loads on `schema.ts`/`drizzle/` reads.
- **`doc-audit`** — verifies the layered documentation is being maintained against `docs/documentation-system.md`: catches drift since the last audit, corrects it, and hardens the affected README/CLAUDE.md (or the convention spec) against recurrence. **Run `/doc-audit` at the start of each session** so we begin from current docs — it catches up from its last-run marker (`<marker>..HEAD`), so anything the previous session left unaudited is swept up before new work begins.

Skills supplement the per-app `CLAUDE.md` files, not replace them. Tidy them as patterns evolve — the skill file is the canonical statement of the rule.

## Kairos

The Blackout is powered by Kairos, a real-time narrative orchestration engine. Kairos lives at `apps/kairos/server/` in this monorepo and runs as a standalone Hono service on port :5050. The Blackout talks to it over HTTP and WebSocket — the network seam is preserved deliberately, because Kairos is a domain-agnostic module with its own lifecycle, database, and consumer contract.

**The founding philosophy:** Chronos is the raw stream — events, commentary, research, moderator input. Time passing, things happening, sources flowing in. Kairos is what the engine produces — the meaningful moment extracted from the stream. The thing that could only exist from these exact sources at this exact instant. The engine's job: transforming Chronos into Kairos.

- Kairos owns the unified feed, session recording, and narrative generation.
- The Blackout owns source capture (Sportmonks events, moderator input), audio transcription (Deepgram), and all presentation (TTS, illustrations, WebSocket fan-out, room management).
- Kairos doesn't know about football. The Blackout doesn't know about orchestration.

The Kairos client is at `apps/blackout/server/src/lib/kairos.ts`. The service URL is configured via `KAIROS_URL` in `apps/blackout/server/.env`.

**Module-boundary discipline:** Kairos is a separate app with its own process, database, and lifecycle. Dependencies flow one way: The Blackout depends on Kairos at runtime via the HTTP/WS client in `apps/blackout/server/src/lib/kairos.ts` — Kairos doesn't know its consumer exists. The Kairos app must stay domain-agnostic: no football concepts, no Sportmonks types, no Blackout-specific source names, and no imports from `@blackout/server`. **Kairos does not depend on `packages/shared` either** — `@blackout/shared` is the *Blackout side's* types hub (`apps/blackout/server` + `apps/blackout/client`); the seam between Kairos and the Blackout is the HTTP/WS wire, not shared TypeScript. A type genuinely needed on both sides is duplicated, not shared — and it's almost always Kairos that owns it (it's the engine; the Blackout is the consumer): Kairos owns its API enums, the Blackout side mirrors them on its own (`packages/blackout/shared/types/pipeline-cycle.ts` is that mirror today; the longer-term direction is a Kairos-owned types package the Blackout imports). Blackout code (and whoever edits it) can read and change Kairos freely — there is no IP wall. The rule is just that Kairos doesn't learn about football and doesn't compile-couple to its consumer. That's what keeps the module focused and the overall system clean. See `apps/kairos/server/CLAUDE.md` for Kairos-specific conventions.

## Monorepo structure

- `apps/blackout/client/` — Next.js frontend (all user-facing interfaces)
- `apps/blackout/server/` — Node.js / Hono backend for The Blackout (dedicated server, not Next.js API routes)
- `apps/kairos/server/` — Node.js / Hono narrative orchestration engine. Domain-agnostic, own Postgres database, own lifecycle. Runs on :5050.
- `packages/blackout/shared/` — TypeScript types for the Blackout side (`apps/blackout/server` + `apps/blackout/client`). Imported as `@blackout/shared`. Kairos does **not** consume it — cross-seam types are duplicated (Kairos owns them; the Blackout side mirrors them), not shared.

Turborepo manages parallel dev, builds, and caching. `pnpm run dev` from repo root starts web, server, and Kairos in parallel.

## Stack — load-bearing facts

The full stack (frontend, backend, providers, deployment) lives in [`docs/product-brief.md`](docs/product-brief.md) under "Technical Architecture (Summary)". The facts that change how you write code in this repo:

- **Backend is stateful Hono on Node.js**, not serverless. Next.js API routes are not used for orchestration — the dedicated `apps/blackout/server` process is the room conductor.
- **Real-time is direct WebSocket** from `apps/blackout/server` (`/ws/matchroom`, `/ws/moderator`) — not Ably, not a managed service. The conductor's `setTimeout` is the authoritative clock; clients react to cues.
- **Narrative generation is Kairos's job, never The Blackout's.** No LLM calls for prose live in `apps/blackout/server` or `apps/blackout/client`. The Blackout pushes typed feed entries; Kairos returns narratives over the feed WS.
- **Both apps are ESM** (`"type": "module"`). Use `.js` extensions in relative imports.
- **Postgres only — no Docker.** Neon in prod, Homebrew in dev. Two separate databases (Blackout and Kairos). Drizzle + postgres-js.

## Architecture principles

- The backend server is the single authoritative room conductor. It manages state, schedules timing cues, and fans them to every connected matchroom and moderator client over WebSocket. Next.js API routes are stateless and must not be used for orchestration.
- `apps/blackout/server/src/sources/` contains football-specific source adapters (Sportmonks events). Each source captures domain-specific data and pushes it to Kairos as generic entries.
- `apps/blackout/server/src/lib/kairos.ts` is the typed HTTP/WebSocket client for the Kairos service. All feed operations go through this client.
- `packages/blackout/shared/types/` defines the Blackout side's shared types, particularly the WebSocket cue payloads exchanged between the conductor and matchroom/moderator clients. A change to a message shape must be caught at compile time across `apps/blackout/server` and `apps/blackout/client`. (Kairos doesn't consume this package — see § Kairos.)
- `BroadcastContext` is the key type — it carries club briefs, player context, illustrations, and author brief loaded from the database before a broadcast goes live.

## Key conventions

- All shared types go in `packages/blackout/shared/types/`. Import as `@blackout/shared`. (Blackout side only — `apps/blackout/server` + `apps/blackout/client`; Kairos doesn't consume it.)
- Server-side API clients (Kairos, Sportmonks, TTS, ElevenLabs, Replicate, R2 storage) live in `apps/blackout/server/src/lib/`.
- Environment variables are documented in `.env.example`. Never commit `.env` files.
- The server uses ESM (`"type": "module"` in package.json). Use `.js` extensions in relative imports within the server app.
- The broadcast lifecycle is: `draft → scheduled → live → complete`. The `broadcastId` is the shared key across the entire system.

## Development

```
pnpm run dev                            # Start web (:3000), server (:4000), Kairos (:5050) in parallel
pnpm run build                          # Build all packages
```

Each app has its own `.env` (see `.env.example` per app) and its own Postgres database. Migrations apply automatically — Fly's `release_command` runs the migrator before each prod release; `predev` hooks run it before `tsx watch` starts; the test harness calls it on bootstrap.

### Migration discipline

Applies to both `apps/blackout/server` and `apps/kairos/server`. Both use drizzle-orm with the same journal + snapshot contract.

**Always use `pnpm db:generate` for structural DDL.** This is not a default — it is the only correct path for any change to table shape, column set, index, or enum. Never hand-write structural DDL.

`drizzle-kit generate` diffs `schema.ts` against the last snapshot under `drizzle/meta/` and emits three artefacts atomically: the SQL file, a new snapshot, and an updated `_journal.json`. **All three must be committed together.** Without the snapshot, the next `db:generate` call diffs against a stale baseline and regenerates DDL that has already been applied.

The canonical flow:

1. Edit `src/db/schema.ts`.
2. Run `pnpm db:generate`.
3. Review the generated SQL to confirm it captures only the intended change.
4. Commit: SQL file + `meta/_journal.json` + `meta/<idx>_snapshot.json`. All three. Never a subset.

If you regenerate because the first attempt was wrong: delete the supplanted SQL file, the supplanted snapshot, and remove the supplanted journal entry before committing. Ghost entries cause silent drift.

**The `drizzle/` directory is for schema evolution only, and every file there must be drizzle-kit-authored (`pnpm db:generate`). Hand-written SQL in `drizzle/` is banned. Full stop.**

This rule has no carve-outs because the apparent carve-outs all dissolve under scrutiny:

- **"Backfill before applying a NOT NULL constraint."** Split into a sequence: drizzle-kit migration adds the column nullable → ops backfill (run as a one-off, *not* in `drizzle/`) → drizzle-kit migration adds the NOT NULL constraint. Three deploys, but the middle step is also where you verify the backfill landed cleanly before the constraint enforces — that's safer, not slower.
- **"Enum value removal."** Almost always solvable by *not* removing values. Stop using the value in code; old data stays valid; the value quietly disappears from the live working set without DDL. If you genuinely must remove for compliance/regulatory reasons, that's the ALTER TYPE escape hatch below.
- **"Conditional DDL (`DO $$ IF EXISTS`)."** Only needed if you don't trust the migration system. The whole point of `__drizzle_migrations` is exactly that guarantee — migrations run once, atomically, in a transaction. If you trust it (and this rule requires you to), conditional DDL is dead weight.

**Pure data fixes do NOT belong in `drizzle/`.** JSON-key rewrites inside jsonb columns, backfilling existing rows without changing structure, one-off correction of bad rows, the middle step of a multi-PR schema migration — none of these are migrations. They're one-off operations: run them through an explicit local script or admin route, and let git history (commit messages and PR descriptions) be the audit trail. The 0002 violation that produced this rule did exactly the wrong thing — forced a pure data fix into the migration system, with a hand-typed journal entry whose `when` value silently poisoned drizzle's monotonic `created_at` cursor (`pg-core/dialect.js:62`) — and the future K6.3a auth-tables migration would have silently no-applied without surgical recovery.

**The one true escape hatch — and it requires explicit design justification, not just "I need it now":** multi-step `ALTER TYPE` surgery that drizzle-kit literally cannot model (`ALTER TYPE old RENAME → CREATE TYPE new → ALTER TABLE … TYPE new USING old::text::new → DROP TYPE old_legacy`). This is vanishingly rare in practice — needing it usually signals a schema-design choice worth reconsidering. If a case genuinely arises: open a design discussion first, document why simpler alternatives don't work, and only then write the DDL by hand. It's the exception that proves the rule, not a normal pattern.

**Never mix `db:push` and `db:migrate` on the same database.** `db:push` applies the current schema without recording any migration entries. A subsequent `db:migrate` will try to replay all migrations from scratch against a DB already in the final state. `db:push` is for throwaway local experimentation only.

Server health check: `GET http://localhost:4000/health`
Moderator WebSocket: `ws://localhost:4000/ws/moderator` — writer/admin control surface
Matchroom WebSocket: `ws://localhost:4000/ws/matchroom` — listener surface

### Provisioning local accounts

For local development, accounts can be provisioned with `apps/blackout/client/scripts/create-user.ts`:

```bash
pnpm --filter @blackout/client exec tsx scripts/create-user.ts \
  <email> "<name>" <admin|writer> <password>
```

The script uses the database and auth settings from the local environment.

## Creative authorship

The Blackout uses AI to support creative effort, not replace it. A writer's research, perspective, editorial judgment, and narrative voice are the foundation of each broadcast. The engine works within that human-authored context at live-event speed; it does not supply the intent or claim independent authorship.

When evaluating a feature, preserve that boundary. The writer must remain able to shape what matters, intervene during the match, and be credited as the creative source. Better automation should amplify the writer's work without making the writer ornamental.

## Scope

The concept prototype is complete and active development is paused indefinitely. If development resumes, build the minimum needed to explore a concrete question rather than assuming a launch roadmap or commercial destination. Avoid speculative abstractions, feature flags for hypothetical futures, and unnecessary product surface.

**But error handling and stability are first-class now.** A live broadcast that crashes, hangs, or silently drops the narrator is a worse failure than an unbuilt feature. Handle the failure modes that show up in live tests — rate limits, half-open sockets, mid-broadcast process restarts, malformed LLM output, late-arriving entries; degrade gracefully (the previous image stays, the templated summary holds, the cycle skips rather than the runtime dying); recover on restart (rehydrate the conductor + runner, replay the persisted bundles, reseed the dedup state). The live-test debriefs are mostly stability fixes — that work is in scope, not a distraction from it. Happy-path-only is not shippable; speculative robustness is still out of scope.

**Solid system design remains first-class.** "Minimum to validate" is about *feature surface*, not structure. Prefer deep modules with narrow interfaces, progressive disclosure, single responsibility, contracts at the seams, and regression tests. "No speculative abstractions" is not permission to accumulate avoidable structural debt.
