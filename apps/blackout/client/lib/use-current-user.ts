"use client";

import { useSession } from "./auth-client";
import { isAdmin, type UserRole } from "@blackout/shared";

export interface CurrentUser {
  id: string;
  email: string | null;
  role: UserRole | null;
  isAdmin: boolean;
}

interface CurrentUserState {
  user: CurrentUser | null;
  loading: boolean;
}

/**
 * Subscribe to the Better Auth session and project it onto the
 * app's CurrentUser shape. Role is read from the custom `role`
 * field (see lib/auth.ts) — server-controlled via the user.create
 * database hook, so the client can trust it for UI gating (proxy
 * enforces the actual access boundary).
 */
export function useCurrentUser(): CurrentUserState {
  const { data: session, isPending } = useSession();

  if (isPending) return { user: null, loading: true };
  if (!session?.user) return { user: null, loading: false };

  const u = session.user as typeof session.user & { role?: string | null };
  const roleRaw = u.role;
  const role = typeof roleRaw === "string" ? (roleRaw as UserRole) : null;

  return {
    user: {
      id: u.id,
      email: u.email ?? null,
      role,
      isAdmin: isAdmin(role),
    },
    loading: false,
  };
}
