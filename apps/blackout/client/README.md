# apps/blackout/client — the Next.js frontend

Every user-facing surface: public discovery (landing, about, values, writing, replays), the listener matchroom, the writer/admin moderator console, the content studio, the pipeline inspector, and admin tooling. It renders — it holds **no orchestration state and no clock**. It calls `apps/blackout/server` over HTTP for CRUD and reads the server's WebSocket cues to drive the live experience; it never talks to Kairos directly. Next.js 16 App Router, runs on :3000.

This README is the frontend checkpoint: the surfaces, the seam to the server, the matchroom reveal architecture (the no-spoilers core), auth, what working looks like. For the Blackout consumer side as a whole (this + `../server/`) see [`../README.md`](../README.md); for the cross-service view (Blackout ↔ Kairos) see [`../../README.md`](../../README.md). The route directories where the orchestration is non-trivial — `app/matchroom/`, `app/moderator/` — have their own READMEs; the rest of the component layer is carried by docstrings, not READMEs (per the doc-system "how deep" guidance). The legacy [`docs/the-blackout-architecture.md`](../../../docs/the-blackout-architecture.md) is the canonical consumer-side architecture; it's being decomposed into this vertical + the `apps/blackout/server` one and carries a redirect header.

## How it fits

```
                 HTTP (CRUD, bootstrap views)          WS cues (server is the clock)
   ┌──────────┐ ─────────────────────────────▶ ┌───────────┐ ─────────────────────────▶ matchroom: connected → narrative/play/
   │   web    │   apiGet/apiPost/apiPatch       │  server   │   useReconnectingWebSocket   illustration/phase (+ passage_* bundle
   │  :3000   │   (credentials: include —       │  :4000    │   onMessage → discriminated  cues, mid-migration); broadcast_status_changed
   │          │    Better Auth cookie rides)    │           │   union dispatch             moderator: connected → feed_entry/latency_sample/
   └──────────┘ ◀───────────────────────────── └───────────┘ ◀───────────────────────────  narrative/play/generation_skipped + service status
        │  Better Auth (email/password) — sessions ISSUED here    │
        │  via the @blackout/auth factory; app/api/auth/[...all]  │  the web never talks to Kairos directly — the inspector
        │  is the handler. The server VALIDATES the same cookie.  │  surface reads apps/blackout/server's /broadcasts/:id/cycles|health|…
        ▼                                                         │  which proxy/aggregate Kairos's read endpoints.
   moderator browser also: HLS radio stream → Web Audio graph → AudioWorklet → linear16 PCM frames → /ws/moderator (binary) → server's Deepgram pipe
```

Three things to hold onto:
1. **The server is the authoritative clock — the web reacts.** Every `play` cue carries `playbackStartedAt` + `serverNow`; the client seeks audio to `(serverNow − playbackStartedAt) / 1000`. The `connected` snapshot does the same for late joiners. No client runs its own timeline.
2. **The web never talks to Kairos.** Anything the frontend needs from the engine (the pipeline inspector) goes through `apps/blackout/server` routes that proxy/aggregate Kairos's `GET /broadcasts/:id/*` reads. A Kairos URL in `apps/blackout/client` would be a seam violation.
3. **Audio is canonical, in the client too.** The matchroom shows nothing — text, events, score, illustration — before the narrator has spoken it. The reveal-walk (per-cover `charOffset` schedules + the staged-then-promoted event set) enforces this on the client side; the server's matchroom-cue whitelist enforces it on the wire. *(See the matchroom README.)*

## The surfaces

| Route | Audience | What it is |
|---|---|---|
| `app/page.tsx`, `app/about`, `app/values` | public | Concept documentation and discovery. Copy lives in `content/*.md`; `app/components/PublicLayout.tsx` is the shared shell. |
| `app/replays` | public | The archive grid of completed broadcasts (a `complete` broadcast not `archived` by admin curation). |
| `app/login` | public | Email/password sign-in for explicitly provisioned local accounts. `app/api/auth/[...all]` is the Better Auth handler — **sessions are issued here**; `lib/auth.ts` + `@blackout/auth`'s factory carry the user-create hook and admin-email stamping. |
| `app/matchroom/[broadcastId]` | member | **The live experience.** Subscribes to `/ws/matchroom`, walks per-passage canonical bundles so reveals fire in lock-step with the narrator's audio — no spoilers, no clock drift across browser tabs. Same URL flips to replay mode on `broadcast_status_changed`. → [`app/matchroom/README.md`](app/matchroom/README.md). |
| `app/moderator/[broadcastId]` | writer/admin | **The live control surface.** Subscribes to `/ws/moderator`; captures the UK radio stream in the browser (`useAudioCapture` — HLS → Web Audio → AudioWorklet → PCM frames → `/ws/moderator`); sends moderator-typed editorial directives; activates / completes the broadcast; shows the raw feed, the latency-calibration samples, the narrator-voice panel, the service-status dots. → [`app/moderator/README.md`](app/moderator/README.md). |
| `app/studio/[broadcastId]` | writer/admin | **The prep workspace.** Owns the match brief (`narrative_context`) and the illustration pool — ask for a batch of Haiku-suggested prompts, review 3–5 as cards, discard or generate each, then accept/regenerate/discard a generated image; accepted items land in the per-broadcast Kairos content pool via the Blackout proxy routes. (The narrative voice is a product-wide default from `content/voice.md`, not a per-broadcast field.) |
| `app/broadcasts` | writer/admin | The broadcasts list — CRUD, the create dialog (`app/components/NewBroadcastDialog.tsx`), per-row status + runner health, links into studio/moderator/matchroom/inspector. |
| `app/inspector/[broadcastId]` | writer/admin | **The pipeline inspector** for completed broadcasts — one view per Kairos flush cycle across four panels (Assembly = feed chunk, Enrichment = per-subject annotations, Curation = decisions + conflicts, Output = prose + imagery), a scrub strip with per-cycle drift bands, the flow-health header. Reads `apps/blackout/server`'s `/broadcasts/:id/cycles|health|generations|entries` (which proxy Kairos). |
| `app/admin/{users,radio-sources,tts-voices}` | admin | User-role management; the radio-source catalogue; the TTS-voice catalogue (with a capture-tester). `app/admin/components/CaptureTester.tsx` exercises the moderator audio pipeline in isolation. |

**Cross-cutting:** `lib/` (top-level) — the server seam: `api.ts` (`apiGet`/`apiPost`/`apiPatch`/`apiDelete` over `apiFetch`, which stamps `credentials: "include"` so the Better Auth cookie rides; `ApiError` with the server's error envelope unwrapped), `ws.ts` (`useReconnectingWebSocket(url, {onMessage, onOpen, onError, enabled})` — exponential backoff 1.5s→…→10s, resets on open; both the matchroom and moderator pages share it), `auth.ts` / `auth-client.ts` (Better Auth, web side — issues sessions), `routes.ts` (the route-path builders), `storage-keys.ts` (localStorage key registry — replay progress, console preferences), `transcription.ts`, `use-current-user.ts`. `app/lib/` — presentation: `palette.ts` (the brand tokens — `brand as C`), `format.ts`. `app/components/` — cross-route UI: `PublicLayout` / `Panel` / `Dialog` / `NewBroadcastDialog` / `AdminFooter` / `PageHeader` / `StatusPill` / `LandingBroadcastCard/`.

## Conventions

- App Router under `app/`; `"use client"` only where interactivity is required (most surfaces are heavily interactive — the matchroom and moderator pages are large client components).
- Routes follow `app/<route>/[id]/page.tsx` (the orchestrator) + `app/<route>/[id]/components/` (the visual pieces) + co-located `types.ts` / `utils.ts` / `derivations.ts` per route (the pure logic lifted out of the page so it's unit-testable without rendering — see `matchroom/[broadcastId]/derivations.ts`).
- Cross-route components in `app/components/`; brand tokens in `app/lib/palette.ts` (`brand as C`); server seam in `lib/api.ts` + `lib/ws.ts`.
- Auth via Better Auth: the web side issues sessions and the server validates the same cookie. Local development uses a host-only cookie, which is why auth-sensitive surfaces are tested through the web's dev proxy. Server-side role checks are the security boundary; client checks are only UX.
- Vitest for tests (`vitest.config.ts`) — pure modules tested (`lib/api.test.ts`, `lib/ws.test.ts`, `app/lib/format.test.ts`, `app/matchroom/[broadcastId]/derivations.test.ts`); React rendering is not currently a tested surface.

## What working looks like

`pnpm --filter @blackout/client dev` (or `pnpm run dev` from the repo root). The matchroom on a live broadcast: `connected` → `play` cue → audio seeks to the server offset → text reveals word-by-word in step → the event ribbon promotes a staged event when its narration's audio passes the cover anchor (or at audio-end if uncited) → the illustration swaps on the passage's audio start → the match-clock label tracks `batchContentTime` / `revealedCanonical.matchMinute` (monotonic — never regresses) → on `broadcast_status_changed` the page refetches `GET /broadcasts/:id` and flips to replay mode (client-owned playback, no spoilers even on replay, no scrubbing). The moderator console: the radio stream playing through the page's audio element, PCM frames streaming over `/ws/moderator`, the feed scrolling (raw `feed_entry` cues), the latency samples updating as calibration lands, the service-status dots green, "activate" / "complete" working. The `useReconnectingWebSocket` status pill showing `open`; a transient drop reconnects with backoff and resumes (matchroom re-backfills via `GET /broadcasts/:id`; moderator resumes capture).

## Development

```bash
pnpm --filter @blackout/client dev      # Next.js dev server on :3000
pnpm --filter @blackout/client build
pnpm --filter @blackout/client test     # vitest
```

`apps/blackout/client` doesn't own a database — Better Auth uses the server's Postgres (schema in `@blackout/auth`); schema work happens in `apps/blackout/server` / `apps/kairos/server` (see [`.claude/skills/migrations/SKILL.md`](../../../.claude/skills/migrations/SKILL.md)). Env: `NEXT_PUBLIC_API_URL` (the server origin — the WS origin is derived from it, no second env var), `BETTER_AUTH_SECRET` (same as the server's), and the PostHog key. The former hosted deployment has been retired.

## Open work — web-wide

WIP spanning more than one route lives here; route-internal WIP lives in that route's README; cross-half items (spanning `client/` + `server/`) in [`../README.md`](../README.md) § Open work; cross-service items (spanning Blackout + Kairos) in [`../../README.md`](../../README.md) § Open work. The items below are retained as technical follow-up ideas from the codebase audits, not an active roadmap.

- **Matchroom + moderator hook extraction.** Both `page.tsx` files are large (matchroom ~1355 lines, moderator ~1017) — many `useState`/`useEffect` calls in one file. The audit's plan: extract cohesive subsystems into custom hooks (the WS subscription + dispatch, the audio playback scheduler, the reveal-walk, the replay-progress persistence on the matchroom side; the capture lifecycle is already `useAudioCapture`). **Blocked on integration tests first** — extracting without a test harness risks silent regression in the reveal contract. Tracked in [`docs/codebase-audit-2026-05-10.md`](../../../docs/codebase-audit-2026-05-10.md); summarised in the route READMEs.
- **The matchroom consumes the legacy playback cues, not the bundle cues.** The server fans both (`narrative`/`play`/`illustration` and `passage_*`/`broadcast_status_changed`); the matchroom currently walks the legacy path. Sub-piece 4c flips it to the bundle path (then `derivations.ts`'s `deriveScore` / `latestMinute` / `computeMatchMinuteLabel` simplify — the server-authored `revealedCanonical` becomes the source of truth); 4d retires the legacy cues. → [`docs/matchroom-reveal-architecture-scoping.md`](../../../docs/matchroom-reveal-architecture-scoping.md).
- **No React-rendering test coverage.** Pure modules are tested; the components aren't. The reveal contract's pure parts (`computeCoverRevealSchedule`, `computeMatchMinuteLabel`, `deriveScore`) are characterised in `derivations.test.ts`, but the page orchestration that wires them to audio/RAF/WS isn't. The hook extraction above is partly motivated by making that testable.
- **`docs/the-blackout-architecture.md` has drifted** — it predates the Design-A bundle architecture and the current cue vocabulary. Carries a redirect header; treat this vertical as canonical for `apps/blackout/client` and the legacy doc as background.

## See also

- [`../README.md`](../README.md) — the Blackout consumer side (the two halves) and the client↔server seam.
- [`../../README.md`](../../README.md) — `apps/` — the two services (Blackout + Kairos) and the inter-service seam.
- [`app/matchroom/README.md`](app/matchroom/README.md) — the live experience: the reveal architecture, the cue handling, the audio scheduler, replay mode.
- [`app/moderator/README.md`](app/moderator/README.md) — the live control surface: the audio capture pipeline, the editorial steering, activation/completion.
- [`apps/blackout/server/README.md`](../server/README.md) — the backend whose cues this frontend reads; the conductor's authority + cue vocabulary.
- [`CLAUDE.md`](CLAUDE.md) — conventions for AI-assisted dev (thin pointer + rules).
- [`.claude/skills/blackout-client/SKILL.md`](../../../.claude/skills/blackout-client/SKILL.md) — the rule set, auto-loaded on `apps/blackout/client/**` reads.
- [`packages/README.md`](../../../packages/README.md) — `@blackout/shared` (the cue types, the canonical-state helpers) and `@blackout/auth` (the Better Auth factory this app uses to issue sessions).
- [`docs/the-blackout-architecture.md`](../../../docs/the-blackout-architecture.md) — legacy canonical doc, being decomposed here; drifted.
