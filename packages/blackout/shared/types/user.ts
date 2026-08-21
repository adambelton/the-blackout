/**
 * User roles. Stored on the Better Auth `users.role` column — set
 * server-side by the `user.create.before` hook in `apps/blackout/client/lib/auth.ts`,
 * read-only from the client. The field is declared as a Better Auth
 * custom field with `input: false` so client-supplied values are ignored.
 *
 *   - `undefined` / absent  — a regular member (default)
 *   - `"writer"`            — a commissioned contributor. Can access the
 *                              moderator view for their own broadcasts
 *                              (writer-scoped gating is future work)
 *   - `"admin"`             — Blackout staff. Can access every moderator
 *                              view plus the pipeline inspector and
 *                              radio-source catalogue.
 */
export const USER_ROLES = ["writer", "admin"] as const;
export type UserRole = typeof USER_ROLES[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === "string" && (USER_ROLES as readonly string[]).includes(value);
}

/** True when the role has admin privileges. */
export function isAdmin(role: string | undefined | null): boolean {
  return role === "admin";
}
