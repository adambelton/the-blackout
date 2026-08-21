import { PostHog } from "posthog-node";

/**
 * Kairos-side telemetry. Mirrors the Blackout's `telemetry.ts` shape
 * so a single PostHog dashboard can pivot on `service` to separate
 * Kairos violations from Blackout violations and on `environment` to
 * separate dev noise from prod signal.
 *
 * Invariants at this layer are deliberately domain-agnostic — they
 * describe properties of the engine (empty generator context,
 * phantom covers, held generation streaks) without knowing anything
 * about football. Consumer-specific checks live on the Blackout side.
 */

function environmentTag(): string {
  return process.env.NODE_ENV === "production" ? "production" : "development";
}

let client: PostHog | null = null;
let initialised = false;

function getClient(): PostHog | null {
  if (initialised) return client;
  initialised = true;

  const key = process.env.POSTHOG_KEY;
  const host = process.env.POSTHOG_HOST;
  if (!key) {
    console.log("[telemetry] POSTHOG_KEY not set — capture disabled (stderr logs only)");
    return null;
  }
  client = new PostHog(key, {
    host: host || "https://eu.i.posthog.com",
    flushAt: 20,
    flushInterval: 10_000,
  });
  console.log(`[telemetry] PostHog capture active (env=${environmentTag()})`);
  return client;
}

export interface InvariantEvent {
  name: string;
  severity: "warn" | "error";
  broadcastId: string;
  narrativeId?: string;
  cycleId?: string;
  message: string;
  details?: Record<string, unknown>;
}

export function captureInvariant(event: InvariantEvent): void {
  const parts = [
    `[invariant:${event.name}]`,
    `broadcast=${event.broadcastId}`,
    event.narrativeId ? `narrative=${event.narrativeId}` : null,
    event.cycleId ? `cycle=${event.cycleId}` : null,
    event.message,
  ].filter(Boolean);
  const line = parts.join(" ");
  if (event.severity === "error") {
    console.error(line);
  } else {
    console.warn(line);
  }

  const c = getClient();
  if (!c) return;
  try {
    c.capture({
      distinctId: `broadcast:${event.broadcastId}`,
      event: "invariant_triggered",
      properties: {
        "invariant.name": event.name,
        "invariant.severity": event.severity,
        "invariant.message": event.message,
        "broadcast.id": event.broadcastId,
        ...(event.narrativeId ? { "narrative.id": event.narrativeId } : {}),
        ...(event.cycleId ? { "cycle.id": event.cycleId } : {}),
        ...(event.details ?? {}),
        service: "kairos",
        environment: environmentTag(),
      },
    });
  } catch {
    // Swallow — never break the pipeline for a telemetry failure.
  }
}

/**
 * General-purpose event capture — use this for lifecycle beats,
 * generation metrics, pipeline observations, anything we want
 * pivotable on the PostHog dashboard. Paired with `captureInvariant`
 * for the error-sentinel path; this is the routine-telemetry path.
 */
export function captureEvent(event: {
  name: string;
  broadcastId: string;
  properties?: Record<string, unknown>;
}): void {
  const c = getClient();
  if (!c) return;
  try {
    c.capture({
      distinctId: `broadcast:${event.broadcastId}`,
      event: event.name,
      properties: {
        "broadcast.id": event.broadcastId,
        ...(event.properties ?? {}),
        service: "kairos",
        environment: environmentTag(),
      },
    });
  } catch {
    // Swallow.
  }
}

export async function flushTelemetry(): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.shutdown();
  } catch {
    // Ignore.
  }
}
