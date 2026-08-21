/**
 * Server-side Better Auth instance — session validation only.
 *
 * Instantiated from the shared factory in `@kairos/auth` with the
 * same secret as the admin app. Sessions issued on the admin app
 * (via email/password sign-in) validate here without an HTTP hop.
 * The server never CREATES sessions — it only reads them. The factory
 * is configured identically on both sides; this instance behaves as
 * a validator because no sign-in HTTP surface is mounted here.
 *
 * Used by `session-middleware.ts` for admin-route auth. Consumer
 * routes (broadcasts, narrative, pool, feed — the surfaces
 * `apps/blackout/server` calls) keep the bearer-token check in
 * `api-key-middleware.ts`.
 */
import { createAuth } from "@kairos/auth";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as authSchema from "@kairos/auth";
import "./env.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set — the auth session validator needs a Postgres connection",
  );
}

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  throw new Error(
    "BETTER_AUTH_SECRET is not set — the auth session validator needs it to verify cookies issued on the admin app",
  );
}

// Separate pg client from the engine's primary db client so the auth
// queries stay independent (connection-pool-wise + so a Better Auth
// query never blocks an engine query and vice versa).
const client = postgres(connectionString, { prepare: false });
const authDb = drizzle(client, { schema: authSchema });

export const auth = createAuth({
  db: authDb,
  secret,
  // baseURL points at the admin app — that's where Better Auth's
  // OAuth callback routes live. The server never hosts them.
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
  cookieDomain: process.env.BETTER_AUTH_COOKIE_DOMAIN,
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
});
