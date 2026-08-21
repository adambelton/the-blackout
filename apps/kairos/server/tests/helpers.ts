/**
 * Test harness: loads the test database, exposes a fetcher that drives
 * the Hono app via `app.fetch` (no port binding), truncates runtime
 * tables between tests, and substitutes a stubbed LLM client.
 */

// MUST be the first import — populates process.env before anything
// that reads env at module load (auth.ts, api-key-middleware.ts).
// See test-env.ts for why this needs to be its own side-effect module.
import { TEST_API_KEY, TEST_INTERNAL_API_SECRET } from "./test-env.js";

import type { Hono } from "hono";
import { createApp } from "../src/app.js";
import { sql } from "../src/db/client.js";
import { setRuntimeDependencies, stopAllRuntimes } from "../src/broadcast.js";
import { StubLLMClient, type ScriptedOutcome } from "../src/llm/stub.js";

export { sql };

export interface TestContext {
  app: Hono;
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  llm: StubLLMClient;
}

export async function createTestContext(responses: ScriptedOutcome[] = []): Promise<TestContext> {
  const llm = new StubLLMClient(responses);
  setRuntimeDependencies({ llm });

  const app = createApp();
  const fetch = (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    // Consumer surface (broadcasts/narrative/pool) takes apiKey;
    // admin surface (profiles/specs) takes the internal-secret bypass
    // since tests can't go through OAuth. Stamp both unconditionally
    // so a single fetch helper covers either route family.
    if (!headers.has("authorization")) {
      headers.set("Authorization", `Bearer ${TEST_API_KEY}`);
    }
    if (!headers.has("x-internal-api-secret")) {
      headers.set("X-Internal-Api-Secret", TEST_INTERNAL_API_SECRET);
    }
    return app.fetch(new Request(`http://test.local${path}`, { ...init, headers }));
  };

  return { app, fetch, llm };
}

/**
 * Stop any live runtimes and truncate broadcast-scoped tables. Event
 * profiles and service specs are left in place — they are platform
 * content, not test data.
 */
export async function resetRuntimeData(): Promise<void> {
  stopAllRuntimes();
  await sql`TRUNCATE broadcasts, sources, feed_entries, generations, enrichment_service_states RESTART IDENTITY CASCADE`;
}

export async function closeConnection(): Promise<void> {
  await sql.end();
}

export function jsonBody(data: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}

export function patchBody(data: unknown): RequestInit {
  return {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  };
}
