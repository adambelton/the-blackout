import { describe, it, before, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { Broadcast } from "@blackout/shared";

/**
 * Conductor → phase transition contract.
 *
 * The runner is the single emitter of synthetic phase-transition
 * match_events entries. The conductor consumes them via the Kairos
 * feed subscription and reaches `transitionTo` through
 * `maybeTransitionFromEntry` — same code path replay uses. These
 * tests pin that consumer side: each synthetic entry advances the
 * phase, and the halftime / closing prompts still fire from the
 * resulting transition.
 *
 * Tests for the producer side (runner pushing the synthetic entry
 * on Sportmonks lifecycle callbacks) live in the Sportmonks → Kairos
 * e2e harness.
 */

// --- Module stubs ---------------------------------------------------
//
// `mock.module` must run BEFORE the conductor's import chain, since
// ESM resolves all named imports eagerly. Capture the subscribeFeed
// callbacks so the test can drive entries through the production
// onEntry path; everything else is a no-op.

interface CapturedFeed {
  onSync?: (entries: Array<Record<string, unknown>>) => void;
  onEntry?: (entry: Record<string, unknown>) => void;
}

const triggerNarrativeCalls: Array<{ broadcastId: string; prompt: string }> = [];
let getLatestTransitionResult:
  | "KICKOFF"
  | "HALFTIME"
  | "SECOND_HALF_KICKOFF"
  | "FULL_TIME"
  | null = null;
let captured: CapturedFeed = {};

mock.module("../src/lib/kairos.js", {
  namedExports: {
    pushEntry: async () => ({ id: "noop", source: "match_events", data: {}, timestamp: Date.now() }),
    subscribeFeed: (_id: string, handlers: CapturedFeed) => {
      captured = handlers;
      return { close: () => {} };
    },
    getLatestTransitionEventType: async () => getLatestTransitionResult,
    listBroadcastEntries: async () => [],
    triggerNarrativeGeneration: async (broadcastId: string, prompt: string) => {
      triggerNarrativeCalls.push({ broadcastId, prompt });
    },
    completeBroadcast: async () => undefined,
    activateBroadcast: async () => undefined,
    sendFeedback: async () => undefined,
    KAIROS_URL: "http://stub",
  },
});

mock.module("../src/db/client.js", {
  namedExports: {
    db: {
      select: () => ({ from: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }) }),
      insert: () => ({ values: () => Promise.resolve() }),
      update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    },
    sql: () => Promise.resolve([]),
  },
});

mock.module("../src/lib/kairos-bridge.js", {
  namedExports: {
    reportPacing: async () => undefined,
  },
});

mock.module("../src/lib/replicate.js", {
  namedExports: {
    generateImage: async () => null,
  },
});

mock.module("../src/conductor/synthesiser.js", {
  namedExports: {
    synthesiseNarration: async () => null,
  },
});

const { RoomConductor } = await import("../src/conductor/RoomConductor.js");

// --- Fixtures -------------------------------------------------------

function fakeBroadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "b-test",
    homeTeam: "Burnley",
    awayTeam: "Manchester City",
    competition: "Premier League",
    matchDate: "2026-05-02T14:00:00.000Z",
    status: "live",
    kairosBroadcastId: "k-test",
    ttsEnabled: false,
    createdAt: "2026-05-02T13:00:00.000Z",
    updatedAt: "2026-05-02T13:00:00.000Z",
    ...overrides,
  } as Broadcast;
}

let nextEntryId = 1;
function syntheticEntry(
  eventType: "KICKOFF" | "HALFTIME" | "SECOND_HALF_KICKOFF" | "FULL_TIME",
  phase: "first_half" | "halftime" | "second_half" | "full_time",
): Record<string, unknown> {
  return {
    id: `entry-${nextEntryId++}`,
    source: "match_events",
    data: {
      eventType,
      content: `${eventType} synthetic`,
      subjectTime: phase === "halftime" ? "45" : phase === "full_time" ? "90" : "1",
      phase,
      team: null,
      player: null,
      synthetic: true,
    },
    timestamp: Date.now(),
  };
}

function deliver(entry: Record<string, unknown>): void {
  if (!captured.onEntry) throw new Error("subscribeFeed not wired");
  captured.onEntry(entry);
}

function resetState(): void {
  triggerNarrativeCalls.length = 0;
  getLatestTransitionResult = null;
  captured = {};
  nextEntryId = 1;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

// --- Tests ----------------------------------------------------------

describe("RoomConductor — synthetic phase entry advances the phase FSM", () => {
  beforeEach(() => {
    resetState();
  });

  it("KICKOFF entry: warming → live_first_half", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();

    deliver(syntheticEntry("KICKOFF", "first_half"));

    assert.equal(conductor.getSubjectPhase(), "live_first_half");
  });

  it("HALFTIME entry: live_first_half → halftime", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();
    deliver(syntheticEntry("KICKOFF", "first_half"));

    deliver(syntheticEntry("HALFTIME", "halftime"));

    assert.equal(conductor.getSubjectPhase(), "halftime");
  });

  it("SECOND_HALF_KICKOFF entry: halftime → live_second_half", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();
    deliver(syntheticEntry("KICKOFF", "first_half"));
    deliver(syntheticEntry("HALFTIME", "halftime"));

    deliver(syntheticEntry("SECOND_HALF_KICKOFF", "second_half"));

    assert.equal(conductor.getSubjectPhase(), "live_second_half");
  });

  it("FULL_TIME entry: live_second_half → full_time_winddown", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();
    deliver(syntheticEntry("KICKOFF", "first_half"));
    deliver(syntheticEntry("HALFTIME", "halftime"));
    deliver(syntheticEntry("SECOND_HALF_KICKOFF", "second_half"));

    deliver(syntheticEntry("FULL_TIME", "full_time"));

    assert.equal(conductor.getSubjectPhase(), "full_time_winddown");
  });
});

describe("RoomConductor — transition idempotency", () => {
  beforeEach(() => {
    resetState();
  });

  it("a second entry for the same phase is a no-op", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();
    deliver(syntheticEntry("KICKOFF", "first_half"));
    triggerNarrativeCalls.length = 0;

    deliver(syntheticEntry("KICKOFF", "first_half"));

    assert.equal(conductor.getSubjectPhase(), "live_first_half");
  });

  it("backward phase entry is rejected (no transition to earlier phase)", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();
    deliver(syntheticEntry("KICKOFF", "first_half"));
    deliver(syntheticEntry("HALFTIME", "halftime"));

    deliver(syntheticEntry("KICKOFF", "first_half"));

    assert.equal(conductor.getSubjectPhase(), "halftime");
  });
});

describe("RoomConductor — explicit generation triggers on phase boundaries", () => {
  beforeEach(() => {
    resetState();
  });

  it("entering halftime triggers an explicit generation request to Kairos", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();
    deliver(syntheticEntry("KICKOFF", "first_half"));
    deliver(syntheticEntry("HALFTIME", "halftime"));
    await flushMicrotasks();

    assert.equal(triggerNarrativeCalls.length, 1);
    assert.equal(triggerNarrativeCalls[0].broadcastId, "k-test");
    assert.match(triggerNarrativeCalls[0].prompt, /half-?time|reflection|first half/i);
  });

  it("entering full_time_winddown triggers an explicit closing-passage generation", async () => {
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();
    deliver(syntheticEntry("KICKOFF", "first_half"));
    deliver(syntheticEntry("HALFTIME", "halftime"));
    deliver(syntheticEntry("SECOND_HALF_KICKOFF", "second_half"));
    deliver(syntheticEntry("FULL_TIME", "full_time"));
    await flushMicrotasks();

    // Two explicit triggers across the test: halftime + closing.
    assert.equal(triggerNarrativeCalls.length, 2);
    assert.match(triggerNarrativeCalls[1].prompt, /closing|full-?time/i);
  });
});

describe("RoomConductor — phase recovery from existing transition entries", () => {
  beforeEach(() => {
    resetState();
  });

  it("recovers from KICKOFF history → conductor at live_first_half", async () => {
    getLatestTransitionResult = "KICKOFF";
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();

    assert.equal(conductor.getSubjectPhase(), "live_first_half");
  });

  it("recovers from HALFTIME history → conductor at halftime", async () => {
    getLatestTransitionResult = "HALFTIME";
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();

    assert.equal(conductor.getSubjectPhase(), "halftime");
  });

  it("recovers from FULL_TIME history → conductor at full_time_winddown", async () => {
    getLatestTransitionResult = "FULL_TIME";
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();

    assert.equal(conductor.getSubjectPhase(), "full_time_winddown");
  });

  it("no history → conductor stays at warming", async () => {
    getLatestTransitionResult = null;
    const conductor = new RoomConductor(fakeBroadcast());
    await conductor.start();

    assert.equal(conductor.getSubjectPhase(), "warming");
  });
});
