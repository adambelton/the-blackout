-- ─────────────────────────────────────────────────────────────────────────
-- 0004 — consolidate service_type: {generation, imagery, summary} → narrative
--
-- Collapses the three singleton narrative-path service_types into one stage
-- type, `narrative`, so the enum is the three pipeline stages that run
-- services (enrichment / curation / narrative) and `serviceName` carries the
-- specific service. End state: service_type = ('enrichment','curation','narrative').
--
-- HAND-EDITED DDL — and why there was no other option to reach a CLEAN
-- 3-value enum (this is the migration-discipline "escape hatch"; the note is
-- the required justification — see root CLAUDE.md § Migration discipline):
--
--   The hard constraint: Postgres has NO `ALTER TYPE ... DROP VALUE`. An enum
--   value cannot be removed by any means EXCEPT recreating the type. So every
--   path to a clean 3-value enum runs through a type recreate — it is
--   intrinsic, not a choice. The only question was how to sequence it.
--
--   Rejected alternatives, each of which fails:
--   • Additive (`ALTER TYPE ... ADD VALUE 'narrative'`, leave the old three):
--     drizzle-kit can generate it, but it leaves 3 dead enum values (defeats
--     the goal of "3 service types") AND the row remap is a pure data fix that
--     must be run manually in every environment — the forgettable-on-prod
--     hazard that caused the PR #38 incident.
--   • Editing the historical migrations (0001 added generation/imagery, 0002
--     added summary): editing an applied migration changes its hash, so the
--     migrator treats it as new and re-runs it (CREATE TYPE collision) while
--     `db:check` flags the drift and aborts the release. It never alters the
--     live prod enum either (the ADD VALUEs already ran months ago), so a
--     manual remap to 'narrative' would error — the value wouldn't exist on
--     prod — and fresh DBs would diverge from prod.
--   • Rolling back prod: drizzle has no down-migrations; reversing the
--     ADD VALUEs IS this same recreate; rolling back far enough to re-take the
--     fork would drop 0003's auth tables (users/sessions/admin user) and a
--     point-in-time restore would lose all prod data since mid-May.
--
--   Therefore: a FORWARD type recreate, tracked as this migration, with the
--   data remap inline in the USING clause so it self-applies across
--   dev/test/prod via the normal migrate flow (release_command). Only the
--   USING clause below is hand-written; drizzle-kit authored the structure +
--   the snapshot + journal (the column→text→drop→recreate→recast pattern).
--   drizzle's own USING was `::service_type`, which would have thrown on the
--   existing generation/imagery/summary rows; the CASE remaps them to
--   `narrative`. service_specs.service_type is the only column on the enum
--   (no default), so the recreate is contained.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE "service_specs" ALTER COLUMN "service_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."service_type";--> statement-breakpoint
CREATE TYPE "public"."service_type" AS ENUM('enrichment', 'curation', 'narrative');--> statement-breakpoint
ALTER TABLE "service_specs" ALTER COLUMN "service_type" SET DATA TYPE "public"."service_type" USING (
	CASE WHEN "service_type" IN ('generation', 'imagery', 'summary') THEN 'narrative' ELSE "service_type" END
)::"public"."service_type";