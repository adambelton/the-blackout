# Blackout Web — working notes for AI-assisted dev

Next.js 16 App Router frontend on :3000. Every user-facing surface: public discovery, the member matchroom, the writer/admin moderator console, the content studio, the pipeline inspector, admin tooling. It renders — no orchestration state, no clock. Talks to `apps/blackout/server` over HTTP + WebSocket; talks to Kairos **only via the server**.

**Read [`README.md`](README.md) first** for the surfaces, the server seam, the matchroom reveal architecture, auth, dev. The route directories where the orchestration is non-trivial — [`app/matchroom/README.md`](app/matchroom/README.md), [`app/moderator/README.md`](app/moderator/README.md) — have their own READMEs; the rest of the component layer is docstring-carried. This file carries only the rules that bite when you edit `apps/blackout/client/**`; it does not restate the architecture.

## Working rules

The full rule set — component composition, hook extraction (with the current backlog), matchroom no-spoilers reveal gating, WS unions, API-access discipline — lives in the [`blackout-client` skill](../../../.claude/skills/blackout-client/SKILL.md) and auto-loads on `apps/blackout/client/**` reads. The load-bearing ones:

- **The server is the clock — the web reacts.** Every `play` cue carries `playbackStartedAt` + `serverNow`; seek audio to `(serverNow − playbackStartedAt)/1000`. Never run a client timeline (replay mode owns playback client-side but anchored to the persisted narration durations, not a free-running timer).
- **The matchroom shows nothing before the narrator says it.** Audio is canonical. A `narrative` cue stages prose but doesn't reveal it (waits for `play`); a `feed_entry` cue stages an event but doesn't promote it to the ribbon (waits for the citing narration's audio-end, or the cover anchor mid-prose); the match clock is monotonic. The reveal rules are pure in `app/matchroom/[broadcastId]/derivations.ts` (tested) — keep them there, keep `page.tsx` the orchestrator.
- **The web never talks to Kairos.** Anything the frontend needs from the engine (the inspector) goes through `apps/blackout/server` routes that proxy/aggregate Kairos's reads. A Kairos URL in `apps/blackout/client` is a seam violation.
- **Routes follow the shape:** `app/<route>/[id]/page.tsx` (orchestrator) + `app/<route>/[id]/components/` (visual pieces) + co-located `types.ts` / `utils.ts` / `derivations.ts` (the pure logic lifted out so it's unit-testable without rendering). Cross-route components in `app/components/`; brand tokens in `app/lib/palette.ts` (`brand as C`); the server seam in `lib/api.ts` (`apiGet`/`apiPost`/`apiPatch`/`apiDelete`) + `lib/ws.ts` (`useReconnectingWebSocket`). Shared types from `@blackout/shared`.
- **Cross-app changes touch both sides.** If a change touches the contract (the cue shapes, the bootstrap-view shapes, shared concepts, naming, docs), update `apps/blackout/server` — and `packages/blackout/shared` if a type moves — in the same pass.
- **Auth via Better Auth.** Email/password sessions are issued on the web side (`app/api/auth/[...all]`, `lib/auth.ts`, `@blackout/auth`'s factory); the server validates the same cookie. Role checks in the web are UX, not the security boundary — protected endpoints in `apps/blackout/server` are separately role-gated. Access requirements must be clear *before* a click, never discovered after.
- **`"use client"` only where interactivity is required.** The matchroom and moderator pages are large client components by necessity; the public pages mostly aren't.
- **Vitest for tests** — pure modules tested; React rendering not currently a tested surface (the hook-extraction backlog is partly about making the page orchestration testable).

## Migration discipline

`apps/blackout/client` doesn't own a database — Better Auth uses the server's Postgres (schema in `@blackout/auth`). Schema work happens in `apps/blackout/server` / `apps/kairos/server`; see the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md).

## Scope

The concept prototype is complete and active development is paused. If work resumes, build only what is needed to explore a concrete question. **The matchroom must remain stable:** it has to degrade gracefully and never break the no-spoilers contract on a glitch. Stability over polish; correctness over both. Keep the route-shape convention (orchestrator `page.tsx` + `components/` + co-located pure `derivations.ts`/`utils.ts`) and extract cohesive subsystems into hooks when tests make that safe.
