import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMatchTime, compareEventsByMatchTime } from "../types/match-time.js";

/**
 * Match-time helpers — single source of truth for both the server's
 * `buildBroadcastView` ordering and the matchroom client's event-ribbon
 * sort. The two MUST agree; tests pin the contract centrally.
 */

describe("parseMatchTime", () => {
  it("parses plain numerics to themselves", () => {
    assert.equal(parseMatchTime("3"), 3);
    assert.equal(parseMatchTime("47"), 47);
    assert.equal(parseMatchTime("90"), 90);
    assert.equal(parseMatchTime("0"), 0);
  });

  it("parses stoppage-time forms with a fractional bump (45+2 > 45, < 46)", () => {
    assert.ok(parseMatchTime("45+2") > 45);
    assert.ok(parseMatchTime("45+2") < 46);
    assert.ok(parseMatchTime("90+5") > 90);
    assert.ok(parseMatchTime("90+5") < 91);
  });

  it("places phase labels in the FSM ordering slot", () => {
    assert.equal(parseMatchTime("pre_match"), -1);
    assert.equal(parseMatchTime("HT"), 45.5);
    assert.equal(parseMatchTime("FT"), 9999);
  });

  it("returns -Infinity for missing / unparseable input", () => {
    assert.equal(parseMatchTime(undefined), -Infinity);
    assert.equal(parseMatchTime(null), -Infinity);
    assert.equal(parseMatchTime(""), -Infinity);
    assert.equal(parseMatchTime("nonsense"), -Infinity);
    assert.equal(parseMatchTime("90+"), -Infinity);
  });

  it("orders pre_match < numerics < HT < second-half numerics < FT", () => {
    const labels = ["FT", "47", "HT", "3", "pre_match", "45+2", "90+5"];
    const sorted = [...labels].sort((a, b) => parseMatchTime(a) - parseMatchTime(b));
    assert.deepEqual(sorted, ["pre_match", "3", "45+2", "HT", "47", "90+5", "FT"]);
  });
});

describe("compareEventsByMatchTime", () => {
  it("orders by parsed contentTime ascending", () => {
    const events = [
      { contentTime: "47", timestamp: 10 },
      { contentTime: "3", timestamp: 20 },
      { contentTime: "FT", timestamp: 30 },
      { contentTime: "HT", timestamp: 40 },
    ];
    const sorted = [...events].sort(compareEventsByMatchTime);
    assert.deepEqual(sorted.map((e) => e.contentTime), ["3", "HT", "47", "FT"]);
  });

  it("falls back to timestamp when contentTime is identical", () => {
    const events = [
      { contentTime: "12", timestamp: 200 },
      { contentTime: "12", timestamp: 100 },
    ];
    const sorted = [...events].sort(compareEventsByMatchTime);
    assert.deepEqual(sorted.map((e) => e.timestamp), [100, 200]);
  });

  it("missing contentTime sinks to -Infinity (before everything else)", () => {
    const events = [
      { contentTime: "12", timestamp: 1 },
      { timestamp: 2 },
      { contentTime: "FT", timestamp: 3 },
    ];
    const sorted = [...events].sort(compareEventsByMatchTime);
    assert.equal(sorted[0].timestamp, 2);
    assert.equal(sorted[1].timestamp, 1);
    assert.equal(sorted[2].timestamp, 3);
  });
});
