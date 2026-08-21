import { getBroadcast, updateBroadcast } from "../lib/broadcasts.js";
import * as kairos from "../lib/kairos.js";
import { PHASE_FOR_TRANSITION_EVENT } from "./phase-logic.js";
import { RoomConductor } from "./RoomConductor.js";

/**
 * If a broadcast has a FULL_TIME entry and is older than this, treat it
 * as abandoned and finalise on conductor recovery instead of spawning.
 * Catches the dev/replay case where the min-match-age guard suppresses
 * auto-complete on a condensed run, leaving the broadcast stuck in
 * `live` indefinitely. A real live broadcast either completes via the
 * normal 60+ minute winddown path or gets manually finalised long
 * before this threshold.
 */
const STALE_LIVE_BROADCAST_AGE_MS = 4 * 60 * 60 * 1000; // 4 hours

/**
 * Process-wide map of active RoomConductors, keyed by Blackout broadcast
 * id. Conductors are created lazily — either when a broadcast flips to
 * `live` (via the Kairos bridge) or when the first WS client tries to
 * subscribe to an already-live broadcast after a server restart.
 *
 * Lifecycle rules:
 *   - `ensure(id)` returns the conductor, creating+starting it if the
 *     broadcast is live and linked. Returns null if the broadcast isn't
 *     live, isn't linked to Kairos, or doesn't exist.
 *   - `stop(id)` tears it down and removes it from the registry.
 *   - `stopAll()` on server shutdown.
 *
 * The registry intentionally creates a conductor even with zero clients:
 * the broadcast's playback clock is owned by the server, not by any
 * particular viewer. Narratives are synthesised and advanced through the
 * queue whether or not anyone is tuned in.
 */
const registry = new Map<string, RoomConductor>();

export async function ensureRoomConductor(
  broadcastId: string,
): Promise<RoomConductor | null> {
  const existing = registry.get(broadcastId);
  if (existing) return existing;

  const broadcast = await getBroadcast(broadcastId);
  if (!broadcast) return null;
  if (broadcast.status !== "live") return null;
  if (!broadcast.kairosBroadcastId) return null;

  // Stale-broadcast cleanup. If the broadcast already has a FULL_TIME
  // transition entry AND is hours old, the auto-complete guard
  // (shouldSuppressWinddownComplete) suppressed the natural completion
  // — typically a condensed dev/replay run. Finalise rather than
  // respawn the conductor; otherwise every server reload re-walks the
  // FSM and pumps duplicate transition entries into Kairos.
  try {
    const latest = await kairos.getLatestTransitionEventType(broadcast.kairosBroadcastId);
    const recoveredPhase = latest ? PHASE_FOR_TRANSITION_EVENT[latest] : null;
    const ageMs = Date.now() - new Date(broadcast.matchDate).getTime();
    if (recoveredPhase === "full_time_winddown" && ageMs > STALE_LIVE_BROADCAST_AGE_MS) {
      console.log(
        `[room-registry] broadcast ${broadcastId} is at full_time_winddown and ${Math.round(ageMs / 60000)}min old — finalising instead of respawning conductor`,
      );
      // Inline the completion against lib primitives — going through
      // kairos-bridge would be a circular import (kairos-bridge ↔
      // conductor/index ↔ RoomRegistry).
      try {
        await kairos.completeBroadcast(broadcast.kairosBroadcastId);
      } catch (err) {
        console.warn(
          `[room-registry] stale-broadcast Kairos completion failed for ${broadcastId}: ${(err as Error).message}`,
        );
      }
      await updateBroadcast(broadcastId, { status: "complete" }).catch((err) => {
        console.warn(
          `[room-registry] stale-broadcast row update failed for ${broadcastId}: ${(err as Error).message}`,
        );
      });
      return null;
    }
  } catch (err) {
    console.warn(
      `[room-registry] stale-broadcast check failed for ${broadcastId}: ${(err as Error).message}`,
    );
  }

  const conductor = new RoomConductor(broadcast);
  registry.set(broadcastId, conductor);
  await conductor.start();
  return conductor;
}

/** Get without creating. Returns null if not registered. */
export function getRoomConductor(broadcastId: string): RoomConductor | null {
  return registry.get(broadcastId) ?? null;
}

export function stopRoomConductor(broadcastId: string): void {
  const conductor = registry.get(broadcastId);
  if (!conductor) return;
  conductor.stop();
  registry.delete(broadcastId);
}

export function stopAllRoomConductors(): void {
  for (const [id, conductor] of registry) {
    conductor.stop();
    registry.delete(id);
  }
}

/** Iterate all active conductors — used by the graceful shutdown path. */
export function listRoomConductors(): RoomConductor[] {
  return Array.from(registry.values());
}
