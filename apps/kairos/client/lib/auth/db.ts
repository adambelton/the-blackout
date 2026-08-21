/**
 * Drizzle client for Better Auth.
 *
 * The four auth tables live in Kairos's Postgres (`KAIROS_DB_URL`), the
 * same database as the engine's app tables. The schema definitions come
 * from `@kairos/auth` so the admin app (issuer) and `apps/kairos/server`
 * (validator) talk to the same shape.
 *
 * Sessions issued here validate on the server because both halves go
 * through `@kairos/auth`'s factory with the same `BETTER_AUTH_SECRET`.
 *
 * Mirrors the Blackout client's `lib/auth/db.ts` shape — direct
 * module-level instantiation; CI provides `KAIROS_DB_URL` at the job
 * level so the build-time route-data collection doesn't throw.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@kairos/auth";

const connectionString = process.env.KAIROS_DB_URL;
if (!connectionString) {
  throw new Error(
    "KAIROS_DB_URL is not set — Better Auth needs a Postgres connection",
  );
}

// Single long-lived client. Better Auth is server-side (Next.js route
// handlers); the Next.js lambda / Node process keeps this warm across
// requests. `prepare: false` plays nicely with Neon's pooled connection.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
