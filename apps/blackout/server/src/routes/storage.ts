import { Hono } from "hono";
import { getStorage } from "../lib/storage/index.js";
import { requireAuth } from "../lib/auth-middleware.js";

const storage = new Hono();

/**
 * Serves bytes from the StorageProvider. Only meaningful when the active
 * provider is InMemoryStorage — R2 signed URLs point at Cloudflare, not
 * here. Harmless when R2 is active; the route simply never gets hit by
 * WS cues that carry R2 URLs.
 *
 * Auth-gated (`requireAuth`): even though the in-memory fallback is a
 * dev convenience, the audit (2026-05-10) flagged its public surface.
 * The fallback can serve narration audio for active prototype broadcasts,
 * so it should not be public by default.
 *
 * `:path{.+}` is a wildcard — keys are slash-delimited (e.g.
 * `broadcasts/<id>/narrations/<id>.mp3`) and Hono otherwise treats each
 * slash as a segment break.
 */
storage.get("/storage/:path{.+}", requireAuth, async (c) => {
  const key = c.req.param("path");
  try {
    const { bytes, contentType } = await getStorage().get(key);
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return c.text("Not found", 404);
  }
});

export { storage as storageRoutes };
