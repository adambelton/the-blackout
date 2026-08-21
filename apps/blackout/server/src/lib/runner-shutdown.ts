/**
 * Pure shutdown helper. Lives in its own module so the contract test
 * can import + verify the call shape without triggering the broadcast-
 * runner module's full DB / Kairos / Sportmonks dependency chain.
 *
 * Real bug from 2026-04-26: process shutdown silently completed live
 * broadcasts because `stopBroadcastRunner` defaulted to
 * `completeBroadcast: true`. Every restart flipped status to complete.
 *
 * Contract: process shutdown is *not* a match-end signal. Completion
 * belongs only to the moderator's explicit action or the conductor's
 * auto-complete on full-time.
 */
export async function stopRunnerIdsForShutdown(
  ids: string[],
  stop: (id: string, opts: { completeBroadcast: boolean }) => Promise<unknown>,
): Promise<void> {
  for (const id of ids) {
    await stop(id, { completeBroadcast: false }).catch((err) =>
      console.error(`[broadcast-runner] stop failed for ${id}: ${(err as Error).message}`),
    );
  }
}
