/**
 * Single Anthropic client per app. Hoisted from three identical
 * `getClient()` helpers (distiller.ts, prompt-suggester.ts,
 * tag-deriver.ts) per the codebase audit (2026-05-10) — duplicated
 * caches risked drifting their `maxRetries` / SDK options apart. One
 * client, one cache, one place to tune.
 *
 * Lazy-initialised so apps that don't hit any Anthropic-using path
 * (the moderator-only test broadcasts, replay-only deployments) don't
 * fail to boot when the env var is absent.
 */
import Anthropic from "@anthropic-ai/sdk";

let cached: Anthropic | null = null;

/**
 * Returns the singleton Anthropic client. `purpose` is woven into the
 * thrown error so a missing API key surfaces with the calling
 * subsystem's name instead of the generic "ANTHROPIC_API_KEY is not
 * set" message that previously appeared from any of three sites.
 */
export function getAnthropicClient(purpose: string): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(`ANTHROPIC_API_KEY is not set — ${purpose} unavailable`);
  }
  cached = new Anthropic({ apiKey, maxRetries: 3 });
  return cached;
}
