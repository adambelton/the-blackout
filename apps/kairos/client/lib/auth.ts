/**
 * Better Auth is the single source of truth for admin-app identity.
 *
 * Config lives in `packages/kairos/auth/factory.ts` so `apps/kairos/server`
 * can instantiate an identical Better Auth with the same secret and
 * cookie config — sessions issued here validate on the server side
 * without an HTTP hop.
 *
 * The admin app is the ISSUER: handles email/password sign-in and
 * issues the session cookie. `apps/kairos/server` is validator-only.
 * Sign-up is disabled — admin users are seeded by the CLI script
 * at `scripts/create-user.ts`.
 *
 * Mirrors the Blackout client's `lib/auth.ts` shape — direct
 * module-level instantiation, env values passed straight through.
 * Better Auth tolerates undefined env at construction (the build-time
 * page-data collection succeeds even without secrets set); missing
 * env surfaces at the first sign-in request, where it belongs.
 */
import { createAuth } from "@kairos/auth";
import { db } from "./auth/db";

export const auth = createAuth({
  db,
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
  cookieDomain: process.env.BETTER_AUTH_COOKIE_DOMAIN,
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
});
