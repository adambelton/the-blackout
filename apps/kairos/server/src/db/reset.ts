/**
 * Local DB reset — the documented SOP when `db:check` reports drift.
 *
 * Drops the `public` schema, recreates it, runs migrations, runs seed.
 * The migration system becomes the source of truth again in one
 * command. Safer than surgical interventions, because the failure mode
 * of "the cursor said X but the schema was at Y" can't recur from a
 * fresh start.
 *
 * Safety: refuses to run unless DATABASE_URL points at a local DB
 * whose name contains `kairos` AND host is loopback. Prod DBs (Neon,
 * Fly Postgres) will fail this check by hostname.
 */
import "../env.js";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "../..");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[db:reset] DATABASE_URL is not set");
  process.exit(1);
}

const parsed = new URL(url);
const dbName = parsed.pathname.replace(/^\//, "");
const host = parsed.hostname;
const isLoopback =
  host === "localhost" || host === "127.0.0.1" || host === "::1";
const looksLocal = dbName.includes("kairos") && isLoopback;

if (!looksLocal) {
  console.error(
    `[db:reset] REFUSED — DATABASE_URL doesn't look local (host=${host}, db=${dbName}).`,
  );
  console.error(
    `  This script wipes the database. Only runs against loopback hosts with "kairos" in the db name.`,
  );
  process.exit(1);
}

console.log(`[db:reset] Wiping ${dbName} at ${host}…`);

const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
// public schema is the application schema; drizzle.__drizzle_migrations
// lives in its own schema and gets dropped too. CASCADE handles FKs.
await client.unsafe("DROP SCHEMA IF EXISTS public CASCADE");
await client.unsafe("DROP SCHEMA IF EXISTS drizzle CASCADE");
await client.unsafe("CREATE SCHEMA public");
await client.unsafe(`GRANT ALL ON SCHEMA public TO public`);
await client.end();

console.log(`[db:reset] Running migrate…`);
const migrate = spawnSync("pnpm", ["exec", "tsx", "src/db/migrate.ts"], {
  cwd: serverRoot,
  stdio: "inherit",
});
if (migrate.status !== 0) {
  console.error("[db:reset] migrate failed");
  process.exit(migrate.status ?? 1);
}

console.log(`[db:reset] Running seed…`);
const seed = spawnSync("pnpm", ["exec", "tsx", "src/db/seed.ts"], {
  cwd: serverRoot,
  stdio: "inherit",
});
if (seed.status !== 0) {
  console.error("[db:reset] seed failed");
  process.exit(seed.status ?? 1);
}

console.log(`[db:reset] OK — ${dbName} reset, migrated, and seeded.`);
