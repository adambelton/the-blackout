import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rehydrateLiveBroadcasts } from "../src/lib/rehydration.js";
import type { Broadcast } from "@blackout/shared";

/**
 * Process-restart rehydration contract.
 *
 * Real bug from 2026-04-26: rehydration restarted conductors but never
 * the broadcast runners. Even with `status: live` in DB, transcription /
 * Sportmonks polling / pressure pipeline / event correlation all stayed
 * dead. The conductor was healthy but the source pipeline was silent —
 * no second-half kickoff event, no distilled commentary, nothing
 * flowing for the entire post-restart window. Match was effectively
 * dead from our perspective for 1h 56m.
 *
 * Contract: rehydration must mirror activation. Conductor AND runner
 * both come up for every live broadcast on process restart.
 */
function broadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "b1",
    homeTeam: "Home",
    awayTeam: "Away",
    competition: "Test",
    matchDate: "2026-04-26",
    status: "live",
    kairosBroadcastId: "k1",
    createdAt: "2026-04-26T14:00:00.000Z",
    updatedAt: "2026-04-26T14:00:00.000Z",
    ...overrides,
  } as Broadcast;
}

describe("rehydrateLiveBroadcasts — process restart contract", () => {
  it("starts both the room conductor AND the broadcast runner for each live broadcast", async () => {
    const conductorCalls: string[] = [];
    const runnerCalls: string[] = [];

    const result = await rehydrateLiveBroadcasts({
      listBroadcasts: async () => [broadcast({ id: "b1" }), broadcast({ id: "b2" })],
      ensureRoomConductor: async (id) => {
        conductorCalls.push(id);
      },
      isBroadcastRunnerActive: () => false,
      startBroadcastRunner: async (id) => {
        runnerCalls.push(id);
      },
    });

    assert.deepEqual(conductorCalls, ["b1", "b2"]);
    assert.deepEqual(runnerCalls, ["b1", "b2"]);
    assert.equal(result.count, 2);
  });

  it("skips broadcasts whose status is not live", async () => {
    const conductorCalls: string[] = [];
    const runnerCalls: string[] = [];

    const result = await rehydrateLiveBroadcasts({
      listBroadcasts: async () => [
        broadcast({ id: "scheduled-only", status: "scheduled" }),
        broadcast({ id: "completed", status: "complete" }),
        broadcast({ id: "draft-only", status: "draft" }),
        broadcast({ id: "live-yes", status: "live" }),
      ],
      ensureRoomConductor: async (id) => {
        conductorCalls.push(id);
      },
      isBroadcastRunnerActive: () => false,
      startBroadcastRunner: async (id) => {
        runnerCalls.push(id);
      },
    });

    assert.deepEqual(conductorCalls, ["live-yes"]);
    assert.deepEqual(runnerCalls, ["live-yes"]);
    assert.equal(result.count, 1);
  });

  it("skips broadcasts that have no kairosBroadcastId (never linked)", async () => {
    const runnerCalls: string[] = [];

    const result = await rehydrateLiveBroadcasts({
      listBroadcasts: async () => [
        broadcast({ id: "unlinked", kairosBroadcastId: undefined }),
      ],
      ensureRoomConductor: async () => assert.fail("conductor must not start for unlinked broadcast"),
      isBroadcastRunnerActive: () => false,
      startBroadcastRunner: async (id) => {
        runnerCalls.push(id);
      },
    });

    assert.equal(runnerCalls.length, 0);
    assert.equal(result.count, 0);
  });

  it("does not call startBroadcastRunner when the runner is already active", async () => {
    const runnerCalls: string[] = [];

    await rehydrateLiveBroadcasts({
      listBroadcasts: async () => [broadcast({ id: "b1" })],
      ensureRoomConductor: async () => undefined,
      isBroadcastRunnerActive: (id) => id === "b1",
      startBroadcastRunner: async (id) => {
        runnerCalls.push(id);
      },
    });

    assert.deepEqual(runnerCalls, []);
  });

  it("soft-fails on benign runner-start errors (missing fixtureId / radioSourceId)", async () => {
    const conductorCalls: string[] = [];

    const result = await rehydrateLiveBroadcasts({
      listBroadcasts: async () => [
        broadcast({ id: "smoke" }),
        broadcast({ id: "real" }),
      ],
      ensureRoomConductor: async (id) => {
        conductorCalls.push(id);
      },
      isBroadcastRunnerActive: () => false,
      startBroadcastRunner: async (id) => {
        if (id === "smoke") throw new Error("Broadcast has no fixtureId — Sportmonks polling can't start");
      },
    });

    // Both conductors still started — runner soft-fail on `smoke` did
    // not abort rehydration of `real`.
    assert.deepEqual(conductorCalls, ["smoke", "real"]);
    assert.equal(result.count, 2);
  });
});
