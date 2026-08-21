# packages/blackout/auth — the shared Better Auth factory

`@blackout/auth`. One factory (`createAuth`) and one Drizzle schema (the `users` / `sessions` / `accounts` / `verifications` tables), instantiated by both `apps/blackout/client` (which **issues** email/password sessions) and `apps/blackout/server` (which **validates** the same session cookie). Going through one factory is what makes a session issued on the web validate on the server without an HTTP hop: both sides agree on the cookie signing secret, the table model names, the `role` field schema, and the optional cookie domain.

For where this sits, see [`../README.md`](../../README.md). This README goes one level deeper.

## How it fits

```
                          packages/blackout/auth (@blackout/auth)
                          ┌───────────────────────────────────────────────────────────────┐
                          │  schema.ts:  users · sessions · accounts · verifications         │
                          │              (Drizzle pgTable defs + relations)                  │
                          │  factory.ts: createAuth({ db, secret, baseURL, cookieDomain?,    │
                          │              trustedOrigins?, adminEmail? }) → BetterAuth          │
                          │              — drizzleAdapter(db, {provider:"pg"}); modelName     │
                          │              overrides → users/sessions/accounts/verifications;   │
                          │              user.role custom field (input:false); emailAndPass   │
                          │              enabled; provisioned credential accounts             │
                          └──────────────┬──────────────────────────────────┬────────────────┘
                            web instantiates                  server instantiates
                            (apps/blackout/client/lib/auth.ts)             (apps/blackout/server/src/lib/auth.ts)
                            ▼                                  ▼
              createAuth({ db, secret, baseURL,    createAuth({ db, secret, baseURL,
                cookieDomain: ".example.com", cookieDomain: ".example.com" })
                trustedOrigins: [web, api],                — NO adminEmail: the server never
                adminEmail })                                creates a user.
                │  ISSUES sessions:                          │  VALIDATES only:
                │   - email/password sign-in for explicitly │   auth.api.getSession({ headers })
                │     provisioned accounts                   │   on every HTTP request (the
                │     → /api/auth/[...all]                   │   `authContext` middleware) and on
                │                                            │   every WS upgrade (raw `upgrade`
                │   - databaseHooks.user.create.before:      │
                │     stamps role:"admin" if email ==       │
                │     adminEmail, else null                   │
                ▼                                            ▼
              browser ── session cookie (signed with `secret`, optionally scoped to a
                         shared parent domain; host-only on localhost in dev) ──▶ both apps
                ▲
              both `drizzleAdapter`s point at the SAME `users`/`sessions`/`accounts`/`verifications`
              tables — physically in apps/blackout/server's Postgres (apps/blackout/client has no DB of its own).
```

The shape that matters: **one factory, two callers, asymmetric roles.** The web's `createAuth` carries the user-create hook and admin-email stamping; the server only reads the cookie. Both point at the same four tables; the shared `secret` is what lets a cookie cross between them.

## What it does

- **`schema.ts`** — the Drizzle `pgTable` definitions Better Auth's drizzle adapter queries: `users` (`id` text PK, `name`, `email` unique, `emailVerified`, `image`, `createdAt`/`updatedAt`, `role` text nullable — `null` = regular member, `"writer"` = commissioned contributor, `"admin"` = staff; set by the web's user-create hook, read-only from the client), `sessions` (`id`, `expiresAt`, `token` unique, `ipAddress`, `userAgent`, `userId` FK cascade; indexed on `userId`), `accounts` (the OAuth/credential rows — `accountId`, `providerId`, `userId` FK cascade, `accessToken`/`refreshToken`/`idToken`, `password` (for the email/password fallback); indexed on `userId`), `verifications` (`identifier`, `value`, `expiresAt`; indexed on `identifier`), plus the Drizzle `relations` wiring users↔sessions↔accounts. These tables live physically in `apps/blackout/server`'s Postgres database (the web doesn't own one) — the web's `lib/auth.ts` and the server's `lib/auth.ts` both build a Drizzle client over that database with this schema and pass it to `createAuth`.
- **`factory.ts`** — `createAuth(options)` configures Better Auth with the Drizzle client, shared signing secret, public auth origin, optional parent-domain cookie scope, and trusted origins. The web can enable an OAuth provider and administrator-email hook; the server instantiates the same factory only to validate sessions. Model names map to the shared auth tables, and the custom role field cannot be supplied by a client.

## Contract

### Provided
- `createAuth(opts)` → a Better Auth instance. The web calls it with the admin-email hook and issues sessions; the server calls it without the hook and only validates. The shared `secret` + the `modelName` overrides are what make a session cross between them.
- The Drizzle schema (`users` / `sessions` / `accounts` / `verifications` + relations) — the four tables Better Auth needs; consumed by `apps/blackout/server`'s db client (which owns the database these tables live in) and re-imported by `apps/blackout/client`'s `lib/auth.ts` for its own Drizzle client over the same database.
- The `role` field contract: `null` = member, `"writer"` = commissioned contributor (moderator-view access for their own broadcasts — writer-scoped gating is future work), `"admin"` = staff (every moderator view + the inspector + the radio-source catalogue). Set server-side by the web's user-create hook (admin-email match) or by `apps/blackout/server`'s `setUserRole` (admin user management); never client-settable.

### Depended on
- `better-auth` (the framework — `betterAuth`, `drizzleAdapter`), `drizzle-orm` (the `pgTable` defs + `relations`), `zod`. Env (set on the *callers*, passed in): `BETTER_AUTH_SECRET` (identical on web + server), the admin email (web only), and `DATABASE_URL` (the shared Postgres). Builds to `dist/` via `tsc`; `apps/blackout/client` and `apps/blackout/server` resolve `@blackout/auth` via the workspace.
- The schema migrations for these tables live with `apps/blackout/server`'s drizzle setup (it owns the database) — see [`apps/blackout/server/src/db/README.md`](../../../apps/blackout/server/src/db/README.md) and the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md).

## Anti-patterns

- **Don't let the `secret` differ between callers.** A web-issued cookie validates on the server *only* because both `createAuth` calls share `secret` + the table names. Two secrets = a session that works on one app and 401s on the other.
- **The server never creates users.** It instantiates `createAuth` without `adminEmail`, so it has no `user.create` hook. Sign-ins happen on the web; the server reads the result.
- **`role` is not client-settable.** It's an `input: false` custom field; only the web's user-create hook and `apps/blackout/server`'s `setUserRole` write it. The web's role checks (e.g. `useCurrentUser().isAdmin`) are UX, not the security boundary — paid endpoints in `apps/blackout/server` re-check with `requireRole`.
- **One schema, one database.** The four auth tables are defined here once and live in `apps/blackout/server`'s Postgres; the web doesn't get its own copy. Don't fork the schema or the database.

## Open work

- **Writer-scoped gating was not completed** — a `"writer"` can currently access any moderator view. The role contract is in place; per-broadcast scoping is not wired.
- **There is no public sign-up flow.** Email/password accounts are explicitly provisioned for local inspection of protected routes.

## See also

- [`../README.md`](../../README.md) — the packages overview; the web-issues / server-validates asymmetry in the cross-app context.
- [`apps/blackout/client/README.md`](../../../apps/blackout/client/README.md) (the side that issues — `lib/auth.ts`, `app/api/auth/[...all]`), [`apps/blackout/server/README.md`](../../../apps/blackout/server/README.md) (the side that validates — `lib/auth.ts`, `lib/auth-middleware.ts`, the WS-upgrade cookie check) and [`apps/blackout/server/src/db/README.md`](../../../apps/blackout/server/src/db/README.md) (the database these tables live in).
- [root `CLAUDE.md` § "Provisioning local accounts"](../../../CLAUDE.md) — the email/password flow and its `show-login` visibility flag.
- [`packages/blackout/shared/README.md`](../shared/README.md) — `UserRole` / `isUserRole` / `isAdmin` (the role *type*; the role *table column* is here).
