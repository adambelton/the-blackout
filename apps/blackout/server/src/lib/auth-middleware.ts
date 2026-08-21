/**
 * Hono auth middleware — validates the Better Auth session cookie on
 * every request and attaches the resolved user + session to the Hono
 * context. Routes can:
 *
 *   - Call `getUser(c)` to read the authenticated user (or null).
 *   - Use `requireAuth` as a per-route middleware to reject 401 when
 *     there's no session.
 *   - Use `requireRole("admin" | "writer")` for role-gated routes.
 *
 * The cookie can be sent by the browser to sibling application and API
 * hosts when Better Auth is configured with a shared parent domain. In local dev the
 * cookie is host-only (localhost:3000), which is why the matchroom /
 * moderator / studio surfaces are tested through the web's dev proxy
 * when auth matters.
 */
import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { auth } from "./auth.js";

/**
 * Internal-script bypass: scripts running locally (replay, seed,
 * one-off ops) do not have an interactive Better Auth session.
 * When `INTERNAL_API_SECRET` is set and the request carries a
 * matching `X-Internal-Api-Secret` header, the middleware synthesises
 * an admin-role user so role-gated routes let the script through.
 * Secret is required to be non-empty to enable this path; missing or
 * empty env disables it entirely (fail-closed).
 */
function matchesInternalSecret(presented: string | null): boolean {
  if (!presented) return false;
  const expected = process.env.INTERNAL_API_SECRET;
  if (!expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

type BetterAuthUser = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>["user"];

type BetterAuthSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>["session"];

/**
 * Frozen factories for the internal-script bypass identity. Returning
 * fresh frozen instances keeps callers from mutating the shared
 * record (the previous global `as unknown` cast invited that), and
 * places the `as unknown as BetterAuthUser` cast in one well-scoped
 * place rather than at every call site.
 */
function buildInternalAdminUser(): BetterAuthUser {
  return Object.freeze({
    id: "internal-script",
    role: "admin",
    email: "internal@localhost",
    name: "Internal Script",
  } as unknown as BetterAuthUser);
}

function buildInternalSession(): BetterAuthSession {
  return Object.freeze({
    id: "internal-script-session",
    userId: "internal-script",
  } as unknown as BetterAuthSession);
}

export interface AuthContext {
  user: BetterAuthUser | null;
  session: BetterAuthSession | null;
}

// Hono's type-safe context variables — routes can `c.get("user")`
// and get the typed user back.
declare module "hono" {
  interface ContextVariableMap {
    user: BetterAuthUser | null;
    session: BetterAuthSession | null;
  }
}

/**
 * Attaches `user` + `session` to the request context when the cookie
 * validates. Never rejects — downstream handlers decide whether the
 * route requires auth. Apply globally via `app.use("/*", authContext)`.
 */
export const authContext: MiddlewareHandler = async (c, next) => {
  // Internal-script bypass runs first so auth calls can skip the
  // Better Auth roundtrip when a matching shared secret is present.
  const internal = c.req.header("x-internal-api-secret") ?? null;
  if (matchesInternalSecret(internal)) {
    c.set("user", buildInternalAdminUser());
    c.set("session", buildInternalSession());
    await next();
    return;
  }

  try {
    const result = await auth.api.getSession({
      headers: c.req.raw.headers,
    });
    c.set("user", result?.user ?? null);
    c.set("session", result?.session ?? null);
  } catch {
    // A malformed or expired cookie isn't fatal — we just treat the
    // request as unauthenticated and let the downstream route decide.
    c.set("user", null);
    c.set("session", null);
  }
  await next();
};

/**
 * 401 if there's no authenticated session. Use on any route that
 * shouldn't be reachable by an anonymous caller.
 */
export const requireAuth: MiddlewareHandler = async (c, next) => {
  if (!c.get("user")) {
    return c.json({ error: "Authentication required" }, 401);
  }
  await next();
};

/**
 * 401 + 403 in one — rejects anonymous callers, then rejects
 * authenticated users whose role isn't in the allowed set. `admin` is
 * the highest privilege; `writer` is next. Null role (basic member)
 * fails every check except where explicitly allowed.
 *
 * Usage: `broadcastRoutes.post("/broadcasts", requireRole("writer", "admin"), ...)`.
 * Stand-alone — does not require `requireAuth` upstream.
 */
export function requireRole(
  ...allowed: Array<"admin" | "writer">
): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Authentication required" }, 401);
    const role = (user as { role?: string | null }).role;
    if (!role || !allowed.includes(role as "admin" | "writer")) {
      return c.json({ error: "Forbidden" }, 403);
    }
    await next();
  };
}

/** Convenience helper for route handlers. */
export function getUser(c: Context): BetterAuthUser | null {
  return c.get("user");
}
