# apps/kairos/client — Kairos admin app

`@kairos/client`. Next.js 16 App Router workbench on `:3001` for Kairos's content layer — event profiles, service specs, and spec versions. It calls `apps/kairos/server`'s admin routes via a Better Auth session cookie.

K6.3b ships the bootstrap: scaffold + auth loop. The K6.3b follow-up + K6.4 grow this into a per-cycle tuning workbench — see [`docs/kairos-admin-workbench-design.md`](../../../docs/kairos-admin-workbench-design.md) for the design.

For where this sits, see [`../README.md`](../README.md) (Kairos namespace overview) and [`apps/README.md`](../../README.md) (apps overview). For the auth contract, see [`packages/kairos/auth/README.md`](../../../packages/kairos/auth/README.md).

## How it fits

```
                  apps/kairos/client (this app — issuer)
                  ┌─────────────────────────────────────────────────────────────┐
                  │  Next.js 16 App Router, Tailwind v4 + daisyui v5            │
                  │  (default theme, utilitarian — see CLAUDE.md).              │
                  │  Sign-in → email/password (Better Auth) → session            │
                  │  (sign-up disabled; admin users seeded via                  │
                  │  `scripts/create-user.ts`)                                  │
                  │  cookie `kairos-auth.session_token` scoped to               │
                  │  host-only in local development; a configured shared parent │
                  │  domain can send it to both workbench and API hosts.         │
                  └────────────────────────┬────────────────────────────────────┘
                                           │
                          calls admin routes with cookie
                                           ▼
                  apps/kairos/server (validator) — `/profiles/*`, `/specs/*`
                  ┌─────────────────────────────────────────────────────────────┐
                  │  Better Auth validates the cookie. INTERNAL_API_SECRET      │
                  │  header bypass for tests + ops scripts. Consumer routes     │
                  │  (`/broadcasts/*`) keep their separate apiKey gate.         │
                  └─────────────────────────────────────────────────────────────┘
```

Both halves instantiate Better Auth from `@kairos/auth`'s `createAuth` factory. Same secret, same table model names, same cookie prefix — that's what makes a session issued here validate there without an HTTP hop.

## What it does (today — K6.3b scope)

- **Auth loop end-to-end.** Email/password sign-in via Better Auth; session cookie issued + validated. Sign-up is closed — admin users are seeded by `scripts/create-user.ts` (calls `auth.api.signUpEmail` via a one-off Better Auth instance with `allowSignUp: true` — a factory escape hatch the HTTP-facing instance never uses).
- **Sign-in screen** (`/login`) — email + password form. Generic "Sign-in failed" error for both wrong-password and unknown-user (no enumeration).
- **Proxy gate** (`proxy.ts`) — anonymous requests outside `/login` and `/api/auth/*` redirect to `/login` (cookie-presence check only; full validation happens in server components downstream).
- **Authenticated landing** (`/`) — placeholder; confirms the loop works.

## What it doesn't do yet

**Gated on prompts-as-content K6.5+ completing first** (per [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md) § *Per-service population*) — partial coverage leaves some services untunable, so the workbench waits until every service has a v1+ row.

Then:

- **Phase 1 — read-only inspector** across the four service-type sections (Assembly / Enrichment / Curation / Generation), porting the existing pipeline-inspector components from `apps/blackout/client/app/inspector/`. Sidebar with profile dropdown + services nested; broadcast picker; cycle navigation; click-through to archived spec versions.
- **Phase 2 — narrative-generation tuning.** Spec editor (prompt + eval criteria as markdown textareas), cycle inspector showing inputs + aired output, Run-eval action, Compare dialog (prompt / eval-result / output diffs), Publish flow gated on passing eval. Cycle-pool filtered to broadcasts whose resolved version equals current-active.
- **Phase 3+** extends tuning to imagery → summary → curation services → enrichment services, one service at a time.

Design: [`docs/kairos-admin-workbench-design.md`](../../../docs/kairos-admin-workbench-design.md). Phase 2 also includes the schema migration replacing `broadcasts.specOverrides` (unused) + `enrichmentServiceStates.specVersion` (dead bookkeeping) with `broadcasts.resolvedSpecVersions` (captures the full resolution at activation), and the eval refactor from [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md) § *Eval criteria as spec content*. The workbench subsumes K6.4's standalone form-based-editor scope. `broadcasts.config` (BroadcastConfig) stays out of scope here — separate concern.

## Contract

### Provides
- The web surface for editing Kairos content. The session it issues is the authentication token `apps/kairos/server` validates on admin routes.
- The Better Auth catch-all at `/api/auth/[...all]` — handles sign-in, sign-out, session reads.

### Depends on
- **`@kairos/auth`** (workspace) — the factory + Drizzle schema. Same `BETTER_AUTH_SECRET` as `apps/kairos/server`.
- **`apps/kairos/server`** at runtime — the admin routes (`/profiles`, `/specs`) the content pages will fetch from. Talks via HTTP cookie; no DB access for spec content (the kairos-server owns that surface).
- **Kairos's Postgres** at runtime — the four auth tables (`users` / `sessions` / `accounts` / `verifications`) live there. The admin app reads/writes auth tables only; spec content goes through HTTP. CI gets `KAIROS_DB_URL` at the job level (mirrors the Blackout pattern) so `next build` doesn't trip the import-time DB-URL throw in `lib/auth/db.ts`.

## Env

See `.env.example`. Load-bearing:
- `BETTER_AUTH_SECRET` — must match `apps/kairos/server`'s value (drift = silent 401s). Local development keeps the same generated value in both ignored `.env` files.
- `BETTER_AUTH_URL` — origin of this app; local development uses `http://localhost:3001`.
- `BETTER_AUTH_COOKIE_DOMAIN` — optional leading-dot parent domain for cross-subdomain scope; unset on localhost.
- `BETTER_AUTH_TRUSTED_ORIGINS` — comma-separated application and API origins.
- `KAIROS_DB_URL` — same Postgres as `apps/kairos/server`'s `DATABASE_URL`.

## Dev

```
pnpm --filter @kairos/client dev                   # http://localhost:3001
pnpm --filter @kairos/client create-user <email> "<name>" <password>   # seed an admin user
```

Requires `apps/kairos/server` to also be running (for the admin routes — relevant once content pages exist). Auth alone works without the server because the admin app talks directly to the DB for session storage.

## See also

- [`packages/kairos/auth/README.md`](../../../packages/kairos/auth/README.md) — the factory + schema this app consumes.
- [`apps/kairos/server/README.md`](../server/README.md) — the validator + admin routes.
- [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md) § *Kairos client — the CMS* — the broader content-model design.
- [`docs/kairos-admin-workbench-design.md`](../../../docs/kairos-admin-workbench-design.md) — the per-cycle tuning workbench design (what this app grows into).
