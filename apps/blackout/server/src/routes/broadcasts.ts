import { Hono } from "hono";
import { collectScheduleBlockers } from "@blackout/shared";
import {
  listBroadcasts,
  getBroadcast,
  createBroadcast,
  updateBroadcast,
  deleteBroadcast,
} from "../lib/broadcasts.js";
import {
  linkBroadcastToKairos,
  activateBroadcast as activateKairosBroadcast,
  completeBroadcast as completeKairosBroadcast,
  reportPacing,
} from "../lib/kairos-bridge.js";
import { getBroadcastRunnerStatus } from "../lib/broadcast-runner.js";
import { buildBroadcastView } from "../lib/broadcast-view.js";
import { buildModeratorView } from "../lib/moderator-view.js";
import { checkServices } from "../lib/services.js";
import { createSportmonksClient } from "../lib/sportmonks.js";
import { requireRole } from "../lib/auth-middleware.js";
import { validateArchive, validateDelete } from "../lib/broadcast-transitions.js";

export const broadcastRoutes = new Hono();

// ---------------------------------------------------------------------------
// Role gates
// ---------------------------------------------------------------------------
// Mutating broadcast routes, the moderator-view, and operator endpoints
// (runner-status, pacing) all get explicit role gates here. Studio + admin
// inspector gates live in their own routers (routes/studio.ts,
// routes/inspector.ts). Matches the role model in `packages/blackout/auth`:
//   - admin  → full access
//   - writer → broadcast + studio (conceptual; not yet issued at sign-up)
//   - null   → basic member, matchroom only
//
// GET /broadcasts and GET /broadcasts/:id stay public so the landing page
// and matchroom can render for anonymous visitors without a login prompt.

// Moderator view superset of matchroom view; writer+admin only.
broadcastRoutes.use(
  "/broadcasts/:id/moderator-view",
  requireRole("writer", "admin"),
);

// Runner status + pacing: operator-only.
broadcastRoutes.use(
  "/broadcasts/:id/runner-status",
  requireRole("writer", "admin"),
);
broadcastRoutes.use(
  "/broadcasts/:id/pacing",
  requireRole("writer", "admin"),
);

// Fixture picker + services status — admin ops UI.
broadcastRoutes.use("/fixtures/upcoming", requireRole("writer", "admin"));
broadcastRoutes.use("/services/status", requireRole("admin"));

// Mutating broadcast CRUD — writer+admin for PATCH, admin-only for DELETE.
// GET stays public.
broadcastRoutes.on(["POST", "PATCH"], "/broadcasts", requireRole("writer", "admin"));
broadcastRoutes.on(["PATCH"], "/broadcasts/:id", requireRole("writer", "admin"));
broadcastRoutes.on(["DELETE"], "/broadcasts/:id", requireRole("admin"));

broadcastRoutes.get("/broadcasts", async (c) => {
  return c.json(await listBroadcasts());
});

broadcastRoutes.get("/broadcasts/:id", async (c) => {
  const broadcast = await getBroadcast(c.req.param("id"));
  if (!broadcast) return c.json({ error: "Not found" }, 404);
  // Return the matchroom-shaped view — broadcast row + runtime state
  // (phase, revealedEvents, currentNarrative). Shape is consistent for
  // every caller at every broadcast lifecycle stage; consumers render
  // from one payload.
  const view = await buildBroadcastView(broadcast);
  return c.json(view);
});

broadcastRoutes.get("/broadcasts/:id/moderator-view", async (c) => {
  const broadcast = await getBroadcast(c.req.param("id"));
  if (!broadcast) return c.json({ error: "Not found" }, 404);
  // Superset of the matchroom view — adds allFeedEntries (every source,
  // not just revealed match events) + allNarratives. Used by the
  // moderator console on mount to restore working state after a
  // refresh / late join.
  const view = await buildModeratorView(broadcast);
  return c.json(view);
});

broadcastRoutes.post("/broadcasts", async (c) => {
  const body = await c.req.json();

  if (!body.homeTeam || !body.awayTeam || !body.competition || !body.matchDate) {
    return c.json(
      { error: "homeTeam, awayTeam, competition, and matchDate are required" },
      400,
    );
  }

  const broadcast = await createBroadcast({
    homeTeam: body.homeTeam,
    awayTeam: body.awayTeam,
    competition: body.competition,
    matchDate: body.matchDate,
    fixtureId: body.fixtureId,
    radioSourceId: body.radioSourceId,
    matchBrief: body.matchBrief,
  });

  try {
    const linked = await linkBroadcastToKairos(broadcast.id);
    return c.json(linked, 201);
  } catch (err) {
    // Roll back the Blackout row so we never leave a half-created
    // broadcast behind (no Kairos counterpart = the moderator console
    // can't open a WS to it, the activate flow can't run, and the
    // create endpoint is the only place to bring it back into sync).
    // Best-effort delete; if it also fails, we'd rather surface the
    // original Kairos error than the cleanup error.
    await deleteBroadcast(broadcast.id).catch((cleanupErr) => {
      console.error(
        `[broadcasts.create] failed to roll back Blackout row ${broadcast.id} after Kairos link failure:`,
        cleanupErr,
      );
    });
    const message = (err as Error).message;
    console.error(`[broadcasts.create] Kairos link failed: ${message}`);
    return c.json(
      { error: `Failed to link broadcast to Kairos: ${message}` },
      502,
    );
  }
});

/** Fetch upcoming fixtures from Sportmonks for the match picker. */
broadcastRoutes.get("/fixtures/upcoming", async (c) => {
  try {
    const upcoming = await createSportmonksClient().getUpcomingFixtures();
    return c.json(upcoming);
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

broadcastRoutes.patch("/broadcasts/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json();

  // Status transitions propagate to Kairos. Other field updates go straight
  // to the database.
  if (body.status === "live") {
    const existing = await getBroadcast(id);
    if (!existing) return c.json({ error: "Not found" }, 404);
    if (existing.ttsEnabled === true && !existing.ttsVoiceId) {
      return c.json({ error: "Cannot go live — TTS is enabled but no voice is selected" }, 422);
    }
    try {
      const broadcast = await activateKairosBroadcast(id);
      return c.json(broadcast);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  if (body.status === "complete") {
    try {
      const broadcast = await completeKairosBroadcast(id);
      return c.json(broadcast);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  }

  // `complete → archived` — admin curation: exclude from replays.
  // No Kairos action. Only valid from `complete`.
  if (body.status === "archived") {
    const existing = await getBroadcast(id);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const err = validateArchive(existing.status);
    if (err) return c.json({ error: err.message }, err.statusCode);
  }

  // `draft → scheduled` is the "this is ready to go live" commitment.
  // Require the same prerequisites that live-activation needs, so a
  // scheduled broadcast never lands in a state where the runner
  // would bounce on missing data at activation time.
  if (body.status === "scheduled") {
    const existing = await getBroadcast(id);
    if (!existing) return c.json({ error: "Not found" }, 404);
    const blockers = collectScheduleBlockers(existing);
    if (blockers.length > 0) {
      return c.json({ error: `Cannot schedule — ${blockers.join("; ")}` }, 422);
    }
  }

  const broadcast = await updateBroadcast(id, body);
  if (!broadcast) return c.json({ error: "Not found" }, 404);
  return c.json(broadcast);
});

broadcastRoutes.delete("/broadcasts/:id", async (c) => {
  const id = c.req.param("id");
  const broadcast = await getBroadcast(id);
  if (!broadcast) return c.json({ error: "Not found" }, 404);
  const err = validateDelete(broadcast.status);
  if (err) return c.json({ error: err.message }, err.statusCode);
  await deleteBroadcast(id);
  return c.body(null, 204);
});

// Services-status probe — used by the broadcasts page to surface
// Sportmonks / Deepgram / Kairos availability before activation.
broadcastRoutes.get("/services/status", async (c) => {
  const services = await checkServices();
  return c.json({ services });
});

broadcastRoutes.post("/broadcasts/:id/pacing", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ wordCount?: number; playbackSeconds?: number }>();
  const { wordCount, playbackSeconds } = body;

  if (typeof wordCount !== "number" || typeof playbackSeconds !== "number") {
    return c.json({ error: "wordCount and playbackSeconds are required" }, 400);
  }

  try {
    const result = await reportPacing(id, wordCount, playbackSeconds);
    if (!result) return c.json({ status: "noop" });
    return c.json({ status: "sent", ...result });
  } catch (err) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// --- Broadcast runner status ---
// Activation (PATCH /broadcasts/:id {status: "live"}) starts the runner;
// completion (PATCH /broadcasts/:id {status: "complete"}) stops it. This
// GET is for operator observability — confirming that sources are
// running, checking for transcription errors mid-match.

broadcastRoutes.get("/broadcasts/:id/runner-status", async (c) => {
  const id = c.req.param("id");
  const status = getBroadcastRunnerStatus(id);
  if (!status) return c.json({ running: false });
  return c.json({ running: true, status });
});
