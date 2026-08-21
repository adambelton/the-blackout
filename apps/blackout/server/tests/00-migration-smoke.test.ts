/**
 * Pins the migration chain. Drops the DB's schemas, runs the full
 * chain from `0000` forward, asserts every expected table landed.
 *
 * This is the test the auth-migration-ownership PR (#42) couldn't
 * have shipped without — it specifically validates that the
 * server-side `0008_worried_leech.sql` (the auth tables, previously
 * owned by `apps/blackout/client/drizzle/`) applies cleanly to a
 * fresh DB. The whole previous arrangement worked on prod precisely
 * because the tables already existed; nothing tested fresh-DB
 * application.
 *
 * The test runs ALPHABETICALLY FIRST in the suite (filename prefix
 * `00-`) so the schema-reset + re-migrate it does is invisible to
 * later tests — by the time they run, the DB is back to
 * fully-migrated state, the same state `pretest`'s migrate would
 * have left it in.
 *
 * Future migrations: add a new line to the expected-tables list when
 * a migration adds a table. Future renames / drops: update the list
 * accordingly. This is intentionally a low-tech "did the right tables
 * appear" check; finer-grained assertions (column types, FK
 * cascades, indexes) belong in dedicated tests per-domain.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { runMigrations } from "../src/db/migrate.js";
import { resetSchema, sql, closeConnection } from "./helpers.js";

const EXPECTED_TABLES = [
  // Blackout server's own tables
  "broadcasts",
  "broadcast_illustrations",
  "broadcast_discarded_prompts",
  "broadcast_narrations",
  "radio_sources",
  "notify_signups",
  "tts_voices",
  // Better Auth tables — re-exported from @blackout/auth into
  // schema.ts in PR #42. Migration ownership previously sat in
  // apps/blackout/client/drizzle/; now lives here.
  "users",
  "sessions",
  "accounts",
  "verifications",
];

describe("migration chain applies cleanly to a fresh DB", () => {
  before(async () => {
    await resetSchema();
    await runMigrations();
  });

  after(async () => {
    await closeConnection();
  });

  for (const table of EXPECTED_TABLES) {
    it(`creates table ${table}`, async () => {
      const result = await sql<{ to_regclass: string | null }[]>`
        SELECT to_regclass(${table})::text AS to_regclass
      `;
      assert.equal(
        result[0].to_regclass,
        table,
        `expected table ${table} to exist after running migrations`,
      );
    });
  }

  it("records every applied migration in drizzle.__drizzle_migrations", async () => {
    const result = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations
    `;
    // 9 migrations as of PR #42 (0000_tearful_gressill through
    // 0008_worried_leech). When this grows, update the lower bound.
    assert.ok(
      result[0].count >= 9,
      `expected at least 9 tracked migrations, got ${result[0].count}`,
    );
  });
});
