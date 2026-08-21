import type { Broadcast } from "@blackout/shared";

/**
 * Rehydrate every broadcast still marked `live` in the DB after a
 * process restart. Each rehydration mirrors activation:
 *
 *   1. `ensureRoomConductor(id)` — spins up the per-broadcast conductor
 *      that owns the Kairos feed subscription, synthesis pipeline,
 *      playback scheduler, and matchroom/moderator WS fan-out.
 *   2. `startBroadcastRunner(id)` — spins up the broadcast-runner that
 *      owns Sportmonks polling, Deepgram transcription, the pressure
 *      pipeline, and event correlation.
 *
 * Without step 2, a restart leaves the conductor healthy but the source
 * pipeline dead — Sportmonks events stop flowing, transcription stops,
 * pressure derivation stops. The match goes silent from our perspective
 * even though everything looks alive on a surface check. This was the
 * second-half-saver bug surfaced during the 2026-04-26 FA Cup SF.
 *
 * Soft-fails on benign runner-start errors (missing fixtureId / radio
 * source) — the conductor still came up, the moderator can push entries
 * by hand if desired. Other runner errors are warned but don't abort
 * rehydration of subsequent broadcasts.
 *
 * Returns the number of broadcasts rehydrated. The caller can use this
 * for the startup log line.
 */
export interface RehydrationDeps {
  listBroadcasts: () => Promise<Broadcast[]>;
  ensureRoomConductor: (broadcastId: string) => Promise<unknown>;
  isBroadcastRunnerActive: (broadcastId: string) => boolean;
  startBroadcastRunner: (broadcastId: string) => Promise<unknown>;
}

export async function rehydrateLiveBroadcasts(
  deps: RehydrationDeps,
): Promise<{ count: number }> {
  const broadcasts = await deps.listBroadcasts();
  const live = broadcasts.filter(
    (b) => b.status === "live" && !!b.kairosBroadcastId,
  );

  for (const b of live) {
    await deps.ensureRoomConductor(b.id);
    if (!deps.isBroadcastRunnerActive(b.id)) {
      try {
        await deps.startBroadcastRunner(b.id);
      } catch (err) {
        const msg = (err as Error).message;
        // Missing fixture / radio source is an expected soft-fail
        // (smoke broadcasts, manual-only runs). Other errors warrant
        // a louder log, but rehydration of the next broadcast still
        // proceeds.
        const isBenign = msg.includes("fixtureId") || msg.includes("radioSourceId");
        const level = isBenign ? "log" : "warn";
        console[level](
          `[server] broadcast runner not started for ${b.id}: ${msg}`,
        );
      }
    }
  }

  return { count: live.length };
}
