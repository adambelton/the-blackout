/**
 * Create a Kairos admin user with email/password credentials. Sign-up
 * is disabled in the production Better Auth config (`packages/kairos/auth/factory.ts`)
 * so this is the only way to provision a new admin.
 *
 * Usage:
 *   pnpm --filter @kairos/client create-user <email> <name> <password>
 *
 * Requires KAIROS_DB_URL, BETTER_AUTH_SECRET in env (tsx --env-file=.env
 * loads them from `apps/kairos/client/.env`). Example:
 *   pnpm --filter @kairos/client create-user admin@example.com "Example Admin" '<pw>'
 *
 * Single-quote the password to prevent shell expansion of $, &, etc.
 *
 * Why a one-off auth instance: Better Auth's `disableSignUp: true`
 * blocks `auth.api.signUpEmail` at every layer, not just the HTTP
 * surface. The seed script bypasses by building its own Better Auth
 * with sign-up enabled — it runs with full DB access locally / ops
 * scripts only, never exposed as an endpoint.
 */
import { createAuth } from "@kairos/auth";
import { db } from "../lib/auth/db";

const [, , email, name, password] = process.argv;

if (!email || !name || !password) {
  console.error(
    "Usage: pnpm --filter @kairos/client create-user <email> <name> <password>",
  );
  process.exit(1);
}

const secret = process.env.BETTER_AUTH_SECRET;
if (!secret) {
  console.error("BETTER_AUTH_SECRET is not set");
  process.exit(1);
}

// Seed-only auth instance — `allowSignUp: true` flips the factory's
// default `disableSignUp: true` so we can call signUpEmail. The
// HTTP-facing instance in lib/auth.ts keeps the default (closed).
const seedAuth = createAuth({
  db,
  secret,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3001",
  allowSignUp: true,
});

async function main() {
  await seedAuth.api.signUpEmail({ body: { email, name, password } });
  console.log(`Created user ${email} (${name})`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to create user:", err);
    process.exit(1);
  });
