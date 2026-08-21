import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Load apps/blackout/server/.env at import time. Imported first by any entry
// point that needs env vars before other modules initialise (db client,
// seed scripts, etc). Mirrors the Kairos pattern — each app owns its
// own .env.

// `import.meta.dirname` is undefined under some third-party TS loaders
// (e.g. drizzle-kit's bundler). Derive the directory from `import.meta.url`
// instead so this works the same in tsx, node, and drizzle-kit.
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, "../.env");
try {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
} catch {
  // .env not found — rely on environment variables
}

/**
 * Required env vars for live broadcast operation. Missing values fail
 * loudly when the runner starts rather than silently failing on first
 * activation (the previous behaviour: a smoke broadcast would start
 * the conductor, transition to live, then throw mid-flight when
 * `BroadcastRunner.start` consulted `process.env.DEEPGRAM_API_KEY`).
 *
 * Variables NOT validated here:
 *   - `ANTHROPIC_API_KEY` — only required by Kairos-using paths.
 *     Lazy validation in `lib/anthropic.ts` keeps moderator-only
 *     deployments bootable without it.
 *   - `REPLICATE_API_TOKEN` — only required by illustration generation.
 *   - `DATABASE_URL` — `db/client.ts` enforces.
 *   - Storage / TTS provider creds — only required when their path
 *     is used; lazy validation in their respective clients.
 */
const REQUIRED_LIVE_BROADCAST_VARS = [
  "DEEPGRAM_API_KEY",
  "SPORTMONKS_API_TOKEN",
] as const;

export function assertLiveBroadcastEnv(): void {
  for (const key of REQUIRED_LIVE_BROADCAST_VARS) {
    if (!process.env[key]) {
      throw new Error(`${key} is not set — live broadcast operation unavailable`);
    }
  }
}
