import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";

// Backstage routes — role-gated. `/broadcasts` (list), `/moderator`
// (per-broadcast live ops), and `/studio` (per-broadcast content prep)
// are open to writers as well as admins, so collaborating writers can
// prep + run their own broadcasts. `/admin/*` and the pipeline
// inspector stay admin-only: staff-grade surfaces for catalogue
// management and debugging internals.
const WRITER_OR_ADMIN_PATHS = ["/broadcasts", "/moderator", "/studio"];
const ADMIN_ONLY_PATHS = ["/admin", "/inspector"];
const ADMIN_ONLY_REGEXES: RegExp[] = [];

// Member-facing surfaces — gated by login + the matchroom-enabled
// feature flag. Off-by-default; flagging in a member rolls them in.
const MEMBER_PATHS = ["/matchroom", "/replays"];

/**
 * Resolve a PostHog feature-flag value for a given distinct id.
 * Used by the middleware to gate `/login` (show-login) and
 * `/matchroom` (matchroom-enabled) before the page renders.
 */
async function checkFeatureFlag(
  flagKey: "show-login" | "matchroom-enabled",
  distinctId: string,
): Promise<boolean> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return false;

  try {
    const res = await fetch("https://eu.i.posthog.com/decide?v=3", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        distinct_id: distinctId,
        person_properties: {
          environment:
            process.env.NODE_ENV === "development"
              ? "development"
              : "production",
        },
      }),
    });

    if (!res.ok) return false;
    const data = await res.json();
    return data.featureFlags?.[flagKey] === true;
  } catch {
    return false;
  }
}

/** Pull the PostHog distinct_id from its cookie if present. */
function readDistinctId(request: NextRequest): string {
  const phKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!phKey) return "anonymous";
  const phCookie = request.cookies.get(`ph_${phKey}_posthog`)?.value;
  if (!phCookie) return "anonymous";
  try {
    const parsed = JSON.parse(decodeURIComponent(phCookie));
    return typeof parsed.distinct_id === "string" ? parsed.distinct_id : "anonymous";
  } catch {
    return "anonymous";
  }
}

/**
 * Fetch the current session server-side for gating decisions. Calls
 * Better Auth's internal `getSession` against the incoming request's
 * cookies — no DB round-trip per request once the cookie cache warms.
 */
async function getSession(request: NextRequest) {
  return auth.api.getSession({ headers: request.headers });
}

type Role = "admin" | "writer" | null;

function roleFrom(
  session: Awaited<ReturnType<typeof getSession>>,
): Role {
  const raw = (session?.user as { role?: unknown } | undefined)?.role;
  if (raw === "admin" || raw === "writer") return raw;
  return null;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const homeRedirect = () => {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  };
  const loginRedirect = () => {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  };

  // ---- /login: feature-flagged + redirect-if-logged-in -----------------
  if (pathname.startsWith("/login")) {
    const flagEnabled = await checkFeatureFlag(
      "show-login",
      readDistinctId(request),
    );
    if (!flagEnabled) return homeRedirect();

    const session = await getSession(request);
    if (session?.user) return homeRedirect();
    return NextResponse.next();
  }

  // ---- Member surfaces: feature-flagged + login required ---------------
  if (MEMBER_PATHS.some((p) => pathname.startsWith(p))) {
    const flagEnabled = await checkFeatureFlag(
      "matchroom-enabled",
      readDistinctId(request),
    );
    if (!flagEnabled) return homeRedirect();

    const session = await getSession(request);
    if (!session?.user) return loginRedirect();
    return NextResponse.next();
  }

  // ---- Backstage routes ------------------------------------------------
  // Admin-only surfaces (`/admin/*`, `/inspector/*`) are evaluated first.
  // The pipeline inspector is staff-grade — it sits at /inspector/:id
  // (matching the /moderator/:id, /studio/:id consumer-route convention)
  // and is admin-only. Anonymous users hit /login regardless; logged-in
  // users without the required role bounce home.
  const isAdminOnly =
    ADMIN_ONLY_PATHS.some((p) => pathname.startsWith(p)) ||
    ADMIN_ONLY_REGEXES.some((re) => re.test(pathname));
  const isWriterOrAdmin = WRITER_OR_ADMIN_PATHS.some((p) => pathname.startsWith(p));

  if (isAdminOnly) {
    const session = await getSession(request);
    if (!session?.user) return loginRedirect();
    if (roleFrom(session) !== "admin") return homeRedirect();
  } else if (isWriterOrAdmin) {
    const session = await getSession(request);
    if (!session?.user) return loginRedirect();
    const role = roleFrom(session);
    if (role !== "admin" && role !== "writer") return homeRedirect();
  }

  return NextResponse.next();
}

export const proxyConfig = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|ingest|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
