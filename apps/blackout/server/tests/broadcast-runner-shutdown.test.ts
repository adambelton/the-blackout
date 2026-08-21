import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { stopRunnerIdsForShutdown } from "../src/lib/runner-shutdown.js";

/**
 * Process-shutdown contract for broadcast runners.
 *
 * Real bug from 2026-04-26: `stopAllBroadcastRunners` defaulted to
 * `completeBroadcast: true` (the default of `stopBroadcastRunner`).
 * Every tsx watch restart, every SIGTERM during deploys, every graceful
 * shutdown silently flipped active broadcasts to `status: complete` and
 * told Kairos to close its runtime. Mid-second-half restart of the FA
 * Cup semi-final killed the broadcast cleanly.
 *
 * Contract: shutdown is *not* a match-end signal. Completion belongs
 * only to the moderator's explicit action or the conductor's auto-
 * complete on full-time.
 */
describe("broadcast-runner shutdown contract", () => {
  it("calls stop() with completeBroadcast: false for every active runner id", async () => {
    const calls: Array<{ id: string; completeBroadcast: boolean }> = [];
    const stopSpy = async (id: string, opts: { completeBroadcast: boolean }) => {
      calls.push({ id, completeBroadcast: opts.completeBroadcast });
    };

    await stopRunnerIdsForShutdown(["b1", "b2", "b3"], stopSpy);

    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(
        call.completeBroadcast,
        false,
        `shutdown must pass completeBroadcast: false (got ${call.completeBroadcast} for ${call.id})`,
      );
    }
    assert.deepEqual(calls.map((c) => c.id), ["b1", "b2", "b3"]);
  });

  it("returns cleanly when there are no active runners", async () => {
    const stopSpy = async () => assert.fail("stop should not be called");
    await stopRunnerIdsForShutdown([], stopSpy);
    // No assertion needed — reaching here means no throws + no spurious calls.
  });

  it("continues to subsequent ids when one stop call rejects", async () => {
    const stopped: string[] = [];
    const stopSpy = async (id: string) => {
      if (id === "b2") throw new Error("stop b2 failed");
      stopped.push(id);
    };

    await stopRunnerIdsForShutdown(["b1", "b2", "b3"], stopSpy);

    assert.deepEqual(stopped, ["b1", "b3"]);
  });
});
