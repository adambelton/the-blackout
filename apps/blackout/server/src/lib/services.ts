import type { ServiceStatus } from "@blackout/shared";
import * as kairos from "./kairos.js";

/**
 * Probe the external services the broadcast pipeline depends on and
 * return a status summary. Used by the moderator WS on connect and
 * by the broadcasts page's REST poll so admins can see at a glance
 * whether Sportmonks / Deepgram / Kairos are reachable before
 * activating the broadcast.
 *
 * Results are mutually independent — one failure doesn't abort the
 * others. Callers can render a row of dots keyed by `name`.
 */
export async function checkServices(): Promise<ServiceStatus[]> {
  const results: ServiceStatus[] = [];

  const sportmonksToken = process.env.SPORTMONKS_API_TOKEN;
  if (!sportmonksToken) {
    results.push({ name: "sportmonks", status: "unconfigured" });
  } else {
    try {
      const res = await fetch(
        `https://api.sportmonks.com/v3/football/leagues?api_token=${sportmonksToken}&per_page=1`,
      );
      results.push(
        res.ok
          ? { name: "sportmonks", status: "ok" }
          : { name: "sportmonks", status: "error", message: `HTTP ${res.status}` },
      );
    } catch (err) {
      results.push({ name: "sportmonks", status: "error", message: (err as Error).message });
    }
  }

  if (!process.env.DEEPGRAM_API_KEY) {
    results.push({ name: "deepgram", status: "unconfigured" });
  } else {
    try {
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${process.env.DEEPGRAM_API_KEY}` },
      });
      results.push(
        res.ok
          ? { name: "deepgram", status: "ok" }
          : { name: "deepgram", status: "error", message: `HTTP ${res.status}` },
      );
    } catch (err) {
      results.push({ name: "deepgram", status: "error", message: (err as Error).message });
    }
  }

  try {
    await kairos.getHealth();
    results.push({ name: "kairos", status: "ok" });
  } catch (err) {
    results.push({ name: "kairos", status: "error", message: (err as Error).message });
  }

  return results;
}
