import { PostHog } from "posthog-node";

/**
 * Server-side telemetry — invariant violations and anything else we
 * want to surface to PostHog without going through a browser. Logs
 * to stderr always; PostHog capture fires whenever `POSTHOG_KEY` is
 * set, regardless of environment, with an `environment` property on
 * every event so dashboards can filter dev from prod explicitly.
 *
 * Events are keyed on `broadcast:<id>` as `distinctId` so PostHog
 * aggregates by broadcast. Event properties carry the invariant name
 * and any structured context the check surfaced.
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
    // Batch up to 20 events before flushing. At our volume (handful
    // of invariants per cycle × ~120 cycles per match) this flushes
    // on the interval rather than on batch-full most of the time.
    flushAt: 20,
    flushInterval: 10_000,
  });
  console.log(`[telemetry] PostHog capture active (env=${environmentTag()})`);
  return client;
}

export interface InvariantEvent {
  /** Short, stable identifier. Goes into PostHog as `invariant.name`. */
  name: string;
  /** `warn` for recoverable deviations; `error` for hard bugs. */
  severity: "warn" | "error";
  /** Blackout broadcast id — aggregates events per broadcast. */
  broadcastId: string;
  /** Kairos narrative id if the invariant was checked during a generation. */
  narrativeId?: string;
  /** Kairos pipeline cycle id if the invariant was checked during a flush. */
  cycleId?: string;
  /** Short human-readable summary — shown in the log line. */
  message: string;
  /** Any structured context a human or dashboard query would want. */
  details?: Record<string, unknown>;
}

/**
 * Emit an invariant-violation event. Always logs; conditionally sends
 * to PostHog. Safe to call frequently — the helper handles batching
 * and failures silently.
 */
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
        service: "blackout-server",
        environment: environmentTag(),
      },
    });
  } catch {
    // Swallow — telemetry must never break the request path.
  }
}

/**
 * General-purpose event capture — use this for lifecycle beats,
 * throughput observations, user actions, anything we want pivotable
 * on the PostHog dashboard without going through a browser.
 *
 * Event name should read like `subject_verb_object`: `broadcast_activated`,
 * `narration_synthesized`, `phase_transitioned`. Stays greppable and
 * works naturally with PostHog's insights UI.
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
        service: "blackout-server",
        environment: environmentTag(),
      },
    });
  } catch {
    // Swallow.
  }
}

/** Flush pending events. Call during graceful shutdown. */
export async function flushTelemetry(): Promise<void> {
  const c = getClient();
  if (!c) return;
  try {
    await c.shutdown();
  } catch {
    // Ignore — best effort.
  }
}
