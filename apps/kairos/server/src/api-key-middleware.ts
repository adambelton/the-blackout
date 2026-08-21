/**
 * API-key authentication for Kairos consumers.
 *
 * Kairos is a standalone narrative-orchestration engine — its first
 * consumer is The Blackout, but it's designed to serve multiple
 * consumers in the future. So the auth model is a generic bearer
 * API-key scheme rather than a shared secret tied to one consumer.
 *
 * Stage 1 (current): valid keys come from the `KAIROS_API_KEYS` env
 * var, comma-separated. Constant-time compare against the presented
 * token.
 *
 * Stage 2 (when Kairos becomes a standalone product): move the key
 * list into a database table (`api_keys`) with per-key scopes,
 * revocation, and usage tracking. The wire protocol
 * (`Authorization: Bearer <token>`) doesn't change — only the
 * validation source.
 *
 * `/health` is exempt so Fly's health checks and ops tooling can reach
 * it without a key.
 */
import type { MiddlewareHandler } from "hono";
import { timingSafeEqual } from "node:crypto";

function getValidKeys(): string[] {
  const raw = process.env.KAIROS_API_KEYS ?? "";
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

function constantTimeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return timingSafeEqual(bufA, bufB);
}

function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Validates the Authorization bearer token against `KAIROS_API_KEYS`.
 * Any route not on the exempt list requires a valid key.
 */
export const apiKeyAuth: MiddlewareHandler = async (c, next) => {
  // Health is always public — Fly and uptime monitors need to hit
  // it without credentials.
  if (c.req.path === "/health") {
    await next();
    return;
  }

  const validKeys = getValidKeys();
  if (validKeys.length === 0) {
    // Fail closed: if no keys are configured, reject every request.
    // Prevents a deploy from accidentally shipping in an open state.
    return c.json(
      { error: "Kairos has no API keys configured — all requests rejected" },
      503,
    );
  }

  const presented = extractBearer(c.req.header("authorization"));
  if (!presented) {
    return c.json(
      { error: "Authorization: Bearer <token> is required" },
      401,
    );
  }

  const matched = validKeys.some((valid) =>
    constantTimeCompare(valid, presented),
  );
  if (!matched) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  await next();
};
