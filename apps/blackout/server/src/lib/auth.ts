/**
 * Server-side Better Auth — session validation only.
 *
 * Instantiated from the shared factory in `@blackout/auth` with the
 * same secret as the web. Sessions issued by the web validate here
 * without an HTTP hop.
 *
 * The server never CREATES sessions — it only reads them. So this
 * instance omits the user.create hook and admin-email stamping logic.
 * Those only run on the web side where sign-ins happen.
 */
import { createAuth } from "@blackout/auth";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as authSchema from "@blackout/auth";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set — the auth session validator needs a Postgres connection",
  );
}

// Separate pg client from the server's app-data client so the two
// concerns stay independent (connection-pool-wise, migration-wise,
// and rebuild-wise).
const client = postgres(connectionString, { prepare: false });
const authDb = drizzle(client, { schema: authSchema });

export const auth = createAuth({
  db: authDb,
  secret: process.env.BETTER_AUTH_SECRET!,
  // baseURL points at the web side, where Better Auth's routes live.
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  cookieDomain: process.env.BETTER_AUTH_COOKIE_DOMAIN,
  trustedOrigins: (process.env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean),
});
