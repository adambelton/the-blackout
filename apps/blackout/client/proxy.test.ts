import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({
  auth: { api: { getSession: vi.fn() } },
}));

import { auth } from "@/lib/auth";
import { proxy } from "./proxy";

const getSession = auth.api.getSession as unknown as ReturnType<typeof vi.fn>;

function buildRequest(pathname: string): NextRequest {
  return new NextRequest(`http://localhost:3000${pathname}`);
}

function locationOf(res: Response): string | null {
  const loc = res.headers.get("location");
  if (!loc) return null;
  return new URL(loc).pathname;
}

function userWithRole(role: string | null) {
  return { user: { id: "u1", email: "x@y.z", role }, session: {} };
}

describe("proxy role gates", () => {
  beforeEach(() => {
    getSession.mockReset();
    // Force checkFeatureFlag to short-circuit to false (no PostHog key).
    // /login and /matchroom paths therefore home-redirect; those flows
    // aren't the role-gate behaviour under test.
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("public paths", () => {
    it("lets the homepage through without a session lookup", async () => {
      const res = await proxy(buildRequest("/"));
      expect(res.headers.get("location")).toBeNull();
      expect(getSession).not.toHaveBeenCalled();
    });
  });

  describe("admin-only paths", () => {
    it("redirects anonymous to /login on /admin", async () => {
      getSession.mockResolvedValueOnce(null);
      const res = await proxy(buildRequest("/admin"));
      expect(locationOf(res)).toBe("/login");
    });

    it("redirects anonymous to /login on /inspector/abc", async () => {
      getSession.mockResolvedValueOnce(null);
      const res = await proxy(buildRequest("/inspector/abc"));
      expect(locationOf(res)).toBe("/login");
    });

    it("redirects a logged-in writer to / on /admin", async () => {
      getSession.mockResolvedValueOnce(userWithRole("writer"));
      const res = await proxy(buildRequest("/admin/users"));
      expect(locationOf(res)).toBe("/");
    });

    it("redirects a logged-in member (null role) to / on /inspector", async () => {
      getSession.mockResolvedValueOnce(userWithRole(null));
      const res = await proxy(buildRequest("/inspector/abc"));
      expect(locationOf(res)).toBe("/");
    });

    it("lets an admin through on /admin/whatever", async () => {
      getSession.mockResolvedValueOnce(userWithRole("admin"));
      const res = await proxy(buildRequest("/admin/users"));
      expect(res.headers.get("location")).toBeNull();
    });
  });

  describe("writer-or-admin paths", () => {
    it.each(["/broadcasts", "/moderator/abc", "/studio/abc"])(
      "redirects anonymous to /login on %s",
      async (path) => {
        getSession.mockResolvedValueOnce(null);
        const res = await proxy(buildRequest(path));
        expect(locationOf(res)).toBe("/login");
      },
    );

    it("redirects a logged-in member (null role) to / on /broadcasts", async () => {
      getSession.mockResolvedValueOnce(userWithRole(null));
      const res = await proxy(buildRequest("/broadcasts"));
      expect(locationOf(res)).toBe("/");
    });

    it("lets a writer through on /broadcasts", async () => {
      getSession.mockResolvedValueOnce(userWithRole("writer"));
      const res = await proxy(buildRequest("/broadcasts"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("lets an admin through on /studio/abc", async () => {
      getSession.mockResolvedValueOnce(userWithRole("admin"));
      const res = await proxy(buildRequest("/studio/abc"));
      expect(res.headers.get("location")).toBeNull();
    });

    it("treats an unrecognised role string as no access", async () => {
      getSession.mockResolvedValueOnce(userWithRole("contributor"));
      const res = await proxy(buildRequest("/moderator/abc"));
      expect(locationOf(res)).toBe("/");
    });
  });
});
