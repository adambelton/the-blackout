/**
 * Side-effect module that populates `process.env` BEFORE any test or
 * helper code imports the app. ESM hoists `import` statements to the
 * top of every module, so env-setting inline alongside imports runs
 * AFTER those imports complete — too late for modules that read
 * env at load time (`src/auth.ts`, `src/api-key-middleware.ts`).
 *
 * Loaded globally via `tsx --import ./tests/test-env.ts` on the
 * `test` and `pretest` scripts in package.json — runs once before
 * any test or migrate import resolves. Test files that need the
 * exported `TEST_API_KEY` / `TEST_INTERNAL_API_SECRET` constants
 * (e.g. `helpers.ts` for the fetch helper) still import this module
 * directly; that's a functional import, not a side-effect one.
 */
if (!process.env.DATABASE_URL?.includes("kairos_test")) {
  process.env.DATABASE_URL = "postgresql://localhost:5432/kairos_test";
}
process.env.ANTHROPIC_API_KEY ??= "test-key";
// Deterministic API key for the test app. The fetch helper in
// helpers.ts auto-stamps every request with this token so apiKeyAuth
// sees a valid caller. Tests that need to exercise the rejection
// path bypass the helper and call `app.fetch` directly with no
// Authorization header.
export const TEST_API_KEY = "test-key-integration";
process.env.KAIROS_API_KEYS ??= TEST_API_KEY;
// Deterministic Better Auth secret for the test app. The session
// validator throws at module load if BETTER_AUTH_SECRET is unset.
// Tests don't exercise the session-cookie path (admin routes are
// not yet covered by integration tests — that lands when the admin
// app does), but the import chain still needs the secret present.
process.env.BETTER_AUTH_SECRET ??= "test-secret-integration";
// Deterministic internal-script bypass secret for the test app. The
// fetch helper auto-stamps every request with this header so admin
// routes (session-gated) accept the call without needing a real
// Better Auth cookie. Mirrors the same pattern in apps/blackout/server.
export const TEST_INTERNAL_API_SECRET = "test-internal-integration";
process.env.INTERNAL_API_SECRET ??= TEST_INTERNAL_API_SECRET;
