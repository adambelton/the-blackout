/**
 * Test harness for apps/blackout/server. Currently minimal — only the
 * migration-smoke test consumes it. Will grow as integration coverage
 * lands (broadcast lifecycle, role-based access, FK cascades, etc. —
 * tracked as a separate workstream; the infrastructure here is what
 * unblocks writing those tests).
 *
 * Env vars are populated globally by `tests/test-env.ts`, loaded via
 * `tsx --import` in package.json's `test` script — BEFORE any test
 * file imports anything that reads env at module load
 * (`src/db/client.ts` throws on missing `DATABASE_URL`).
 */
import { sql as dbSql } from "../src/db/client.js";

export { dbSql as sql };

/**
 * Drop the `public` and `drizzle` schemas, then recreate `public`.
 * The migration-smoke test calls this so it can verify
 * `runMigrations()` lands every expected table against a truly empty
 * DB — not just confirm the cursor's no-op behaviour against an
 * already-migrated DB.
 *
 * Leaves the DB in a state where the next `runMigrations()` will
 * apply the entire chain from `0000` forward.
 */
export async function resetSchema(): Promise<void> {
  await dbSql`DROP SCHEMA IF EXISTS public CASCADE`;
  await dbSql`DROP SCHEMA IF EXISTS drizzle CASCADE`;
  await dbSql`CREATE SCHEMA public`;
}

/**
 * Truncate test-scoped tables between integration tests. Preserves
 * platform-content tables (`radio_sources`, `tts_voices`) — those are
 * catalogue entries, not test data.
 *
 * Not used by any test yet (no integration tests on blackout-server
 * currently query the DB); included so the pattern's in place when
 * the first DB-backed integration test lands.
 */
export async function resetData(): Promise<void> {
  await dbSql`TRUNCATE
    broadcasts,
    notify_signups,
    users,
    verifications
    RESTART IDENTITY CASCADE`;
}

export async function closeConnection(): Promise<void> {
  await dbSql.end();
}
