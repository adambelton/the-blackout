import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyRevealingCanonical,
  emptyCanonicalState,
  type CanonicalEvent,
  type CanonicalState,
  type RevealingCanonical,
} from "../types/canonical-state.js";

/**
 * Pure state composition for the matchroom reveal architecture
 * (Design A — `docs/matchroom-reveal-architecture-scoping.md`).
 *
 * These tests pin the chain invariant the contract relies on:
 *
 *   passage[N+1].revealedCanonical
 *     === applyRevealingCanonical(
 *           passage[N].revealedCanonical,
 *           passage[N].revealingCanonical,
 *         )
 *
 * Both the conductor (at compose time) and the matchroom client
 * (during marker walks) call these functions. The chain must be
 * deterministic and order-stable across both consumers.
 */

function event(partial: Partial<CanonicalEvent> & { id: string }): CanonicalEvent {
  return {
    id: partial.id,
    eventType: partial.eventType ?? "GOAL",
    player: partial.player ?? null,
    relatedPlayer: partial.relatedPlayer ?? null,
    team: partial.team ?? null,
    teamName: partial.teamName ?? null,
    contentTime: partial.contentTime,
    minute: partial.minute ?? null,
    extraMinute: partial.extraMinute ?? null,
    isGoal: partial.isGoal ?? partial.eventType === "GOAL",
  };
}

describe("emptyCanonicalState", () => {
  it("defaults to pre_ramp with zero score, no events, no illustration, null lineup", () => {
    const state = emptyCanonicalState();
    assert.deepEqual(state, {
      score: { home: 0, away: 0 },
      phase: "pre_ramp",
      contentMinute: null,
      events: [],
      illustration: null,
      lineup: null,
    });
  });

  it("accepts an explicit phase override (for restart/recovery scenarios)", () => {
    const state = emptyCanonicalState("warming");
    assert.equal(state.phase, "warming");
  });
});

describe("applyRevealingCanonical — events", () => {
  it("returns the same state when revealing is empty", () => {
    const state = emptyCanonicalState("live_first_half");
    const next = applyRevealingCanonical(state, {});
    assert.deepEqual(next, state);
  });

  it("adds revealed events to the events list", () => {
    const state = emptyCanonicalState("live_first_half");
    const goal = event({
      id: "g1",
      eventType: "GOAL",
      team: "home",
      isGoal: true,
      contentTime: "12",
    });
    const next = applyRevealingCanonical(state, {
      events: [{ value: goal, charOffset: 100 }],
    });
    assert.equal(next.events.length, 1);
    assert.equal(next.events[0].id, "g1");
    assert.deepEqual(next.score, { home: 1, away: 0 });
  });

  it("projects score from goal events as they reveal — home + away both tracked", () => {
    const state = emptyCanonicalState("live_first_half");
    const reveals: RevealingCanonical = {
      events: [
        { value: event({ id: "g1", team: "home", isGoal: true, contentTime: "12" }), charOffset: 50 },
        { value: event({ id: "y1", eventType: "YELLOW_CARD", team: "away", isGoal: false, contentTime: "23" }), charOffset: 100 },
        { value: event({ id: "g2", team: "away", isGoal: true, contentTime: "31" }), charOffset: 200 },
        { value: event({ id: "g3", team: "home", isGoal: true, contentTime: "44" }), charOffset: 300 },
      ],
    };
    const next = applyRevealingCanonical(state, reveals);
    assert.deepEqual(next.score, { home: 2, away: 1 });
    assert.equal(next.events.length, 4);
  });

  it("ignores `isGoal: true` with no team (defensive — score unaffected)", () => {
    const state = emptyCanonicalState("live_first_half");
    const next = applyRevealingCanonical(state, {
      events: [
        { value: event({ id: "g1", team: null, isGoal: true, contentTime: "12" }) },
      ],
    });
    assert.deepEqual(next.score, { home: 0, away: 0 });
    assert.equal(next.events.length, 1);
  });

  it("ignores `isGoal: false` even when eventType is GOAL (e.g. VAR-disallowed)", () => {
    const state = emptyCanonicalState("live_first_half");
    const next = applyRevealingCanonical(state, {
      events: [
        { value: event({ id: "g1", eventType: "GOAL", team: "home", isGoal: false, contentTime: "12" }) },
      ],
    });
    assert.deepEqual(next.score, { home: 0, away: 0 });
  });

  it("dedupes by id — re-folding the same event is a no-op (defensive against repeated folds)", () => {
    const state = emptyCanonicalState("live_first_half");
    const goal = event({ id: "g1", team: "home", isGoal: true, contentTime: "12" });
    const after1 = applyRevealingCanonical(state, { events: [{ value: goal, charOffset: 100 }] });
    const after2 = applyRevealingCanonical(after1, { events: [{ value: goal, charOffset: 100 }] });
    assert.deepEqual(after1, after2);
  });

  it("sorts events by parsed contentTime ascending — out-of-order arrivals settle correctly", () => {
    const state = emptyCanonicalState("live_first_half");
    // Events arriving in non-chronological order (e.g. late Sportmonks
    // refresh delivers a 12' event after a 47' one).
    const next = applyRevealingCanonical(state, {
      events: [
        { value: event({ id: "late", contentTime: "47" }) },
        { value: event({ id: "early", contentTime: "12" }) },
        { value: event({ id: "stoppage", contentTime: "45+2" }) },
      ],
    });
    assert.deepEqual(
      next.events.map((e) => e.id),
      ["early", "stoppage", "late"],
    );
  });

  it("preserves prior events when a new revealing layers on top", () => {
    const state = emptyCanonicalState("live_first_half");
    const after1 = applyRevealingCanonical(state, {
      events: [{ value: event({ id: "early", team: "home", isGoal: true, contentTime: "12" }) }],
    });
    const after2 = applyRevealingCanonical(after1, {
      events: [{ value: event({ id: "later", team: "away", isGoal: true, contentTime: "47" }) }],
    });
    assert.deepEqual(
      after2.events.map((e) => e.id),
      ["early", "later"],
    );
    assert.deepEqual(after2.score, { home: 1, away: 1 });
  });

  it("does not mutate the input state — pure function contract", () => {
    const state = emptyCanonicalState("live_first_half");
    const stateClone = JSON.parse(JSON.stringify(state));
    applyRevealingCanonical(state, {
      events: [{ value: event({ id: "g1", team: "home", isGoal: true, contentTime: "12" }) }],
    });
    assert.deepEqual(state, stateClone);
  });
});

describe("applyRevealingCanonical — phase", () => {
  it("replaces phase when a phase marker is present", () => {
    const state = emptyCanonicalState("live_second_half");
    const next = applyRevealingCanonical(state, {
      phase: { value: "full_time_winddown", charOffset: 200 },
    });
    assert.equal(next.phase, "full_time_winddown");
  });

  it("leaves phase untouched when no phase marker is present", () => {
    const state = emptyCanonicalState("live_second_half");
    const next = applyRevealingCanonical(state, {
      events: [{ value: event({ id: "g1", team: "home", isGoal: true, contentTime: "67" }) }],
    });
    assert.equal(next.phase, "live_second_half");
  });
});

describe("applyRevealingCanonical — chain invariant", () => {
  it("two passages folded sequentially equal one passage with the union of reveals", () => {
    // Critical test: the chain invariant relied on by both server
    // (running state advance) and client (visible state walk).
    const start = emptyCanonicalState("live_first_half");
    const passage1Reveal: RevealingCanonical = {
      events: [
        { value: event({ id: "g1", team: "home", isGoal: true, contentTime: "12" }), charOffset: 50 },
      ],
    };
    const passage2Reveal: RevealingCanonical = {
      events: [
        { value: event({ id: "y1", eventType: "YELLOW_CARD", team: "away", isGoal: false, contentTime: "23" }) },
        { value: event({ id: "g2", team: "away", isGoal: true, contentTime: "31" }), charOffset: 100 },
      ],
    };

    const sequential = applyRevealingCanonical(
      applyRevealingCanonical(start, passage1Reveal),
      passage2Reveal,
    );
    const union = applyRevealingCanonical(start, {
      events: [
        ...(passage1Reveal.events ?? []),
        ...(passage2Reveal.events ?? []),
      ],
    });

    assert.deepEqual(sequential.events, union.events);
    assert.deepEqual(sequential.score, union.score);
  });

  it("a phase reveal in passage N is reflected in passage N+1's revealedCanonical", () => {
    // Sub-piece 2 lifts the closing-cycle's whistle into a phase
    // marker on revealingCanonical. After that passage folds forward,
    // the next passage starts in the new phase.
    const start = emptyCanonicalState("live_second_half");
    const closingCycle: RevealingCanonical = {
      phase: { value: "full_time_winddown", charOffset: 312 },
      events: [
        {
          value: event({ id: "ft", eventType: "FULL_TIME", contentTime: "90+3" }),
          charOffset: 312,
        },
      ],
    };
    const nextRevealedCanonical = applyRevealingCanonical(start, closingCycle);
    assert.equal(nextRevealedCanonical.phase, "full_time_winddown");
    assert.equal(nextRevealedCanonical.events.length, 1);
    assert.equal(nextRevealedCanonical.events[0].eventType, "FULL_TIME");
  });

  it("running canonical state recovers identically across an event-set replay", () => {
    // Conductor restart: rebuild running state by folding every
    // passage's revealing in order. Result must equal the state we
    // had before the restart.
    const start = emptyCanonicalState("warming");
    const reveals: RevealingCanonical[] = [
      { events: [{ value: event({ id: "ko", eventType: "KICKOFF", contentTime: "0" }) }] },
      { events: [{ value: event({ id: "g1", team: "home", isGoal: true, contentTime: "12" }) }] },
      { events: [{ value: event({ id: "y1", eventType: "YELLOW_CARD", team: "away", contentTime: "23" }) }] },
      { events: [{ value: event({ id: "g2", team: "away", isGoal: true, contentTime: "31" }) }] },
      { phase: { value: "halftime", charOffset: 200 } },
    ];

    const recovered = reveals.reduce(applyRevealingCanonical, start);

    assert.deepEqual(recovered.score, { home: 1, away: 1 });
    assert.equal(recovered.phase, "halftime");
    assert.equal(recovered.events.length, 4);
  });
});
