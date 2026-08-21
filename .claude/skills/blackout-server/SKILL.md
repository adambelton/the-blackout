---
name: blackout-server
description: Conventions and rules for apps/blackout/server (the Blackout's stateful Hono backend). Use when reading or writing anything under apps/blackout/server/**, when adding new HTTP/WS routes, when wiring a paid third-party API, when adding admin/diagnostic surfaces, or when working with the Kairos client. Keywords: apps/blackout/server, hono, websocket, room conductor, sportmonks, deepgram, elevenlabs, replicate, paid API, auth, middleware, inspector, admin surface.
---

# Blackout server (apps/blackout/server) — rules

Architecture context: `apps/blackout/server/CLAUDE.md` and `docs/the-blackout-architecture.md`.

## Module boundaries
- All Kairos communication goes through `src/lib/kairos.ts` — no direct DB or internal Kairos imports across the seam.
- All server-side third-party clients (Sportmonks, TTS, ElevenLabs, Replicate, R2) live in `src/lib/`.
- Football-specific source adapters live in `src/sources/`.
- Shared types in `packages/blackout/shared/types/`. Import as `@blackout/shared`. Never duplicate types across the seam.

## WS contracts
- Every `RoomConductor.fanOut` payload is a typed variant of `ConductorCue` (or the shared `MatchroomCue` for matchroom-bound cues). No `{ type: string; [k: string]: unknown }` escape hatch. New cue types extend the union; the union *is* the contract.
- Why: silent contract drift between server and clients defeats every WS-driven invariant the matchroom and moderator depend on.

## Source name discipline
- Source names come from `SOURCE` constants (target location: `packages/blackout/shared`). Never hand-write `"match_events"` / `"match_action"` / `"narrative_voice"` / `"narrative_context"` literals. A renamed source string should be one edit, not a grep-the-codebase.

## Self-heal source-data drift from authoritative snapshots, not a moderator UI
- External sources (Sportmonks, Deepgram, vendor APIs) typically provide TWO views of the same world: a stream of discrete events as they happen (which can drop or delay individually), AND a snapshot of absolute state on every fetch (totals, counts, current score). When the stream drifts from reality, **the snapshot is the structural cure** — diff implied-state-from-stream against asserted-state-from-snapshot, synthesise the missing entry, push it through. Self-heals on the next poll cycle without human attention.
- The defensible-but-wrong instinct to watch for: proposing a moderator-UI correction surface as the primary mechanism. That puts the burden on a human under live pressure, when an authoritative snapshot from the source itself is more reliable than human judgment under load. Moderator UI is the *fallback* for the rare case where both stream AND snapshot are wrong.
- Surfaced 2026-05-16 (Celtic v Hearts live test): Sportmonks's match_events stream missed a first-half goal. Narrator correctly refused to invent it (no-judgment-over-fact held), but every subsequent passage operated on a wrong score. I proposed a moderator correction UI; user reframed to use Sportmonks's per-fetch absolute scores (~30s next poll, self-healing). Use the snapshot.
- Reconciliation entries should be marked distinguishably in the audit trail (`sourceId` prefix like `recon-<type>-<uuid>`) so dedup handles the original eventually arriving from the source.
- Don't conflate with "trust the LLM to correct itself" — different and worse pattern. This is "trust the source's snapshot to be more reliable than its own stream's completeness."

## Single instance per third-party client
- One `Anthropic` client per app — `lib/anthropic.ts` exports `getAnthropic()`. Never `new Anthropic()` outside that module. Keeps retry budget, observability hooks, and cost discipline single-sourced.
- One Postgres pool per app — `db/connection.ts` exports the shared instance. Auth, users, app-data all import from there.
- Required env vars validated at boot in `env.ts`, never at the call site. Boot fails loud; runtime doesn't.

## Composition discipline (conductor + runner)
- `RoomConductor.ts` and `broadcast-runner.ts` extend by composition, not by adding methods. When either crosses ~500 LOC, split before the next change.
- Pattern: identify the distinct concerns (subscription, narration pipeline, playback scheduling, illustration coordination, source wiring, transcription wiring, lifecycle watchdog), give each its own module, leave a thin orchestrator that composes them. Each piece becomes individually testable.

## ESM
- `"type": "module"`. Use `.js` extensions in relative imports.

## Paid endpoints must be auth-gated
- Before shipping any endpoint that triggers a paid API call (Anthropic, Replicate, OpenAI, Deepgram, ElevenLabs, Sportmonks), verify the server enforces auth on that route.
- If the server has no auth middleware at all, **pause and flag**: "this endpoint triggers a paid call — the server has no auth middleware yet; do you want to add auth before shipping this route?" Don't ship more paid endpoints onto an open server.
- Permissive `cors()` (no options = any origin) is itself a flag. Origin-lock + auth on any server reaching paid APIs.
- Web-side auth (Better Auth) is **not** server auth. They share an attack surface but cover different routes. When auth is introduced anywhere in the system, ask: "does the backend API server also need auth?"

## Diagnostic surfaces use independent transport
- Admin/inspector surfaces poll over HTTP rather than reuse the user-facing WebSocket.
- Why: when the user-facing surface is silent, polling diagnostics can disambiguate "engine broken" from "WS broken." Two surfaces sharing transport can't.
- 4s polling is fine for debug tooling. Push-on-update is nice-to-have; transport falsifiability is essential.
- This applies to *new* admin surfaces specifically. User-facing surfaces (matchroom, moderator console) should keep using WS — they need real-time delivery.

## Room conductor authority
- The backend is the single authoritative room conductor. State, timing cues, and fan-out are all here.
- Next.js API routes (`apps/blackout/client/app/api`) are stateless and **must not be used for orchestration**.
- `setTimeout` in the conductor is the authoritative clock; clients react to cues.

## Narrative
- No LLM calls for prose live in `apps/blackout/server`. Push typed feed entries to Kairos; receive narratives back over the feed WS.

## Broadcast lifecycle
- `draft → scheduled → live → complete`. `broadcastId` is the shared key across the entire system.

## Migrations
- See [migrations](../migrations/SKILL.md) — auto-loads when touching `schema.ts` or `drizzle/`.
