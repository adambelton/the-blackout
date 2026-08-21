import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { Broadcast } from "@blackout/shared";

/**
 * buildBroadcastView aggregation contract.
 *
 * Pins the canonical-state assembly that GET /broadcasts/:id depends
 * on. The matchroom and the moderator's combined feed both render off
 * this view, so any drift in event-type recognition, dedup, score
 * derivation, or current-minute precedence shows up as a viewer-side
 * regression. This file exercises every event type the runner can
 * produce, every dedup path the view layer is responsible for, and
 * the canonical-state recovery contract (rebuilding the same view
 * from the same set of historical entries on a fresh process).
 */

// --- Module stubs ---------------------------------------------------

let listEntriesResult: Array<Record<string, unknown>> = [];
let narrationsResult: Array<Record<string, unknown>> = [];

mock.module("../src/lib/kairos.js", {
  namedExports: {
    listBroadcastEntries: async () => listEntriesResult,
    pushEntry: async () => ({ id: "stub", source: "match_events", data: {} }),
    subscribeFeed: () => ({ close: () => {} }),
    getLatestTransitionEventType: async () => null,
    triggerNarrativeGeneration: async () => undefined,
    completeBroadcast: async () => undefined,
    activateBroadcast: async () => undefined,
    sendFeedback: async () => undefined,
  },
});

mock.module("../src/db/client.js", {
  namedExports: {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve(narrationsResult),
          }),
        }),
      }),
    },
    sql: () => Promise.resolve([]),
  },
});

mock.module("../src/conductor/index.js", {
  namedExports: {
    getRoomConductor: () => null,
    ensureRoomConductor: async () => null,
    stopRoomConductor: () => undefined,
    stopAllRoomConductors: () => undefined,
    listRoomConductors: () => [],
    RoomConductor: class {},
  },
});

mock.module("../src/lib/storage/index.js", {
  namedExports: {
    getStorage: () => ({
      getPublicUrl: async () => null,
    }),
  },
});

const { buildBroadcastView } = await import("../src/lib/broadcast-view.js");

// --- Synthesis helpers ----------------------------------------------

function broadcast(overrides: Partial<Broadcast> = {}): Broadcast {
  return {
    id: "b-test",
    homeTeam: "Burnley",
    awayTeam: "Manchester City",
    competition: "Premier League",
    matchDate: "2026-05-02T14:00:00.000Z",
    status: "live",
    kairosBroadcastId: "k-test",
    createdAt: "2026-05-02T13:00:00.000Z",
    updatedAt: "2026-05-02T13:00:00.000Z",
  } as Broadcast;
}

let entrySeq = 0;
function entry(
  source: string,
  data: Record<string, unknown>,
  timestampMs?: number,
): Record<string, unknown> {
  entrySeq++;
  return {
    id: `e-${entrySeq}`,
    source,
    sourceName: source,
    data,
    timestamp: timestampMs ?? Date.now() + entrySeq,
  };
}

function realEvent(
  eventType: string,
  args: {
    sourceId: number;
    minute: number;
    player?: string;
    teamName?: string;
    side?: "home" | "away";
    result?: string;
    extraMinute?: number;
    subjectTime?: string;
  },
): Record<string, unknown> {
  return entry("match_events", {
    kind: "event",
    sourceId: args.sourceId,
    eventType,
    minute: args.minute,
    extraMinute: args.extraMinute ?? null,
    teamName: args.teamName ?? "Manchester City",
    team: args.side ?? "away",
    player: args.player ?? "Erling Haaland",
    result: args.result,
    content: `${eventType} — ${args.player ?? "Erling Haaland"} ${args.minute}'`,
    subjectTime: args.subjectTime ?? String(args.minute),
  });
}

function syntheticPhase(eventType: "KICKOFF" | "HALFTIME" | "SECOND_HALF_KICKOFF" | "FULL_TIME"): Record<string, unknown> {
  const subjectTime = eventType === "KICKOFF" ? "1" : eventType === "HALFTIME" ? "45" : eventType === "SECOND_HALF_KICKOFF" ? "46" : "90";
  return entry("match_events", {
    eventType,
    content: `${eventType} whistle`,
    subjectTime,
    phase: eventType === "KICKOFF" ? "first_half" : eventType === "HALFTIME" ? "halftime" : eventType === "SECOND_HALF_KICKOFF" ? "second_half" : "full_time",
    team: null,
    player: null,
    synthetic: true,
  });
}

function resetState(): void {
  entrySeq = 0;
  listEntriesResult = [];
  narrationsResult = [];
}

// --- Every event type lands -----------------------------------------

describe("buildBroadcastView — every event type lands in revealedEvents", () => {
  beforeEach(() => resetState());

  // The Sportmonks-mapped MatchEventType set lives in
  // apps/blackout/server/src/lib/sportmonks.ts (EVENT_TYPE_MAP). Each one
  // should round-trip through buildBroadcastView intact.
  const SPORTMONKS_EVENT_TYPES = [
    "GOAL",
    "OWN_GOAL",
    "PENALTY",
    "PENALTY_MISS",
    "SUBSTITUTION",
    "YELLOW_CARD",
    "RED_CARD",
    "SECOND_YELLOW",
    "VAR",
    "VAR_CARD",
  ] as const;

  for (const type of SPORTMONKS_EVENT_TYPES) {
    it(`recognises ${type}`, async () => {
      listEntriesResult = [
        syntheticPhase("KICKOFF"),
        realEvent(type, { sourceId: 100, minute: 12, player: "Test Player" }),
      ];
      const view = await buildBroadcastView(broadcast());
      const matched = view.revealedEvents.find((e) => e.eventType === type);
      assert.ok(matched, `${type} must appear in revealedEvents`);
      assert.equal(matched.player, "Test Player");
      assert.equal(matched.minute, 12);
    });
  }

  it("recognises every synthetic phase entry (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME)", async () => {
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      syntheticPhase("HALFTIME"),
      syntheticPhase("SECOND_HALF_KICKOFF"),
      syntheticPhase("FULL_TIME"),
    ];
    const view = await buildBroadcastView(broadcast());
    const types = view.revealedEvents.map((e) => e.eventType);
    assert.deepEqual(
      types,
      ["KICKOFF", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME"],
      "all four phase transitions must appear in chronological match-time order",
    );
  });
});

// --- Dedup contracts ------------------------------------------------

describe("buildBroadcastView — Blackout-side dedup", () => {
  beforeEach(() => resetState());

  it("collapses two real-event entries that share a sourceId (Kairos accepted a duplicate push)", async () => {
    // Pre-#27 fix: the runner could push the same Sportmonks event
    // twice across restarts before seedFromExistingEntries landed.
    // The view-layer dedup is the safety net that keeps the matchroom
    // honest even when historical data already has duplicates.
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 5000, minute: 12, player: "Haaland", result: "0-1" }),
      realEvent("GOAL", { sourceId: 5000, minute: 12, player: "Haaland", result: "0-1" }),
      realEvent("GOAL", { sourceId: 5000, minute: 12, player: "Haaland", result: "0-1" }),
    ];
    const view = await buildBroadcastView(broadcast());
    const goals = view.revealedEvents.filter((e) => e.eventType === "GOAL");
    assert.equal(goals.length, 1, "duplicate sourceIds collapse to one revealed event");
    assert.equal(view.score.away, 1, "score reflects the deduped goal exactly once");
  });

  it("collapses repeated synthetic phase entries by eventType", async () => {
    // Each runner restart re-pushes phase synthetics (until the
    // conductor's recovery + reseed land cleanly). View-layer dedup
    // collapses them so the matchroom shows one KICKOFF, not four.
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      syntheticPhase("KICKOFF"),
      syntheticPhase("KICKOFF"),
      syntheticPhase("HALFTIME"),
      syntheticPhase("HALFTIME"),
    ];
    const view = await buildBroadcastView(broadcast());
    const types = view.revealedEvents.map((e) => e.eventType);
    assert.deepEqual(types, ["KICKOFF", "HALFTIME"]);
  });

  it("does NOT collapse two distinct events that happen to share a minute", async () => {
    // Two genuine goals can land at the same minute (clock compresses
    // around stoppage, two-attack sequences). Distinct sourceIds +
    // distinct results keep them as separate revealed events.
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 6000, minute: 45, player: "Haaland", result: "0-1" }),
      realEvent("GOAL", { sourceId: 6001, minute: 45, player: "De Bruyne", result: "0-2", extraMinute: 2, subjectTime: "45+2" }),
    ];
    const view = await buildBroadcastView(broadcast());
    const goals = view.revealedEvents.filter((e) => e.eventType === "GOAL");
    assert.equal(goals.length, 2);
    assert.equal(view.score.away, 2);
  });
});

// --- Canonical state shape ------------------------------------------

describe("buildBroadcastView — score derivation", () => {
  beforeEach(() => resetState());

  it("derives score from revealed GOAL events on each side", async () => {
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 7000, minute: 12, side: "home", teamName: "Burnley" }),
      realEvent("GOAL", { sourceId: 7001, minute: 34, side: "away", teamName: "Manchester City" }),
      realEvent("GOAL", { sourceId: 7002, minute: 67, side: "home", teamName: "Burnley" }),
    ];
    const view = await buildBroadcastView(broadcast());
    assert.equal(view.score.home, 2);
    assert.equal(view.score.away, 1);
  });

  it("non-goal events don't move the score", async () => {
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      realEvent("YELLOW_CARD", { sourceId: 8000, minute: 23 }),
      realEvent("SUBSTITUTION", { sourceId: 8001, minute: 60 }),
      realEvent("RED_CARD", { sourceId: 8002, minute: 78 }),
    ];
    const view = await buildBroadcastView(broadcast());
    assert.equal(view.score.home, 0);
    assert.equal(view.score.away, 0);
  });
});

describe("buildBroadcastView — currentContentMinute precedence", () => {
  beforeEach(() => resetState());

  it("FT overrides any numeric minute once revealed", async () => {
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 9000, minute: 89, subjectTime: "89" }),
      syntheticPhase("FULL_TIME"),
    ];
    const view = await buildBroadcastView(broadcast());
    assert.equal(view.currentContentMinute, "FT");
  });

  it("HT shows only while halftime is the latest phase signal", async () => {
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      realEvent("YELLOW_CARD", { sourceId: 10000, minute: 44, subjectTime: "44" }),
      syntheticPhase("HALFTIME"),
    ];
    const view = await buildBroadcastView(broadcast());
    assert.equal(view.currentContentMinute, "HT");
  });

  it("HT gives way to numeric minute once SECOND_HALF_KICKOFF lands", async () => {
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      syntheticPhase("HALFTIME"),
      syntheticPhase("SECOND_HALF_KICKOFF"),
      realEvent("GOAL", { sourceId: 11000, minute: 67, subjectTime: "67" }),
    ];
    const view = await buildBroadcastView(broadcast());
    assert.equal(view.currentContentMinute, "67'");
  });

  it("stoppage minutes format with the +N marker", async () => {
    listEntriesResult = [
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 12000, minute: 45, extraMinute: 2, subjectTime: "45+2" }),
    ];
    const view = await buildBroadcastView(broadcast());
    assert.equal(view.currentContentMinute, "45+2'");
  });
});

// --- Recovery contract ----------------------------------------------

describe("buildBroadcastView — recovery rebuilds the same canonical state", () => {
  beforeEach(() => resetState());

  it("two calls against the same historical entry set produce identical canonical state", async () => {
    // Server-restart contract: nothing in buildBroadcastView holds
    // process-local state. The view is a pure function of the entries
    // Kairos has stored. Two calls — the second simulating a fresh
    // process — must produce identical revealedEvents, score, and
    // currentContentMinute.
    const entries = [
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 13000, minute: 12, side: "away", teamName: "Manchester City" }),
      realEvent("YELLOW_CARD", { sourceId: 13001, minute: 23, side: "home", teamName: "Burnley" }),
      syntheticPhase("HALFTIME"),
      syntheticPhase("SECOND_HALF_KICKOFF"),
      realEvent("GOAL", { sourceId: 13002, minute: 67, side: "home", teamName: "Burnley", result: "1-1" }),
      syntheticPhase("FULL_TIME"),
    ];

    listEntriesResult = entries;
    const first = await buildBroadcastView(broadcast());

    // Reset entrySeq so the second pass synthesizes fresh ids — but
    // feed the same canonical content. Real recovery scenario: the
    // server restarts, asks Kairos for the entries, gets the same set
    // back, rebuilds the view.
    entrySeq = 0;
    listEntriesResult = entries.map((e) => ({ ...e })); // shallow clone
    const second = await buildBroadcastView(broadcast());

    assert.equal(first.score.home, second.score.home);
    assert.equal(first.score.away, second.score.away);
    assert.equal(first.currentContentMinute, second.currentContentMinute);
    assert.equal(first.revealedEvents.length, second.revealedEvents.length);
    assert.deepEqual(
      first.revealedEvents.map((e) => e.eventType),
      second.revealedEvents.map((e) => e.eventType),
    );
  });

  it("adding duplicate entries to the historical set (simulating Kairos accepting double-pushes during a runner restart) doesn't change the canonical state", async () => {
    // Pre-#27, runner restart could re-push every event Kairos already
    // had. The view layer must still produce the same canonical state
    // — anything else would mean the matchroom shows ghost events
    // when the moderator restarts the server mid-match.
    const baseEntries = [
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 14000, minute: 12, side: "away" }),
      syntheticPhase("HALFTIME"),
    ];
    listEntriesResult = baseEntries;
    const before = await buildBroadcastView(broadcast());

    entrySeq = 0;
    listEntriesResult = [
      ...baseEntries.map((e) => ({ ...e })),
      // Same KICKOFF + GOAL + HALFTIME re-pushed (different entry ids,
      // same sourceId / synthetic eventType — exactly what a restart
      // looks like when reseed has misfired).
      syntheticPhase("KICKOFF"),
      realEvent("GOAL", { sourceId: 14000, minute: 12, side: "away" }),
      syntheticPhase("HALFTIME"),
    ];
    const after = await buildBroadcastView(broadcast());

    assert.equal(before.score.away, after.score.away);
    assert.equal(before.currentContentMinute, after.currentContentMinute);
    assert.equal(
      before.revealedEvents.length,
      after.revealedEvents.length,
      "duplicate pushes must not inflate the revealed-event count",
    );
  });
});
