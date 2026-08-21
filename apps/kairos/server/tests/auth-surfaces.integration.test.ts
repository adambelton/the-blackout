/**
 * Regression test: each auth surface enforces its OWN gate, not the
 * other's. The K6.3a deploy shipped with two sibling sub-apps mounted
 * at "/" — Hono ran the first sub-app's `use("/*")` middleware on
 * every request regardless of which sub-app's route matched, so
 * admin routes returned the apiKey error instead of the session
 * error and real browser-session callers would have been permanently
 * blocked. Path-prefix middleware (`app.use("/broadcasts/*", ...)`)
 * was the fix.
 *
 * These tests pin the per-surface behaviour so the failure mode
 * can't recur: hit each surface with NO auth and assert the error
 * comes from the *correct* gate.
 */
import "./test-env.js";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { closeConnection } from "./helpers.js";

describe("auth surfaces — each path family enforces its own gate", () => {
  const app = createApp();
  const raw = (path: string) =>
    app.fetch(new Request(`http://test.local${path}`));

  after(async () => {
    await closeConnection();
  });

  it("consumer route without Bearer → 401 from apiKeyAuth", async () => {
    const res = await raw("/broadcasts");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /Bearer/);
  });

  it("admin route /profiles without session → 401 from requireSession", async () => {
    const res = await raw("/profiles/sporting_event");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    // The session-middleware error is "Authentication required", NOT
    // "Authorization: Bearer <token> is required" — the latter would
    // mean apiKeyAuth bled into the admin surface (the K6.3a bug).
    assert.equal(body.error, "Authentication required");
    assert.doesNotMatch(body.error, /Bearer/);
  });

  it("admin route /specs without session → 401 from requireSession", async () => {
    const res = await raw("/specs");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Authentication required");
    assert.doesNotMatch(body.error, /Bearer/);
  });

  it("/health is public on both surfaces (no auth required)", async () => {
    const res = await raw("/health");
    assert.equal(res.status, 200);
  });
});
