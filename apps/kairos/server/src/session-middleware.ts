/**
 * Hono session-validation middleware for Kairos admin routes.
 *
 * Reads the Better Auth session cookie on every admin-route request,
 * attaches the resolved user + session to the Hono context, and
 * provides a `requireSession` per-route gate that rejects 401 when
 * the cookie is missing or invalid.
 *
 * Cookies are issued on the admin app (`apps/kairos/client`, K6.3b);
 * because both halves instantiate Better Auth from the shared
 * `@kairos/auth` factory with the same `secret` and `cookiePrefix`,
 * the cookie validates here without an HTTP hop. In prod the cookie
 * may be scoped to a shared parent domain so the browser sends it to
 * both the workbench and API hosts.
 *
 * Kairos has one user type — being on the manually-seeded user list
 * IS the security boundary. So there's no `requireRole` equivalent
 * here; any valid session is admin-app-employee enough.
 *
 * Consumer routes (broadcasts, narrative, pool, feed) use the
 * bearer-token gate in `api-key-middleware.ts` instead. The two
 * surfaces live behind different middleware sub-apps in `app.ts`.
 */
import type { Context, MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";
import { auth } from "./auth.js";

type BetterAuthUser = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>["user"];

type BetterAuthSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>["session"];

declare module "hono" {
  interface ContextVariableMap {
    user: BetterAuthUser | null;
    session: BetterAuthSession | null;
  }
}

/**
 * Internal-script bypass: tests, ops scripts, and the integration
 * harness can't go through Better Auth's OAuth flow. When
 * `INTERNAL_API_SECRET` is set and the request carries a matching
 * `X-Internal-Api-Secret` header, the middleware synthesises a
 * minimal session so admin routes let the script through. Secret
 * required to be non-empty to enable this path; missing or empty
 * env disables it entirely (fail-closed).
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

function buildInternalUser(): BetterAuthUser {
  return Object.freeze({
    id: "internal-script",
    email: "internal@localhost",
    name: "Internal Script",
    emailVerified: true,
    image: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as BetterAuthUser);
}

function buildInternalSession(): BetterAuthSession {
  return Object.freeze({
    id: "internal-script-session",
    userId: "internal-script",
  } as unknown as BetterAuthSession);
}

/**
 * Attaches `user` + `session` to the request context when the cookie
 * validates. Never rejects on its own — pair with `requireSession`
 * on routes that should reject anonymous callers.
 */
export const sessionContext: MiddlewareHandler = async (c, next) => {
  // Internal-script bypass runs first so ops calls don't hit Better
  // Auth at all when a matching shared secret is present.
  const internal = c.req.header("x-internal-api-secret") ?? null;
  if (matchesInternalSecret(internal)) {
    c.set("user", buildInternalUser());
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
    // A malformed or expired cookie isn't fatal — treat the request
    // as unauthenticated and let `requireSession` (or the route) decide.
    c.set("user", null);
    c.set("session", null);
  }
  await next();
};

/**
 * 401 if there's no authenticated session. Use as a per-route
 * middleware on admin routes that must not be reachable anonymously.
 * Assumes `sessionContext` ran upstream (mount it once globally on
 * the admin sub-app, then apply `requireSession` to individual routes
 * or the whole sub-app).
 */
export const requireSession: MiddlewareHandler = async (c, next) => {
  if (!c.get("user")) {
    return c.json({ error: "Authentication required" }, 401);
  }
  await next();
};

/** Convenience helper for admin-route handlers. */
export function getUser(c: Context): BetterAuthUser | null {
  return c.get("user");
}
