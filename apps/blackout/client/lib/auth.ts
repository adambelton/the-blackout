import { createAuth } from "@blackout/auth";
import { db } from "./auth/db";

/**
 * Better Auth is the single source of truth for user identity.
 *
 * Config lives in `packages/blackout/auth/factory.ts` so the Blackout server
 * can instantiate an identical Better Auth with the same secret and
 * cookie config — sessions issued on the web side validate on the
 * server side without an HTTP hop.
 *
 * Admin promotion is keyed on the ADMIN_EMAIL env var at first
 * sign-in (databaseHooks.user.create). Server-only.
 */
export const auth = createAuth({
  db,
  secret: process.env.BETTER_AUTH_SECRET!,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  cookieDomain: process.env.BETTER_AUTH_COOKIE_DOMAIN,
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
  adminEmail: process.env.ADMIN_EMAIL,
});
