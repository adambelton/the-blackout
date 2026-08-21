import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { emptyCanonicalState } from "@blackout/shared";
import {
  composeContentMinute,
  composePassageBundle,
  composeRevealingCanonical,
  toCanonicalEvent,
} from "../src/conductor/canonical-compose.js";
import type { KairosFeedEntry } from "../src/lib/kairos.js";

/**
 * Pure composition unit tests for the matchroom canonical bundle.
 *
 * Pins the behaviour the conductor relies on at narrative compose
 * time: how Kairos entries project into CanonicalEvents, how covers
 * + batchEntryIds turn into revealing markers, and — load-bearing
 * for Sub-piece 2 — how phase-transition synthetics anchor a phase
 * marker at the cover's charOffset (the closing-cycle's whistle line).
 */

let entrySeq = 0;
function entry(
  source: string,
  data: Record<string, unknown>,
): KairosFeedEntry {
  entrySeq++;
  return {
    id: `e-${entrySeq}`,
    source,
    data,
    timestamp: String(Date.now() + entrySeq),
    created_at: new Date().toISOString(),
  };
}

function realGoal(args: {
  player?: string;
  side?: "home" | "away";
  subjectTime?: string;
  minute?: number;
}): KairosFeedEntry {
  return entry("match_events", {
    eventType: "GOAL",
    minute: args.minute ?? 12,
    extraMinute: 0,
    team: { side: args.side ?? "home", name: args.side === "away" ? "Liverpool" : "Manchester City" },
    player: args.player ?? "Haaland",
    subjectTime: args.subjectTime ?? String(args.minute ?? 12),
  });
}

function syntheticPhase(eventType: "KICKOFF" | "HALFTIME" | "SECOND_HALF_KICKOFF" | "FULL_TIME"): KairosFeedEntry {
  const subjectTime = eventType === "KICKOFF" ? "0" : eventType === "HALFTIME" ? "45" : eventType === "SECOND_HALF_KICKOFF" ? "46" : "90+3";
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

function cache(entries: KairosFeedEntry[]): Map<string, KairosFeedEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

describe("toCanonicalEvent", () => {
  it("projects a real match_events entry into a CanonicalEvent", () => {
    const e = realGoal({ player: "Haaland", side: "home", minute: 12 });
    const ce = toCanonicalEvent(e);
    assert.ok(ce);
    assert.equal(ce!.id, e.id);
    assert.equal(ce!.eventType, "GOAL");
    assert.equal(ce!.player, "Haaland");
    assert.equal(ce!.team, "home");
    assert.equal(ce!.teamName, "Manchester City");
    assert.equal(ce!.contentTime, "12");
    assert.equal(ce!.isGoal, true);
  });

  it("projects a synthetic phase entry (FULL_TIME) into a CanonicalEvent", () => {
    const e = syntheticPhase("FULL_TIME");
    const ce = toCanonicalEvent(e);
    assert.ok(ce);
    assert.equal(ce!.eventType, "FULL_TIME");
    assert.equal(ce!.isGoal, false);
  });

  it("returns null for non-match_events sources", () => {
    const e = entry("match_pressure", { eventType: "PRESSURE_UPDATE" });
    assert.equal(toCanonicalEvent(e), null);
  });

  it("returns null for matchroom-noise event types (pressure / zone signals)", () => {
    const types = ["PRESSURE_UPDATE", "ZONE_ENTRY", "ZONE_MIDDLE"];
    for (const t of types) {
      const e = entry("match_events", { eventType: t });
      assert.equal(toCanonicalEvent(e), null);
    }
  });

  it("returns null for entries missing eventType", () => {
    const e = entry("match_events", { team: "home" });
    assert.equal(toCanonicalEvent(e), null);
  });
});

describe("composeContentMinute", () => {
  it("returns the subjectTime string of the earliest batch entry", () => {
    const a = entry("match_events", { eventType: "GOAL", subjectTime: "47" });
    const b = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: "23" });
    const c = entry("match_events", { eventType: "SUBSTITUTION", subjectTime: "55" });
    const result = composeContentMinute([a.id, b.id, c.id], cache([a, b, c]));
    assert.equal(result, "23");
  });

  it("preserves stoppage-time form ('45+2')", () => {
    const e = entry("match_events", { eventType: "GOAL", subjectTime: "45+2" });
    assert.equal(composeContentMinute([e.id], cache([e])), "45+2");
  });

  it("returns null when no batch entry has a parseable subjectTime", () => {
    const e = entry("match_events", { eventType: "GOAL" });
    assert.equal(composeContentMinute([e.id], cache([e])), null);
  });

  it("returns null on empty batch", () => {
    assert.equal(composeContentMinute([], cache([])), null);
  });

  it("clamps to the monotonic floor when the batch's earliest is below it", () => {
    const a = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: "41" });
    const b = entry("match_events", { eventType: "GOAL", subjectTime: "44" });
    // Floor "43" — a late entry from minute 41 would otherwise pull
    // contentMinute back to 41. With the clamp, we hold at 43.
    assert.equal(composeContentMinute([a.id, b.id], cache([a, b]), "43"), "43");
  });

  it("returns the batch's earliest when above the monotonic floor", () => {
    const a = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: "44" });
    const b = entry("match_events", { eventType: "GOAL", subjectTime: "47" });
    assert.equal(composeContentMinute([a.id, b.id], cache([a, b]), "43"), "44");
  });

  it("treats stoppage-time form correctly against the floor ('45' < '45+2')", () => {
    const a = entry("match_events", { eventType: "GOAL", subjectTime: "45" });
    // FT canonical's subjectTime is the literal "90" (no stoppage suffix)
    // — same shape as 45 vs 45+2: "45" parses below "45+2", so a floor
    // of "45+2" should pin against a batch entry of "45".
    assert.equal(composeContentMinute([a.id], cache([a]), "45+2"), "45+2");
  });

  it("ignores an unparseable floor ('pre_match') and passes the raw earliest through", () => {
    const a = entry("match_events", { eventType: "KICKOFF", subjectTime: "1" });
    assert.equal(composeContentMinute([a.id], cache([a]), "pre_match"), "1");
  });

  it("returns null when batch is empty regardless of the floor", () => {
    assert.equal(composeContentMinute([], cache([]), "44"), null);
  });
});

describe("composeRevealingCanonical — events", () => {
  it("emits markers for every cover + every uncovered batch entry", () => {
    const a = realGoal({ minute: 12 });
    const b = entry("match_events", { eventType: "YELLOW_CARD", minute: 23, subjectTime: "23" });
    const c = entry("match_events", { eventType: "SUBSTITUTION", minute: 55, subjectTime: "55" });
    const result = composeRevealingCanonical({
      covers: [{ entryId: a.id, charOffset: 50 }, { entryId: b.id, charOffset: 100 }],
      batchEntryIds: [a.id, b.id, c.id],
      entryCache: cache([a, b, c]),
    });
    assert.ok(result.events);
    assert.equal(result.events!.length, 3);
    // Covers come first with their charOffsets.
    assert.equal(result.events![0].value.id, a.id);
    assert.equal(result.events![0].charOffset, 50);
    assert.equal(result.events![1].value.id, b.id);
    assert.equal(result.events![1].charOffset, 100);
    // Uncovered batch entry — no charOffset (audio-end fallback).
    assert.equal(result.events![2].value.id, c.id);
    assert.equal(result.events![2].charOffset, undefined);
  });

  it("does not duplicate when a cover entryId also appears in batchEntryIds", () => {
    const a = realGoal({ minute: 12 });
    const result = composeRevealingCanonical({
      covers: [{ entryId: a.id, charOffset: 50 }],
      batchEntryIds: [a.id],
      entryCache: cache([a]),
    });
    assert.equal(result.events!.length, 1);
  });

  it("drops cover entries that aren't in the cache (defensive — silent skip)", () => {
    const result = composeRevealingCanonical({
      covers: [{ entryId: "missing", charOffset: 10 }],
      batchEntryIds: ["missing"],
      entryCache: cache([]),
    });
    assert.equal(result.events, undefined);
  });

  it("drops noise-type entries (pressure / zone) even if cited", () => {
    const noise = entry("match_events", { eventType: "PRESSURE_UPDATE" });
    const goal = realGoal({ minute: 12 });
    const result = composeRevealingCanonical({
      covers: [{ entryId: noise.id, charOffset: 10 }, { entryId: goal.id, charOffset: 50 }],
      batchEntryIds: [noise.id, goal.id],
      entryCache: cache([noise, goal]),
    });
    assert.equal(result.events!.length, 1);
    assert.equal(result.events![0].value.id, goal.id);
  });

  it("returns an empty object when nothing reveals (no events at all)", () => {
    const result = composeRevealingCanonical({
      covers: [],
      batchEntryIds: [],
      entryCache: cache([]),
    });
    assert.deepEqual(result, {});
  });
});

describe("composePassageBundle — phase reveal (Sub-piece 2)", () => {
  it("anchors the phase marker at the closing-cycle's FULL_TIME cover charOffset", () => {
    // The closing-cycle case the cluster targets: prose lands on the
    // whistle. revealedCanonical.phase stays at live_second_half (the
    // listener is mid-second-half until they HEAR the whistle);
    // revealingCanonical.phase carries full_time_winddown anchored at
    // the cover's charOffset.
    const goal = realGoal({ minute: 88, side: "home", player: "Doku" });
    const fullTime = syntheticPhase("FULL_TIME");
    const cacheMap = cache([goal, fullTime]);

    const running = emptyCanonicalState("live_second_half");
    const { revealedCanonical, revealingCanonical } = composePassageBundle({
      runningCanonical: running,
      phase: "full_time_winddown",
      covers: [
        { entryId: goal.id, charOffset: 80 },
        { entryId: fullTime.id, charOffset: 312 },
      ],
      batchEntryIds: [goal.id, fullTime.id],
      entryCache: cacheMap,
    });

    assert.equal(revealedCanonical.phase, "live_second_half");
    assert.ok(revealingCanonical.phase);
    assert.equal(revealingCanonical.phase!.value, "full_time_winddown");
    assert.equal(revealingCanonical.phase!.charOffset, 312);
  });

  it("falls back to audio-end (no charOffset) when the synthetic phase entry isn't cited in covers", () => {
    // Defensive: LLM doesn't anchor the FULL_TIME synthetic. Phase
    // still needs to advance — fallback marker has no charOffset, so
    // the matchroom reveals it on audio-end. Better than never.
    const fullTime = syntheticPhase("FULL_TIME");

    const { revealingCanonical } = composePassageBundle({
      runningCanonical: emptyCanonicalState("live_second_half"),
      phase: "full_time_winddown",
      covers: [],
      batchEntryIds: [fullTime.id],
      entryCache: cache([fullTime]),
    });

    assert.ok(revealingCanonical.phase);
    assert.equal(revealingCanonical.phase!.value, "full_time_winddown");
    assert.equal(revealingCanonical.phase!.charOffset, undefined);
  });

  it("emits no phase marker when running.phase already matches the FSM phase", () => {
    // Steady-state mid-half. Phase isn't transitioning, so no marker.
    const goal = realGoal({ minute: 47 });
    const { revealingCanonical } = composePassageBundle({
      runningCanonical: emptyCanonicalState("live_second_half"),
      phase: "live_second_half",
      covers: [{ entryId: goal.id, charOffset: 100 }],
      batchEntryIds: [goal.id],
      entryCache: cache([goal]),
    });
    assert.equal(revealingCanonical.phase, undefined);
  });

  it("revealedCanonical.phase sources from runningCanonical.phase, not the FSM phase", () => {
    // Critical contract: the revealedCanonical phase is the listener's
    // CURRENT view, not the FSM's view. Without this, phase would flip
    // before the audio reaches the whistle marker.
    const fullTime = syntheticPhase("FULL_TIME");
    const { revealedCanonical } = composePassageBundle({
      runningCanonical: emptyCanonicalState("live_second_half"),
      phase: "full_time_winddown",
      covers: [{ entryId: fullTime.id, charOffset: 312 }],
      batchEntryIds: [fullTime.id],
      entryCache: cache([fullTime]),
    });
    assert.equal(revealedCanonical.phase, "live_second_half");
  });

  it("contentMinute on revealedCanonical comes from the earliest batch entry's subjectTime", () => {
    const a = entry("match_events", { eventType: "GOAL", subjectTime: "47", team: "home" });
    const b = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: "23", team: "away" });
    const { revealedCanonical } = composePassageBundle({
      runningCanonical: emptyCanonicalState("live_first_half"),
      phase: "live_first_half",
      covers: [],
      batchEntryIds: [a.id, b.id],
      entryCache: cache([a, b]),
    });
    assert.equal(revealedCanonical.contentMinute, "23");
  });
});
