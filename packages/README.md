# packages/ — the cross-app shared code

Three workspace packages, each consumed by more than one app, all deliberately small:

- **`packages/blackout/shared`** (`@blackout/shared`) — the Blackout side's TypeScript types hub (`apps/blackout/server` + `apps/blackout/client`). Every shape those two both touch lives here: the WebSocket cue contracts the server emits and the matchroom/moderator clients consume, the per-passage canonical-state bundle, the broadcast/event/match-time/radio-source/user/pipeline-cycle types, the type guards and the pure match-time helpers. A change to one is caught at compile time across `apps/blackout/server` and `apps/blackout/client`. **The Kairos side does not consume this package** — the Kairos seam is the HTTP/WS wire, not shared TypeScript.
- **`packages/blackout/auth`** (`@blackout/auth`) — the Better Auth factory + the auth-table Drizzle schema, instantiated by both `apps/blackout/client` (which *issues* sessions) and `apps/blackout/server` (which *validates* them). One factory means both sides agree on the cookie secret, table names, role field, and cookie domain.
- **`packages/kairos/auth`** (`@kairos/auth`) — the parallel Better Auth factory for Kairos's halves: `apps/kairos/client` issues sessions and `apps/kairos/server` validates them on admin routes. Its `kairos-auth` cookie prefix prevents collisions if both auth systems share a parent domain. The schema mirrors `@blackout/auth` without the role column because Kairos has one seeded administrator type. The Blackout side does not consume this package; the Kairos halves do not consume `@blackout/auth`.

This README is the packages checkpoint. For where they sit among the apps, see [`apps/README.md`](../apps/README.md). Each package has its own README.

## How it fits

```
                    ┌─────────────────── packages/blackout/shared (@blackout/shared) ────────────────────┐
                    │  types/  — broadcast · canonical-state · passage · events · match-time · pipeline-  │
                    │            cycle · radio-source · user · fixtures · schedule · service-status        │
                    │  + the SOURCE constants, the type guards (isBroadcastStatus / isTeamSide / …),       │
                    │    the pure helpers (parseContentTime / compareEventsByMatchTime /                   │
                    │    applyRevealingCanonical / emptyCanonicalState / isLivePhase / collectSchedule-    │
                    │    Blockers)                                                                          │
                    └──────────────┬──────────────────────────┬────────────────────────────────────────────┘
              import @blackout/shared  │                          │
                    ▼                  ▼
              ┌──────────┐       ┌──────────┐    HTTP/WS (the     ┌──────────┐  ╳ no dep on @blackout/shared.
              │  apps/blackout/client │       │apps/blackout/server│   typed Kairos     │apps/kairos/server│     The seam is the HTTP/WS wire, not
              │           │       │           │   client — the    │           │     shared types. A shape needed both
              │ cue types,│◀─WS───│ the cue   │   wire is the     │ (its own  │     sides is duplicated — Kairos owns its
              │ Canonical-│ cues  │ types it  │───contract)──────▶│  types)   │     API enums, the Blackout's pipeline-
              │ State,    │       │ emits,    │◀──────────────────│           │     cycle.ts mirrors them (Kairos never
              │ Passage,  │──HTTP─│ Canonical-│                   └──────────┘     imports that back). No "domain-
              │ Broadcast,│ DTOs  │ State the │                                    agnostic subset Kairos may import."
              │ Moderator-│       │ conductor │
              │ View, …   │       │ composes  │
              └──────────┘       └──────────┘
                    │  ┌─────────────── packages/blackout/auth (@blackout/auth) ────────────┐
                    │  │  createAuth(opts) — the Better Auth factory                      │
                    │  │  + the Drizzle schema: users · sessions · accounts · verifications│
                    └──┤  web:    createAuth({ db, secret, baseURL, cookieDomain, oauth,   │
              import   │           adminEmail })  — ISSUES sessions (OAuth, the             │
              @blackout/│           user-create hook, account-linking)                       │
              auth     │  server: createAuth({ db, secret, baseURL, cookieDomain })          │
                       │           — VALIDATES the same cookie (no provider/create hook)     │
                       └─────────────────────────────────────────────────────────────────────┘
                          both point their drizzle adapter at the SAME `users`/`sessions`/
                          `accounts`/`verifications` tables in apps/blackout/server's Postgres
```

The shape that matters: **`@blackout/shared` is the Blackout side's floor — `apps/blackout/server` + `apps/blackout/client`. `apps/kairos/server` does not consume it.** The seam between Kairos and the Blackout is the HTTP/WS wire (`apps/blackout/server/src/lib/kairos.ts`), not shared TypeScript — Kairos doesn't compile-couple to its consumer. A shape genuinely needed on both sides is duplicated, not shared — and it's almost always Kairos that owns it (it's the engine; the Blackout is the consumer): Kairos owns its API enums, the Blackout side mirrors them (`packages/blackout/shared/types/pipeline-cycle.ts` is that mirror; the longer-term direction is a Kairos-owned types package the Blackout imports). `@blackout/auth` is likewise consumed by exactly two apps (web + server, not Kairos), with the *roles* asymmetric — the web issues, the server validates.

## What working looks like

`pnpm run build` from the repo root builds `@blackout/shared` (→ `dist/types/`) and `@blackout/auth` (→ `dist/`) before the apps; `apps/blackout/client` and `apps/blackout/server` resolve both via the workspace (`apps/kairos/server` depends on neither — it has its own types and its own auth allowlist). A WS cue shape change in `packages/blackout/shared/types/passage.ts` fails `tsc` in both `apps/blackout/server` (the emitter) and `apps/blackout/client` (the consumer) if either drifts. A session issued by the web validates in the server without an HTTP hop because both `createAuth` calls share the secret + the table names. `pnpm --filter @blackout/shared test` runs the pure-helper tests (`tests/match-time.test.ts`, `tests/schedule.test.ts`, `tests/matchroom-cue-roundtrip.test.ts`, `tests/canonical-state.test.ts`, `tests/type-guards-and-records.test.ts`).

## Open work — packages-wide

- **`pipeline-cycle.ts` is a hand-maintained mirror of Kairos's API output.** A Kairos-side change to those shapes has to be re-typed by hand in `@blackout/shared`. Longer-term: lift it into a Kairos-owned types package the Blackout imports — Kairos owns its contract, the Blackout consumes it, no hand-mirroring. Cross-app design. Tracked in [`docs/codebase-audit-2026-05-10.md`](../docs/codebase-audit-2026-05-10.md) and [`apps/README.md`](../apps/README.md) § Open work. *(The earlier "split the barrel into an engine-agnostic sub-barrel so a Kairos import of a football type fails to resolve" plan was dropped 2026-05-12 — Kairos doesn't consume `@blackout/shared` at all, so there's nothing to partition for it; the standing rule is "Kairos imports nothing from `@blackout/shared`; cross-seam shapes are duplicated.")*
- **`BroadcastStatus` / `ConnectedCue` name collisions.** `BroadcastStatus` is declared in `@blackout/shared` *and* in `apps/blackout/server`'s + `apps/kairos/server`'s db `enums.ts` (different value sets — `draft/scheduled/live/complete/archived` here, `pending/active/paused/complete` in Kairos) — same name, different meanings, a name collision waiting to confuse. `ConnectedCue` is declared in `@blackout/shared/passage.ts` (`currentPassage`) *and* in `apps/blackout/server/src/conductor/types.ts` (legacy, `currentPlay`) — both ship on the `connected` cue today. Resolving the `ConnectedCue` one is the moderator-WS-protocol typing work; the `BroadcastStatus` one is a rename. Cross-app. Tracked in [`docs/codebase-audit-2026-05-10.md`](../docs/codebase-audit-2026-05-10.md).
- **The matchroom cue contract is mid-migration.** `@blackout/shared/passage.ts` declares the bundle cues (`passage_added` / `passage_audio_ready` / `passage_started` / `passage_skipped` / `passage_updated` / `broadcast_status_changed` / the `MatchroomCue` union) — but the matchroom still consumes the legacy `narrative`/`play`/`illustration` cues (which aren't in `@blackout/shared`). Sub-piece 4c flips the matchroom; 4d retires the legacy cues; at that point the matchroom cue contract is *only* what's in `passage.ts`. → [`docs/matchroom-reveal-architecture-scoping.md`](../docs/matchroom-reveal-architecture-scoping.md).

## See also

- [`packages/blackout/shared/README.md`](blackout/shared/README.md) — the types hub: the barrel layout, the cue contracts, the canonical-state bundle, the Kairos seam, the type-guard + pure-helper conventions.
- [`packages/blackout/auth/README.md`](blackout/auth/README.md) — the Better Auth factory + the auth schema; the web-issues / server-validates asymmetry.
- [`apps/README.md`](../apps/README.md) — the four applications and their seams; how each side uses these packages.
- [`.claude/skills/blackout-shared/SKILL.md`](../.claude/skills/blackout-shared/SKILL.md) — the rule set, auto-loaded on `packages/blackout/shared/**` reads.
