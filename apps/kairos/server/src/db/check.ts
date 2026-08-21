/**
 * Drift detector — runs after `migrate.ts` (in `predev` and `pretest`).
 *
 * Why this exists: rules-based discipline ("don't `db:push`", "don't
 * hand-edit the migrations table") has failed repeatedly. The local
 * DB's `__drizzle_migrations` cursor can silently desync from the
 * schema state (someone ran `db:push` once, a migration was
 * resequenced after applying, etc.), and the next `migrate` then
 * either errors with "already exists" or silently no-ops past the
 * tables it needed to create.
 *
 * This check is the structural fix. It asserts two things:
 *   1. Every table defined in schema.ts exists in the DB.
 *   2. The applied-migrations cursor is coherent with the journal:
 *      no gaps, every applied row maps to a journal entry by hash.
 *
 * On any mismatch, prints a clear `pnpm db:reset` pointer and exits
 * non-zero. Wired into `predev`, so dev can't start with a drifted
 * DB — the tooling enforces what the rules couldn't.
 */
import "../env.js";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = resolve(here, "../../drizzle");

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("[db:check] DATABASE_URL is not set");
  process.exit(1);
}

const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(client);

// pgTable returns objects with a symbol-keyed config; getTableConfig
// throws cleanly on non-tables. The schema module also exports drizzle
// `relations()` objects (PgTable and Relations don't share enough of a
// shape for a `value is PgTable` type guard to narrow cleanly), so
// probe + accumulate with a try/catch rather than filter + map.
function collectExpectedTables(): string[] {
  const names: string[] = [];
  for (const value of Object.values(schema)) {
    if (!value || typeof value !== "object") continue;
    try {
      names.push(getTableConfig(value as PgTable).name);
    } catch {
      // not a table — likely a relations() object or an enum
    }
  }
  return names.sort();
}

const expectedTables = collectExpectedTables();

const errors: string[] = [];

// 1. Expected tables.
const dbTableRows = await db.execute<{ table_name: string }>(
  sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
);
const actualTables = new Set(dbTableRows.map((r) => r.table_name));
const missing = expectedTables.filter((t) => !actualTables.has(t));
if (missing.length > 0) {
  errors.push(
    `Missing tables defined in schema.ts: ${missing.join(", ")}\n` +
      `  → Migrations didn't fully apply. Run \`pnpm db:reset\` to reconcile.`,
  );
}

// 2. Cursor coherence — applied rows in order must map 1:1 to a
//    prefix of journal entries by sha256(SQL).
const journalPath = resolve(migrationsFolder, "meta/_journal.json");
const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

const appliedRows = await db
  .execute<{ id: number; hash: string; created_at: string }>(
    sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`,
  )
  .catch(() => [] as Array<{ id: number; hash: string; created_at: string }>);

// drizzle hashes the SQL file content (sha256, lowercase hex).
const expectedHashes = journal.entries.map((entry) => {
  const sqlPath = resolve(migrationsFolder, `${entry.tag}.sql`);
  const text = readFileSync(sqlPath, "utf8");
  return createHash("sha256").update(text).digest("hex");
});

for (let i = 0; i < appliedRows.length; i++) {
  const applied = appliedRows[i];
  const expected = expectedHashes[i];
  if (!expected) {
    errors.push(
      `Applied migrations exceed the journal (row ${applied.id} has no journal entry).\n` +
        `  → DB ran ahead of source. Run \`pnpm db:reset\` to reconcile.`,
    );
    break;
  }
  if (applied.hash !== expected) {
    errors.push(
      `Migration ${journal.entries[i].tag} hash mismatch (DB has ${applied.hash.slice(0, 12)}, file is ${expected.slice(0, 12)}).\n` +
        `  → A migration file was modified after it was applied. Run \`pnpm db:reset\` to reconcile.`,
    );
    break;
  }
}

// 3. Cursor count must equal journal count. `check` is called AFTER
//    `migrate`, so any pending migration at this point means migrate
//    silently no-op'd (cursor underwater vs. schema state — exactly
//    the drift mode that hides the failure). One legitimate case for
//    cursor underflow is *fewer rows than journal entries*, which
//    happens when migrate just wasn't run; but predev runs migrate
//    first, so by the time check runs this should always be equal.
if (appliedRows.length !== journal.entries.length) {
  errors.push(
    `Cursor has ${appliedRows.length} applied migrations but journal has ${journal.entries.length}.\n` +
      `  → Migrate silently no-op'd past pending migrations (likely because the DB schema is ahead of the cursor).\n` +
      `  → Run \`pnpm db:reset\` to reconcile.`,
  );
}

await client.end();

if (errors.length > 0) {
  console.error("[db:check] DRIFT DETECTED");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(
  `[db:check] OK — ${expectedTables.length} expected tables present, ${appliedRows.length}/${journal.entries.length} migrations applied.`,
);
