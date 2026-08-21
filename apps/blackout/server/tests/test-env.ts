/**
 * Side-effect module that populates `process.env` BEFORE any test or
 * source code imports run. Loaded via `tsx --import` in the `test`
 * script in package.json, so every test file picks it up
 * automatically without needing a per-file import.
 *
 * ESM hoists `import` statements above inline env-setting in the
 * same module, so an env-set alongside imports in a test file runs
 * AFTER those imports complete — too late for modules that read env
 * at load time (`src/db/client.ts` throws if `DATABASE_URL` is
 * unset; `src/lib/auth.ts` reads `BETTER_AUTH_SECRET`).
 *
 * Values use `??=` so CI / a developer's shell can override by
 * setting the env vars before running the test command.
 */
process.env.DATABASE_URL ??= "postgresql://localhost:5432/blackout_test";
process.env.BETTER_AUTH_SECRET ??= "test-secret-integration";
process.env.INTERNAL_API_SECRET ??= "test-internal-integration";
