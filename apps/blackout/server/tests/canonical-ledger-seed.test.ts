import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildCanonicalLedgerSeed } from "../src/lib/canonical-ledger-seed.js";

/**
 * The runner's canonicalLedger is in-memory and starts empty on every
 * restart. Without this seed, commentary claims for events that
 * already happened (KICKOFF, past GOALs) expire without matching any
 * canonical — the "[correlation] N claim(s) expired" log spam from
 * the 2026-05-02 live test. The seed reconstructs the historical
 * canonical events from Kairos's persisted entries so late-arriving
 * commentary about old events can still calibration-sample on them.
 *
 * Pure transform — these tests pin every shape decision the seeder
 * makes.
 */

const BROADCAST_ID = "b-test";

function entry(
  data: Record<string, unknown>,
  overrides: { id?: string; timestamp?: number; source?: string } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? `e-${Math.random().toString(36).slice(2, 8)}`,
    source: overrides.source ?? "match_events",
    timestamp: overrides.timestamp ?? Date.now(),
    data,
  };
}

describe("buildCanonicalLedgerSeed", () => {
  it("returns an empty array for an empty input", () => {
    assert.deepEqual(buildCanonicalLedgerSeed([], BROADCAST_ID), []);
  });

  it("seeds one canonical entry per recognised eventType", () => {
    const result = buildCanonicalLedgerSeed(
      [
        entry({ eventType: "GOAL", sourceId: 1000, minute: 12, player: "Erling Haaland", teamName: "Manchester City", subjectTime: "12" }),
        entry({ eventType: "YELLOW_CARD", sourceId: 1001, minute: 23, player: "Dan Burn", teamName: "Burnley", subjectTime: "23" }),
        entry({ eventType: "SUBSTITUTION", sourceId: 1002, minute: 60, player: "Phil Foden", teamName: "Manchester City", subjectTime: "60" }),
      ],
      BROADCAST_ID,
    );
    assert.equal(result.length, 3);
    assert.deepEqual(result.map((c) => c.eventClass), ["GOAL", "YELLOW_CARD", "SUBSTITUTION"]);
  });

  it("seeds synthetic phase entries (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME)", () => {
    const result = buildCanonicalLedgerSeed(
      [
        entry({ eventType: "KICKOFF", synthetic: true, subjectTime: "1" }),
        entry({ eventType: "HALFTIME", synthetic: true, subjectTime: "45" }),
        entry({ eventType: "SECOND_HALF_KICKOFF", synthetic: true, subjectTime: "46" }),
        entry({ eventType: "FULL_TIME", synthetic: true, subjectTime: "90" }),
      ],
      BROADCAST_ID,
    );
    const classes = result.map((c) => c.eventClass);
    assert.deepEqual(classes, ["KICKOFF", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME"]);
  });

  it("derives eventId from data.sourceId when present (numeric or string)", () => {
    const numeric = buildCanonicalLedgerSeed(
      [entry({ eventType: "GOAL", sourceId: 12345, minute: 12 })],
      BROADCAST_ID,
    );
    assert.equal(numeric[0].eventId, "12345");

    const stringy = buildCanonicalLedgerSeed(
      [entry({ eventType: "GOAL", sourceId: "src-abc", minute: 12 })],
      BROADCAST_ID,
    );
    assert.equal(stringy[0].eventId, "src-abc");
  });

  it("derives synthetic-phase eventId as `phase:<class>:<broadcastId>`", () => {
    const result = buildCanonicalLedgerSeed(
      [entry({ eventType: "KICKOFF", synthetic: true, subjectTime: "1" })],
      BROADCAST_ID,
    );
    assert.equal(result[0].eventId, "phase:kickoff:b-test");
  });

  it("derives a fallback eventId for a non-synthetic entry without sourceId", () => {
    const result = buildCanonicalLedgerSeed(
      [entry({ eventType: "GOAL", minute: 12, subjectTime: "12" })],
      BROADCAST_ID,
    );
    assert.equal(result[0].eventId, "evt:GOAL:12");
  });

  it("uses the entry's stored timestamp for realWallClockMs (so historical correlation timing is preserved)", () => {
    const fixedTimestamp = 1_777_724_438_014;
    const result = buildCanonicalLedgerSeed(
      [entry(
        { eventType: "GOAL", sourceId: 1000, minute: 12, player: "Haaland" },
        { timestamp: fixedTimestamp },
      )],
      BROADCAST_ID,
    );
    assert.equal(result[0].realWallClockMs, fixedTimestamp);
    assert.equal(result[0].addedAt, fixedTimestamp, "addedAt mirrors realWallClockMs");
  });

  it("normalises player to lowercased surname (≥3 chars) via surnameKey", () => {
    const result = buildCanonicalLedgerSeed(
      [
        entry({ eventType: "GOAL", sourceId: 1, minute: 12, player: "Erling Haaland" }),
        entry({ eventType: "GOAL", sourceId: 2, minute: 13, player: "Joe Lo" }), // surname too short
        entry({ eventType: "GOAL", sourceId: 3, minute: 14 }), // no player
      ],
      BROADCAST_ID,
    );
    assert.equal(result[0].playerLastName, "haaland");
    assert.equal(result[1].playerLastName, null, "surnames <3 chars drop to null");
    assert.equal(result[2].playerLastName, null, "missing player → null");
  });

  it("normalises teamName to lowercased trimmed key via teamKey", () => {
    const result = buildCanonicalLedgerSeed(
      [
        entry({ eventType: "PENALTY_AWARDED", sourceId: 1, minute: 30, teamName: "Manchester City" }),
        entry({ eventType: "PENALTY_AWARDED", sourceId: 2, minute: 31 }), // no team
      ],
      BROADCAST_ID,
    );
    assert.equal(result[0].teamKey, "manchester city");
    assert.equal(result[1].teamKey, null);
  });

  it("preserves subjectTime as the entry's data.subjectTime when present", () => {
    const result = buildCanonicalLedgerSeed(
      [entry({ eventType: "GOAL", sourceId: 1, minute: 45, extraMinute: 2, subjectTime: "45+2" })],
      BROADCAST_ID,
    );
    assert.equal(result[0].subjectTime, "45+2");
  });

  it("falls back to data.minute as subjectTime when data.subjectTime is missing", () => {
    const result = buildCanonicalLedgerSeed(
      [entry({ eventType: "GOAL", sourceId: 1, minute: 12 })],
      BROADCAST_ID,
    );
    assert.equal(result[0].subjectTime, "12");
  });

  it("skips entries without an eventType", () => {
    const result = buildCanonicalLedgerSeed(
      [
        entry({ kind: "timeline", sourceId: 99, content: "Shot On Target" }),
        entry({ kind: "atmosphere", content: "the crowd quietens" }),
        entry({ eventType: "GOAL", sourceId: 1, minute: 12 }),
      ],
      BROADCAST_ID,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].eventClass, "GOAL");
  });

  it("skips entries with eventType outside the EventClass union", () => {
    // OWN_GOAL maps to MatchEventType but NOT to EventClass — the
    // correlator only handles classes it can correlate against
    // commentary claims, and OWN_GOAL isn't one of them.
    const result = buildCanonicalLedgerSeed(
      [
        entry({ eventType: "OWN_GOAL", sourceId: 1, minute: 12 }),
        entry({ eventType: "PRESSURE_UPDATE", sourceId: 2, minute: 13 }),
        entry({ eventType: "GOAL", sourceId: 3, minute: 14 }),
      ],
      BROADCAST_ID,
    );
    assert.equal(result.length, 1);
    assert.equal(result[0].eventClass, "GOAL");
  });

  it("skips entries whose `data` is null or undefined", () => {
    const result = buildCanonicalLedgerSeed(
      [
        { id: "broken1", source: "match_events", timestamp: Date.now() },
        { id: "broken2", source: "match_events", timestamp: Date.now(), data: null },
        entry({ eventType: "GOAL", sourceId: 1, minute: 12 }),
      ],
      BROADCAST_ID,
    );
    assert.equal(result.length, 1);
  });

  it("preserves chronological order of the input — addedAt mirrors realWallClockMs", () => {
    const earliest = 1_777_724_400_000;
    const middle = 1_777_724_500_000;
    const latest = 1_777_724_600_000;
    const result = buildCanonicalLedgerSeed(
      [
        entry({ eventType: "GOAL", sourceId: 1, minute: 5 }, { timestamp: earliest }),
        entry({ eventType: "YELLOW_CARD", sourceId: 2, minute: 23 }, { timestamp: middle }),
        entry({ eventType: "GOAL", sourceId: 3, minute: 67 }, { timestamp: latest }),
      ],
      BROADCAST_ID,
    );
    assert.equal(result[0].addedAt, earliest);
    assert.equal(result[1].addedAt, middle);
    assert.equal(result[2].addedAt, latest);
  });

  it("realistic full match arc: round-trips every event type from a typical broadcast's persisted entries", () => {
    // Mirrors what `kairos.listBroadcastEntries(id, source: 'match_events')`
    // returns mid-broadcast on a runner restart: synthetic phase
    // entries + the real Sportmonks events accumulated so far.
    const entries = [
      entry({ eventType: "KICKOFF", synthetic: true, subjectTime: "1" }, { timestamp: 1_000_000 }),
      entry({ eventType: "GOAL", sourceId: 100, minute: 12, player: "Haaland", teamName: "Manchester City", subjectTime: "12" }, { timestamp: 1_660_000 }),
      entry({ eventType: "YELLOW_CARD", sourceId: 101, minute: 23, player: "Burn", teamName: "Burnley", subjectTime: "23" }, { timestamp: 2_320_000 }),
      entry({ eventType: "SUBSTITUTION", sourceId: 102, minute: 35, player: "Foden", teamName: "Manchester City", subjectTime: "35" }, { timestamp: 3_040_000 }),
      entry({ eventType: "HALFTIME", synthetic: true, subjectTime: "45" }, { timestamp: 3_700_000 }),
      entry({ eventType: "SECOND_HALF_KICKOFF", synthetic: true, subjectTime: "46" }, { timestamp: 4_660_000 }),
      entry({ eventType: "RED_CARD", sourceId: 103, minute: 78, player: "Akanji", teamName: "Manchester City", subjectTime: "78" }, { timestamp: 6_580_000 }),
      entry({ eventType: "FULL_TIME", synthetic: true, subjectTime: "90" }, { timestamp: 7_300_000 }),
    ];
    const result = buildCanonicalLedgerSeed(entries, BROADCAST_ID);
    assert.equal(result.length, 8);
    const classes = result.map((c) => c.eventClass);
    assert.deepEqual(
      classes,
      ["KICKOFF", "GOAL", "YELLOW_CARD", "SUBSTITUTION", "HALFTIME", "SECOND_HALF_KICKOFF", "RED_CARD", "FULL_TIME"],
    );
    // Phase entries get the deterministic phase: id; real events keep their sourceId.
    assert.equal(result[0].eventId, "phase:kickoff:b-test");
    assert.equal(result[1].eventId, "100");
    assert.equal(result[7].eventId, "phase:full_time:b-test");
  });
});
