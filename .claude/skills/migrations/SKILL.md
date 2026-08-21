---
name: migrations
description: Drizzle migration discipline for both apps/blackout/server and apps/kairos/server. Use when reading or writing schema.ts, anything under */drizzle/**, or when proposing to apply DDL against a database. Keywords: schema, migration, drizzle, db:generate, db:push, db:migrate, ALTER TABLE, snapshot, journal, backfill, enum, prod database, psql.
---

# Migration discipline (apps/blackout/server + apps/kairos/server)

Both apps use drizzle-orm with the same journal + snapshot contract. Canonical text is in root `CLAUDE.md` § *Migration discipline* — this skill is the version that auto-loads when touching schema files.

## The two rules (zero exceptions)
1. **Schema changes go through committed migration files** — no `psql` ALTER on any database.
2. **Migrations apply only via the deploy pipeline** — no manual `migrate.ts` against prod.

Backfills wait for the schema deploy.

## The flow (always)
1. Edit `src/db/schema.ts`.
2. Run `pnpm db:generate`.
3. Review the generated SQL — confirm it captures only the intended change.
4. Commit **all three artefacts together**: the SQL file, `meta/_journal.json`, `meta/<idx>_snapshot.json`. Never a subset.

If regenerating because the first attempt was wrong: delete the supplanted SQL file, the supplanted snapshot, and remove the supplanted journal entry before committing. Ghost entries cause silent drift.

## The `drizzle/` directory is for schema evolution only
Every file there must be drizzle-kit-authored (`pnpm db:generate`). The journal `when` values are drizzle-kit's. The snapshots are drizzle-kit's. **Hand-written SQL in `drizzle/` is banned. Full stop.**

## Why the rule has no carve-outs
Apparent exceptions dissolve under scrutiny:
- **"Backfill before NOT NULL."** Split into a sequence: drizzle-kit migration adds the column nullable → ops backfill (one-off, *not* in `drizzle/`) → drizzle-kit migration adds the NOT NULL constraint. Three deploys, but the middle step is also where you verify the backfill landed before the constraint enforces — safer, not slower.
- **"Enum value removal."** Almost always solvable by *not* removing values. Stop using the value in code; old rows stay valid; the value quietly leaves the live working set without DDL. If you truly must remove (compliance/regulatory), that's the ALTER TYPE escape hatch below.
- **"Conditional DDL (`DO $$ IF EXISTS`)."** Only needed if you don't trust the migration system. The whole point of `__drizzle_migrations` is the run-once-atomically guarantee. If you trust it (and this rule requires you to), conditional DDL is dead weight.

## Pure data fixes are NOT migrations
JSON-key rewrites inside a jsonb column, backfilling existing rows without changing structure, one-off correction of bad rows, the middle step of a multi-PR schema migration — none of these belong in `drizzle/`. Run them through an explicit local script or admin route. Git history (commit messages and PR descriptions) is the audit trail. Do not invent a migration file just because the change is database-shaped — the 0002 violation that produced this rule did exactly that, and its hand-typed `when` value silently poisoned drizzle's monotonic cursor (`pg-core/dialect.js:62` — see *Why these rules exist* below) such that a legitimate future migration would have silently no-applied.

## The one true escape hatch (rare; explicit justification required)
Multi-step `ALTER TYPE` surgery drizzle-kit literally cannot generate — e.g. `ALTER TYPE old RENAME → CREATE TYPE new → ALTER TABLE … TYPE new USING old::text::new → DROP TYPE old_legacy`. This is vanishingly rare; needing it usually signals a schema-design choice worth reconsidering. If a case genuinely arises: open a design discussion first, document why simpler alternatives don't work, and only then write the DDL by hand. It's the exception that proves the rule, not a normal pattern. The skeleton still goes through `pnpm db:generate` whenever drizzle-kit can model any part of the change.

## Never
- Mix `db:push` and `db:migrate` on the same database. `db:push` applies schema without recording any migration entries; a subsequent `db:migrate` will try to replay everything from scratch against a DB already in the final state. `db:push` is for throwaway local experimentation only.
- Hand-write structural DDL.
- Hand-type or hand-edit a journal entry (including the `when` value).
- Ship a pure-data fix as a migration file.
- Skip the snapshot.
- Run `migrate.ts` manually against prod — even to "fix" something. Use the deploy pipeline.

## Audit the chain before generating anything
Before every `pnpm db:generate`, verify the existing chain is coherent:
- `ls drizzle/meta/*_snapshot.json | wc -l` must equal the number of entries in `_journal.json`. A missing snapshot is a violation to repair before generating new history.
- Each snapshot's `prevId` must point at the previous snapshot's `id` — chain walks cleanly from `00000000-...` to the latest. A broken `prevId` is the fingerprint of a hand-edited journal.

## CRITICAL: drizzle's migrator is cursor-based, NOT hash-matching
Drizzle's runtime migrator (`pg-core/dialect.js:62`) decides what to apply with a strict timestamp cursor:
```js
const lastDbMigration = (await session.all(
  sql`SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`
))[0];
for (const migration of migrations) {
  if (!lastDbMigration || Number(lastDbMigration.created_at) < migration.folderMillis) {
    // APPLY — regardless of whether this hash already exists in the table.
  }
}
```
Hashes are RECORDED on apply, but never CHECKED to decide whether to skip. **A new migration with content matching an already-recorded hash WILL still be applied if its `folderMillis` is later than the highest recorded `created_at`.**

**Never claim "byte-identical SQL means drizzle will skip the migration on prod"** — it won't. The byte-identical claim was made for both PR #38 (Kairos chain renumber) and PR #42 (Blackout auth-migration ownership) in the same session (2026-05-17); the first worked by coincidence, the second failed with `relation "accounts" already exists`.

**Safe paths when introducing a migration whose SQL re-creates a table already in prod:**
- **INSERT a tracking row BEFORE the deploy** — with `created_at >= new_migration.folderMillis`. Drizzle's cursor then sees itself past the new migration and skips. Do this proactively if you can predict the conflict, not as surgery after a failed deploy.
- **Or accept the migration applies for real** — only safe when the tables genuinely don't exist yet in the target environment.
- **Never** rely on hash-matching to save you.

## Detection — `db:check` runs every predev/pretest
Prevention is incomplete. The drift modes the rules prevent (`db:push`, hand-edited journal, hand-written SQL) have all happened anyway — repeatedly. So both servers ship a `db:check` script wired into `predev` and `pretest` that runs *after* `migrate` and asserts:
1. Every table defined in `schema.ts` exists in the DB.
2. Every applied-migration row's hash matches its journal entry by file content (sha256).
3. Cursor count equals journal count (post-migrate, no pending entries).

Any mismatch fails non-zero with a `pnpm db:reset` pointer. **This is the structural enforcement that the rules above are not.** When you see "DRIFT DETECTED", the answer is `pnpm db:reset` — not a surgical fix. Surgical fixes are what got us here.

## `db:reset` is the only sanctioned recovery from drift
`pnpm db:reset` (kairos-server, blackout-server) drops the public schema, recreates it, runs migrate, runs seed. Local-only — gated on loopback hostname + app-name-in-db-name. Use it whenever `db:check` flags drift. Do **not**:
- Hand-INSERT cursor rows to advance past a "phantom" migration.
- Run individual migration SQL files via `psql` to "catch up".
- Truncate `drizzle.__drizzle_migrations` and re-migrate.

Each of those moves preserves invisible state and re-introduces drift later. `db:reset` is the answer.

## Resequencing a migration means resetting every dev DB
If you erase a migration file and regenerate it (because the original was wrong — e.g. the 0002 erasure on 2026-05-17), the migration files now no longer match what was applied to *any existing DB* (local, test, prod). For local, run `db:reset` immediately after the erasure commit. For test, the next `pretest` will handle it (`kairos_test` / `blackout_test` get wiped + re-migrated on every test run). For prod, this is the orphan-cleanup case — a `DELETE FROM drizzle.__drizzle_migrations WHERE …` on the orphaned cursor row, applied via the deploy ops console, before the next deploy. Flag this explicitly in the resequencing PR description.

## Why these rules exist with zero exceptions
Two failures produced them:
- Hand-written migrations in `apps/blackout/server` (0005, 0006) skipped snapshot generation. `drizzle-kit generate` then diffed against a stale baseline and regenerated DDL that had already been applied. Both had to be deleted and regenerated properly (2026-05-10).
- Hand-typed migration `0002_subject_time_field_rename.sql` in `apps/kairos/server` (PR #31) was a pure JSON-key data fix shipped as a fake migration with a hand-edited `_journal.json` entry and no snapshot. The hand-typed `when` value happened to be later than any subsequent legitimate `when`, which silently broke drizzle's monotonic `created_at < folderMillis` cursor (`pg-core/dialect.js:62`) — meaning *future migrations would have silently no-applied on prod* without an orphan-cleanup `DELETE`. Surgical recovery cost most of a session (2026-05-17) and a documented prod tracking-row delete.

The rules above are how those failures stop happening.
