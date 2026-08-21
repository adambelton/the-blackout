# packages/kairos/auth — the shared Better Auth factory for Kairos

`@kairos/auth`. One factory (`createAuth`) and one Drizzle schema (the `users` / `sessions` / `accounts` / `verifications` tables), instantiated by both `apps/kairos/client` (the admin app — **issues** sessions via email/password sign-in) and `apps/kairos/server` (the engine — **validates** the same session cookie on admin routes; consumer routes keep their service-token auth). Going through one factory is what makes a session issued on the admin app validate on the server without an HTTP hop: both sides agree on the cookie signing secret, the table model names, and (in prod) the cookie domain.

Mirrors `@blackout/auth` (the Blackout side's equivalent) in shape, but with two substantive differences: **email/password with sign-up disabled** (admin users are seeded by a CLI script — `apps/kairos/client/scripts/create-user.ts` — there is no public registration surface and no third-party OAuth); **no `role` column on `users`** (Kairos's admin app has one user type — being on the seeded list IS the security boundary).

For where this sits, see [`../README.md`](../README.md) (the packages overview) and the design rationale in [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md) § *Auth — mirroring `@blackout/auth`*.

## How it fits

```
                            packages/kairos/auth (@kairos/auth)
                            ┌──────────────────────────────────────────────────────────────┐
                            │  schema.ts:  users · sessions · accounts · verifications     │
                            │              (Drizzle pgTable defs + relations; NO role)     │
                            │  factory.ts: createAuth({ db, secret, baseURL, cookieDomain?,│
                            │              trustedOrigins? }) → BetterAuth                 │
                            │              — drizzleAdapter(db, {provider:"pg"}); modelName│
                            │              overrides → users/sessions/accounts/verifications│
                            │              cookiePrefix: "kairos-auth" (collision-safe on  │
                            │              a shared parent domain); emailAndPassword       │
                            │              enabled with disableSignUp (admin users seeded  │
                            │              via auth.api.signUpEmail in a CLI script)       │
                            └──────────────┬─────────────────────────────────┬─────────────┘
                              client instantiates                server instantiates
                              (apps/kairos/client/lib/auth.ts)              (apps/kairos/server/src/auth.ts)
                              ▼                                              ▼
                              createAuth({ db, secret, baseURL,            createAuth({ db, secret, baseURL,
                                cookieDomain: ".example.com",  cookieDomain: ".example.com" })
                                trustedOrigins: [client, api] })             — same shape; the validator never
                              │  ISSUES sessions:                              creates a user, only reads the cookie.
                              │   - email/password → /api/auth/sign-in/email │
                              │   - sign-up surface is closed; the CLI       │  VALIDATES only:
                              │     `scripts/create-user.ts` seeds users     │   auth.api.getSession({ headers })
                              │     via auth.api.signUpEmail (bypasses       │   on every admin-route request
                              │     disableSignUp, which only closes the     │   (consumer routes — broadcasts,
                              │     public HTTP sign-up surface)             │   feed, pool — keep apiKeyAuth)
                              ▼                                              ▼
                              browser ── session cookie "kairos-auth.*" (signed with `secret`, scoped to
                                         a shared parent domain so it is sent to both
                                         workbench and API hosts;
                                         host-only on localhost in dev) ──▶ both halves
                              ▲
                              both `drizzleAdapter`s point at the SAME `users`/`sessions`/`accounts`/`verifications`
                              tables — physically in apps/kairos/server's Postgres (the admin app has no DB
                              of its own; it reads/writes auth tables only — spec content goes through the
                              server's HTTP routes).
```

The shape that matters: **one factory, two callers, asymmetric roles** — same shape as `@blackout/auth`. The admin app's `createAuth` is the issuer; the server's is the validator. Both point at the same four tables; the shared `secret` and distinct `cookiePrefix` let a cookie cross configured sibling hosts without colliding with the Blackout-side session.

## What it does

- **`schema.ts`** — the Drizzle `pgTable` definitions Better Auth's drizzle adapter queries: `users` (`id` text PK, `name`, `email` unique, `emailVerified`, `image`, `createdAt`/`updatedAt`), `sessions` (`id`, `expiresAt`, `token` unique, `ipAddress`, `userAgent`, `userId` FK cascade; indexed on `userId`), `accounts` (the credential rows — `accountId`, `providerId` (`"credential"` for email/password), `userId` FK cascade, `password` (bcrypt hash); indexed on `userId`), `verifications` (`identifier`, `value`, `expiresAt`; indexed on `identifier`), plus the Drizzle `relations` wiring users↔sessions↔accounts. These tables live physically in `apps/kairos/server`'s Postgres database — re-exported from `apps/kairos/server/src/db/schema.ts` so drizzle-kit picks them up via the server's standard `pnpm db:generate` flow (the server owns the migration; the admin app just reads/writes against them).
- **`factory.ts`** — `createAuth(options)` configures Better Auth with the Drizzle client, shared signing secret, public auth origin, optional parent-domain cookie scope, and trusted origins. The `kairos-auth` cookie prefix prevents collisions with the Blackout session. Model names map to the shared auth tables; email/password sign-in is enabled while anonymous sign-up is disabled. The CLI provisioning script uses an explicit factory escape hatch.

## Contract

### Provided
- `createAuth(opts)` → a Better Auth instance. The admin app calls it for both sign-in handling and session validation; the server calls it for validation only. The shared `secret` + the `modelName` overrides + the `cookiePrefix` are what make a session cross between them without colliding with Blackout's cookies.
- The Drizzle schema (`users` / `sessions` / `accounts` / `verifications` + relations) — the four tables Better Auth needs; consumed by `apps/kairos/server`'s db client (which owns the database these tables live in) and re-imported by `apps/kairos/client`'s `lib/auth.ts` for its own Drizzle client over the same database.
- The user-provisioning contract: admin users are seeded by `apps/kairos/client/scripts/create-user.ts` (which calls `auth.api.signUpEmail` directly, bypassing the disabled public sign-up). There is no other way to add a user.

### Depended on
- `better-auth` (the framework — `betterAuth`, `drizzleAdapter`, the built-in email/password provider), `drizzle-orm` (the `pgTable` defs + `relations`), `zod`. Env (set on the *callers*, passed in): `BETTER_AUTH_SECRET` (identical on admin app + server), `DATABASE_URL` / `KAIROS_DB_URL` (the shared Postgres).
- The schema migrations for these tables live with `apps/kairos/server`'s drizzle setup (it owns the database) — see [`apps/kairos/server/src/db/README.md`](../../../apps/kairos/server/src/db/README.md) and the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md).

## Anti-patterns

- **Don't let the `secret` differ between callers.** A cookie issued on the admin app validates on the server *only* because both `createAuth` calls share `secret` + the table names. Two secrets = a session that works on one app and 401s on the other.
- **The server never creates users.** The admin app is the only writer of `users`/`accounts`. The server reads.
- **Don't drop `cookiePrefix: "kairos-auth"`.** A browser may send both Blackout and Kairos cookies across a configured shared parent domain. Distinct prefixes keep the two Better Auth instances from confusing each other's cookies.
- **One schema, one database.** The four auth tables are defined here once and live in `apps/kairos/server`'s Postgres; the admin app doesn't get its own copy. Don't fork the schema or the database.
- **Don't re-enable public sign-up to "make seeding easier".** Sign-up is closed deliberately — admin access is the security boundary, not an account anyone can self-create. Use `scripts/create-user.ts`.

## Open work

- **No passkey / MFA layer** — email/password is the only authentication factor. Better Auth's passkey plugin is the natural next addition when the admin user base grows past one, but solo use today doesn't need it.
- **No audit-log table** — admin-app edits go through `kairos-server` routes; route-level logging exists, but a dedicated `admin_audit_log` table (who promoted which spec, when) is defensible once more than one admin is editing concurrently.
- **No least-privilege DB split** — the server has full DB access for everything, including auth tables. A two-role split (auth-tables-only role for the admin app's Drizzle client; app-tables-only role for everything else) is a defence-in-depth addition for the post-MVP shape.

## See also

- [`../README.md`](../README.md) — the packages overview.
- [`apps/kairos/server/README.md`](../../../apps/kairos/server/README.md) — the validator side; the route-mounting split (consumer keeps `apiKeyAuth`, admin uses session middleware).
- [`apps/kairos/server/src/db/README.md`](../../../apps/kairos/server/src/db/README.md) — the database these tables live in + the re-export wiring.
- [`packages/blackout/auth/README.md`](../../blackout/auth/README.md) — `@blackout/auth`, the parallel pattern on the Blackout side.
- [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md) § *Auth — mirroring `@blackout/auth`* — the design rationale.
