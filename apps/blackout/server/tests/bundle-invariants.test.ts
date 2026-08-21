import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRevealingCanonical,
  emptyCanonicalState,
  parseMatchTime,
} from "@blackout/shared";
import type { CanonicalEvent, RevealingCanonical } from "@blackout/shared";
import { composePassageBundle } from "../src/conductor/canonical-compose.js";
import type { KairosFeedEntry } from "../src/lib/kairos.js";

/**
 * Cross-call invariants for the matchroom canonical bundle.
 *
 * Per-call shape tests live in `canonical-compose.test.ts`. The bugs
 * we hit on 2026-05-10 weren't shape bugs — they were *temporal* bugs
 * that only surfaced across multiple cycles:
 *   - contentMinute regressed on a late-arriving low-subjectTime entry
 *     (server-side composer was missing the monotonic clamp Kairos
 *     applies on its end).
 *   - score-never-decreases hadn't been pinned anywhere as an
 *     invariant; if applyRevealingCanonical regressed in the future
 *     we'd notice via a UI flicker, not a unit test.
 *
 * These tests pin the temporal contracts so the runtime can't drift.
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

function cache(entries: KairosFeedEntry[]): Map<string, KairosFeedEntry> {
  return new Map(entries.map((e) => [e.id, e]));
}

function goalEvent(args: {
  team: "home" | "away";
  subjectTime: string;
  minute: number;
}): CanonicalEvent {
  return {
    id: `goal-${args.team}-${args.minute}`,
    eventType: "GOAL",
    player: "Player",
    relatedPlayer: null,
    team: args.team,
    teamName: args.team === "home" ? "Home" : "Away",
    subjectTime: args.subjectTime,
    minute: args.minute,
    extraMinute: 0,
    isGoal: true,
  };
}

describe("composePassageBundle — cross-call contentMinute monotonicity", () => {
  it("a late-arriving low-subjectTime entry doesn't pull contentMinute below the prior bundle's", () => {
    // Cycle 1: the chunk's earliest is "44".
    const a = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: "44" });
    const first = composePassageBundle({
      runningCanonical: emptyCanonicalState("live_first_half"),
      phase: "live_first_half",
      covers: [],
      batchEntryIds: [a.id],
      entryCache: cache([a]),
      lastEmittedContentMinute: null,
    });
    assert.equal(first.revealedCanonical.contentMinute, "44");

    // Cycle 2: a late-arriving entry tagged "41" lands in the chunk.
    // Without the floor, this would set contentMinute to "41" — the exact
    // shape of the 2026-05-10 regressions in the broadcast_narrations
    // table (e.g. `42 → 41 → ...`).
    const b = entry("match_events", { eventType: "GOAL", subjectTime: "41" });
    const second = composePassageBundle({
      runningCanonical: first.revealedCanonical,
      phase: "live_first_half",
      covers: [],
      batchEntryIds: [b.id],
      entryCache: cache([b]),
      lastEmittedContentMinute: first.revealedCanonical.contentMinute,
    });
    assert.equal(second.revealedCanonical.contentMinute, "44");
  });

  it("a chunk that only contains forward-progressing entries advances contentMinute normally", () => {
    const a = entry("match_events", { eventType: "GOAL", subjectTime: "44" });
    const first = composePassageBundle({
      runningCanonical: emptyCanonicalState("live_first_half"),
      phase: "live_first_half",
      covers: [],
      batchEntryIds: [a.id],
      entryCache: cache([a]),
      lastEmittedContentMinute: null,
    });

    const b = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: "47" });
    const second = composePassageBundle({
      runningCanonical: first.revealedCanonical,
      phase: "live_first_half",
      covers: [],
      batchEntryIds: [b.id],
      entryCache: cache([b]),
      lastEmittedContentMinute: first.revealedCanonical.contentMinute,
    });
    assert.equal(second.revealedCanonical.contentMinute, "47");
  });

  it("stoppage suffix survives across calls and clamps correctly ('45+2' is the floor for '45')", () => {
    const a = entry("match_events", { eventType: "GOAL", subjectTime: "45+2" });
    const first = composePassageBundle({
      runningCanonical: emptyCanonicalState("live_first_half"),
      phase: "live_first_half",
      covers: [],
      batchEntryIds: [a.id],
      entryCache: cache([a]),
      lastEmittedContentMinute: null,
    });
    assert.equal(first.revealedCanonical.contentMinute, "45+2");

    // Same shape as the 2026-05-10 `45+2 → 45 → HT` regression: a "45"
    // entry sneaking in after the bundle has already advanced into
    // stoppage time should NOT pull the minute back to "45".
    const b = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: "45" });
    const second = composePassageBundle({
      runningCanonical: first.revealedCanonical,
      phase: "live_first_half",
      covers: [],
      batchEntryIds: [b.id],
      entryCache: cache([b]),
      lastEmittedContentMinute: first.revealedCanonical.contentMinute,
    });
    assert.equal(second.revealedCanonical.contentMinute, "45+2");
  });

  it("composes a long chronological run without ever returning a regressing contentMinute", () => {
    // Walk 12 cycles with a deliberate mix of in-order and late-arriving
    // entries. Track every contentMinute and assert each is >= the
    // previous (parseMatchTime ordering) — the load-bearing temporal
    // contract for the matchroom clock.
    const cycles: Array<{ ct: string }> = [
      { ct: "1" },
      { ct: "3" },
      { ct: "2" },     // late
      { ct: "5" },
      { ct: "4" },     // late
      { ct: "12" },
      { ct: "10" },    // late, gap-jumped
      { ct: "45+1" },
      { ct: "45+3" },
      { ct: "45" },    // post-whistle texture mistakenly stamped pre-whistle
      { ct: "46" },
      { ct: "47" },
    ];

    let runningCanonical = emptyCanonicalState("live_first_half");
    let lastEmittedContentMinute: string | null = null;
    let lastRank = -Infinity;

    for (const c of cycles) {
      const e = entry("match_events", { eventType: "YELLOW_CARD", subjectTime: c.ct });
      const bundle = composePassageBundle({
        runningCanonical,
        phase: "live_first_half",
        covers: [],
        batchEntryIds: [e.id],
        entryCache: cache([e]),
        lastEmittedContentMinute,
      });
      const mm = bundle.revealedCanonical.contentMinute;
      assert.ok(mm != null, `cycle ${c.ct}: contentMinute should not be null`);
      const rank = parseMatchTime(mm!);
      assert.ok(
        rank >= lastRank,
        `cycle ${c.ct}: contentMinute regressed (${mm} below floor of rank ${lastRank})`,
      );
      lastRank = rank;
      lastEmittedContentMinute = mm;
      runningCanonical = bundle.revealedCanonical;
    }
  });
});

describe("applyRevealingCanonical — temporal contracts", () => {
  it("score never decreases across reveals", () => {
    let state = emptyCanonicalState("live_first_half");

    const reveal1: RevealingCanonical = {
      events: [{ value: goalEvent({ team: "home", subjectTime: "12", minute: 12 }) }],
    };
    state = applyRevealingCanonical(state, reveal1);
    assert.equal(state.score.home, 1);
    assert.equal(state.score.away, 0);

    // A revealing with no event markers should leave the score untouched.
    const reveal2: RevealingCanonical = {};
    state = applyRevealingCanonical(state, reveal2);
    assert.equal(state.score.home, 1);
    assert.equal(state.score.away, 0);

    // Re-revealing the same event must not double-count (id-based dedup).
    state = applyRevealingCanonical(state, reveal1);
    assert.equal(state.score.home, 1);
  });

  it("existing events are preserved across reveals (event id dedup)", () => {
    const goal1 = goalEvent({ team: "home", subjectTime: "12", minute: 12 });
    const goal2 = goalEvent({ team: "away", subjectTime: "27", minute: 27 });

    let state = emptyCanonicalState("live_first_half");
    state = applyRevealingCanonical(state, { events: [{ value: goal1 }] });
    assert.equal(state.events.length, 1);

    state = applyRevealingCanonical(state, { events: [{ value: goal2 }] });
    assert.equal(state.events.length, 2);

    // Repeating goal1 should be a no-op (same id, already merged).
    state = applyRevealingCanonical(state, { events: [{ value: goal1 }] });
    assert.equal(state.events.length, 2);
    assert.equal(state.score.home, 1);
    assert.equal(state.score.away, 1);
  });

  it("phase only advances forward when a phase marker is set", () => {
    let state = emptyCanonicalState("live_first_half");
    assert.equal(state.phase, "live_first_half");

    state = applyRevealingCanonical(state, { phase: { value: "halftime" } });
    assert.equal(state.phase, "halftime");

    // No phase marker → phase carries forward unchanged.
    state = applyRevealingCanonical(state, {});
    assert.equal(state.phase, "halftime");

    state = applyRevealingCanonical(state, { phase: { value: "live_second_half" } });
    assert.equal(state.phase, "live_second_half");
  });
});
