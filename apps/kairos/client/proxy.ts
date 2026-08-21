import { type NextRequest, NextResponse } from "next/server";

/**
 * Sign-in gate. Anonymous requests outside `/login` and `/api/auth/*`
 * redirect to `/login`. Signed-in requests pass through.
 *
 * Deliberately cookie-presence only (cheap; no DB read here). The
 * actual session validation happens in server components / route
 * handlers via `auth.api.getSession({ headers })`. If the cookie is
 * stale / forged, the validation rejects there. If the cookie is
 * missing, this redirects before any server component runs.
 *
 * The cookie name `kairos-auth.session_token` comes from the
 * `cookiePrefix: "kairos-auth"` config in `@kairos/auth`'s factory.
 * In HTTPS prod Better Auth prepends `__Secure-` (RFC 6265bis); check
 * both. Same for the `.session_data` JWT cookie used when
 * crossSubDomainCookies is enabled. Missing the `__Secure-` variant
 * in prod silently redirect-loops every signed-in request back to
 * `/login` because the bare-name lookup never finds it.
 */
const PUBLIC_PATHS = ["/login", "/api/auth"];

const COOKIE_NAMES = [
  "kairos-auth.session_token",
  "__Secure-kairos-auth.session_token",
  "kairos-auth.session_data",
  "__Secure-kairos-auth.session_data",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Always allow public paths through.
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // Cookie-presence only — validation runs server-side downstream.
  const sessionCookie = COOKIE_NAMES.map((n) => request.cookies.get(n)).find(
    (c) => c != null,
  );

  if (!sessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Match all routes except Next.js internals + static assets. The
  // `_next/` exclusion is important — without it, every chunk fetch
  // would do the gate check.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.).*)"],
};
