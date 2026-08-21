/**
 * Create a user with email/password credentials for local provisioning.
 *
 * Usage:
 *   pnpm tsx scripts/create-user.ts <email> <name> <role> <password>
 *
 *   role: admin | writer
 *
 * Requires DATABASE_URL, BETTER_AUTH_SECRET, BETTER_AUTH_URL in env.
 * Example:
 *   pnpm tsx scripts/create-user.ts writer@example.com "Example Writer" writer <pw>
 *
 */
import { eq } from "drizzle-orm";
import { auth } from "../lib/auth";
import { db } from "../lib/auth/db";
import { users } from "@blackout/auth";

const [, , email, name, role, password] = process.argv;

if (!email || !name || !role || !password) {
  console.error(
    "Usage: pnpm tsx scripts/create-user.ts <email> <name> <role> <password>",
  );
  console.error("  role: admin | writer");
  process.exit(1);
}

if (role !== "admin" && role !== "writer") {
  console.error(`Invalid role: ${role}. Must be 'admin' or 'writer'.`);
  process.exit(1);
}

async function main() {
  await auth.api.signUpEmail({ body: { email, name, password } });
  // The role field is `input: false` on the user model, so it can't
  // be set via signup. Stamp it directly after creation.
  await db.update(users).set({ role }).where(eq(users.email, email));
  console.log(`Created user ${email} (${name}) with role=${role}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Failed to create user:", err);
    process.exit(1);
  });
