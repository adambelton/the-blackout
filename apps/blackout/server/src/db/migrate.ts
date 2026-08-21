/**
 * Pre-start migration runner. Used in three places:
 *   - Dev: `predev` script in package.json runs this via tsx before
 *     `tsx watch` starts.
 *   - Tests: `pretest` script runs this against `blackout_test` before
 *     the suite executes.
 *   - Ad-hoc: `pnpm db:migrate` for manual verification + the
 *     migration-smoke test imports `runMigrations()` to drive a
 *     fresh-DB migration in-test.
 *
 * Idempotent — Drizzle's `__drizzle_migrations` table records what's
 * already applied, so a run with no new migrations is a no-op.
 *
 * Programmatic migrator (not drizzle-kit) so we don't need devDeps
 * in the runtime image, and so it can run in non-TTY shells where
 * drizzle-kit's interactive prompts would block.
 */
// `./env.js` populates process.env from `.env` if not already set —
// matters for the `predev` hook and ad-hoc local runs. Production
// relies on the env being injected by the platform; the loader is
// a no-op when DATABASE_URL is already set.
import "../env.js";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function runMigrations(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/db/migrate.js → apps/blackout/server/drizzle (siblings of dist/).
  const migrationsFolder = resolve(here, "../../drizzle");

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("[migrate] DATABASE_URL is not set");
  }

  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(client);

  console.log(`[migrate] applying any pending migrations from ${migrationsFolder}…`);
  await migrate(db, { migrationsFolder });
  console.log("[migrate] done.");
  await client.end();
}

// When run directly (`node migrate.js` / `tsx migrate.ts` / `pnpm db:migrate`),
// execute. When imported (e.g. from the migration-smoke test), the
// caller drives execution.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
