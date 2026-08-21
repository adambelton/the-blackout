import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@blackout/auth";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set — Better Auth needs a Postgres connection",
  );
}

// Single long-lived client. Better Auth is server-side (Next.js route
// handlers); the Next.js lambda / Node process keeps this warm across
// requests. `prepare: false` plays nicely with Neon's pooled connection.
const client = postgres(connectionString, { prepare: false });

export const db = drizzle(client, { schema });
