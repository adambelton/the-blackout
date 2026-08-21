import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

/**
 * Factory that creates a Better Auth instance from shared config.
 *
 * Both halves of Kairos instantiate Better Auth from this factory:
 *
 *   - `apps/kairos/client` (admin app) — the ISSUER.
 *     Handles email/password sign-in, issues session cookies, runs
 *     the `/api/auth/[...all]` catch-all. Passes `cookieDomain` in
 *     prod so the session cookie is scoped to the Kairos subdomains.
 *   - `apps/kairos/server` (engine) — the VALIDATOR. Never handles a
 *     sign-in, never creates a user. Only reads the cookie on admin
 *     routes (consumer routes keep service-token auth).
 *
 * The shared `secret` + the `modelName` overrides are what let a
 * cookie issued on the client validate on the server without an HTTP
 * hop. Drift the secret → silent 401s, no test catches it.
 *
 * The cookie name prefix is `kairos-auth.` (not Better Auth's default)
 * so it doesn't collide with `@blackout/auth`'s cookies — the browser
 * sends both to sibling hosts because of cross-subdomain
 * scoping; distinct names keep the two systems from confusing each
 * other.
 *
 * Sign-up is disabled — admin users are seeded manually by a CLI
 * script (`apps/kairos/client/scripts/create-user.ts`). There is no
 * public registration surface.
 */

export interface CreateAuthOptions {
  /** Drizzle client. Must have the auth tables (users, sessions,
   * accounts, verifications) in its schema so Better Auth's drizzle
   * adapter can query them. */
  db: Parameters<typeof drizzleAdapter>[0];
  /** Cookie signing secret — identical on every caller for
   * cross-instance cookie validation. Required. */
  secret: string;
  /** Public URL of the Better Auth server surface (the client's
   * `/api/auth/[...all]`). Used in redirect URLs and cookie origin. */
  baseURL: string;
  /** Set to a leading-dot parent domain to
   * scope the session cookie across the kairos.* subdomains. Leave
   * undefined in local dev — Better Auth defaults to host-only
   * cookies which work fine on localhost. */
  cookieDomain?: string;
  /** Set of trusted origins the auth server will accept requests
   * from. In prod this is the kairos web + api subdomains; in dev
   * it's `http://localhost:3001` + `http://localhost:5050`. */
  trustedOrigins?: string[];
  /** Escape hatch for the seed script in
   * `apps/kairos/client/scripts/create-user.ts`. Default `false` —
   * the HTTP-facing instances on the admin app + the server keep
   * sign-up closed. The seed script passes `true` to mint admin
   * users via `auth.api.signUpEmail`. Do not pass `true` from any
   * code path that handles an HTTP request. */
  allowSignUp?: boolean;
}

export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    secret: options.secret,
    baseURL: options.baseURL,
    ...(options.trustedOrigins ? { trustedOrigins: options.trustedOrigins } : {}),
    database: drizzleAdapter(options.db, { provider: "pg" }),
    ...(options.cookieDomain
      ? {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              domain: options.cookieDomain,
            },
            cookiePrefix: "kairos-auth",
          },
        }
      : { advanced: { cookiePrefix: "kairos-auth" } }),
    user: { modelName: "users" },
    session: { modelName: "sessions" },
    account: { modelName: "accounts" },
    verification: { modelName: "verifications" },
    emailAndPassword: {
      enabled: true,
      // Sign-up is closed on production instances — admin users are
      // seeded by the CLI script (`apps/kairos/client/scripts/create-user.ts`),
      // which passes `allowSignUp: true` to open the path. Better Auth's
      // `disableSignUp` blocks `auth.api.signUpEmail` at every layer,
      // not just the HTTP surface, so the seed script needs its own
      // factory instance with the flag flipped.
      disableSignUp: !options.allowSignUp,
    },
  });
}
