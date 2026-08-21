import { Hono } from "hono";
import { cors } from "hono/cors";
import { healthRoute } from "./routes/health.js";
import { broadcastRoutes } from "./routes/broadcasts.js";
import { narrativeRoutes } from "./routes/narrative.js";
import { poolRoutes } from "./routes/content-pool.js";
import { profileRoutes } from "./routes/profiles.js";
import { specRoutes } from "./routes/specs.js";
import { apiKeyAuth } from "./api-key-middleware.js";
import { sessionContext, requireSession } from "./session-middleware.js";

/**
 * Two auth surfaces, scoped declaratively by path prefix:
 *
 *   - `/broadcasts/*` (consumer — `broadcasts`, `narrative`, `pool`
 *     all live under here) → `apiKeyAuth`. Bearer-token auth from
 *     `KAIROS_API_KEYS`. The contract `apps/blackout/server` calls;
 *     designed to serve multiple consumers eventually.
 *   - `/profiles/*` and `/specs/*` (admin) → `sessionContext` +
 *     `requireSession`. Better Auth session cookie issued on the
 *     admin app (`apps/kairos/client`) via email/password sign-in
 *     (sign-up disabled; users seeded by the admin app's
 *     `scripts/create-user.ts`) — see `@kairos/auth`.
 *
 * Why path-prefix middleware and NOT sibling sub-apps: mounting two
 * `Hono` instances at the same root (`app.route("/", consumerApp)` +
 * `app.route("/", adminApp)`) makes the FIRST sub-app's `use("/*")`
 * middleware fire on EVERY request — even those whose routes only
 * exist in the second sub-app — because Hono walks in mount order
 * and a wildcard middleware short-circuits before route resolution
 * picks the matching sub-app. Real users on the admin surface would
 * always hit `apiKeyAuth`'s 401 first and never reach the session
 * check. Path-prefix `use` is the only shape that actually expresses
 * "this middleware applies to THIS path family."
 *
 * `/health` is public — it's the Fly probe surface.
 */
export function createApp(): Hono {
  const app = new Hono();
  app.use("/*", cors());

  app.route("/", healthRoute);

  // Consumer surface — machine-to-machine bearer-token auth.
  app.use("/broadcasts/*", apiKeyAuth);
  app.route("/", broadcastRoutes);
  app.route("/", narrativeRoutes);
  app.route("/", poolRoutes);

  // Admin surface — human-to-service session-cookie auth (or the
  // INTERNAL_API_SECRET header bypass for tests + ops scripts).
  app.use("/profiles/*", sessionContext);
  app.use("/profiles/*", requireSession);
  app.use("/specs/*", sessionContext);
  app.use("/specs/*", requireSession);
  app.route("/", profileRoutes);
  app.route("/", specRoutes);

  return app;
}
