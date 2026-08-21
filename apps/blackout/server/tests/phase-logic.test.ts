import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DATA_PHASE_TO_BROADCAST_PHASE,
  MIN_MATCH_AGE_MINUTES_FOR_COMPLETE,
  POST_WHISTLE_TEXTURE_WINDOW_SECONDS,
  TRANSITION_FOR_PHASE,
  decideClipEndAction,
  decideSourcePushAllowed,
  nextPhaseFromEntryPhase,
  shouldSuppressWinddownComplete,
} from "../src/conductor/phase-logic.js";

describe("nextPhaseFromEntryPhase — data.phase observer decision", () => {
  // The conductor observes feed entries during replay (and as a
  // backstop in live) to detect phase transitions without relying on
  // the Sportmonks callback path. Monotonic: never transitions
  // backwards. Entries with unknown or stale phases are ignored.

  it("returns null when the entry has no phase field", () => {
    assert.equal(nextPhaseFromEntryPhase(undefined, "warming"), null);
    assert.equal(nextPhaseFromEntryPhase(null, "warming"), null);
    assert.equal(nextPhaseFromEntryPhase(42, "warming"), null);
  });

  it("returns null for unknown phase strings (pre_match, extra_time, etc.)", () => {
    assert.equal(nextPhaseFromEntryPhase("pre_match", "warming"), null);
    assert.equal(nextPhaseFromEntryPhase("extra_time", "live_second_half"), null);
    assert.equal(nextPhaseFromEntryPhase("penalty_shootout", "live_second_half"), null);
  });

  it("transitions warming → live_first_half on first_half entry", () => {
    assert.equal(nextPhaseFromEntryPhase("first_half", "warming"), "live_first_half");
  });

  it("transitions live_first_half → halftime on halftime entry", () => {
    assert.equal(nextPhaseFromEntryPhase("halftime", "live_first_half"), "halftime");
  });

  it("transitions halftime → live_second_half on second_half entry", () => {
    assert.equal(nextPhaseFromEntryPhase("second_half", "halftime"), "live_second_half");
  });

  it("transitions live_second_half → full_time_winddown on full_time entry", () => {
    assert.equal(
      nextPhaseFromEntryPhase("full_time", "live_second_half"),
      "full_time_winddown",
    );
  });

  it("refuses to go backwards — first_half entry during second_half stays", () => {
    // A late-arriving stale entry from the first half should not
    // drag the broadcast back.
    assert.equal(nextPhaseFromEntryPhase("first_half", "live_second_half"), null);
  });

  it("refuses to re-transition to the same phase (idempotent)", () => {
    assert.equal(nextPhaseFromEntryPhase("first_half", "live_first_half"), null);
  });

  it("can skip a phase when evidence jumps ahead (first_half → full_time)", () => {
    // Rare but legal: a long pause in coverage, then a full-time
    // entry lands. The observer doesn't refuse skipping phases;
    // it refuses going backwards.
    assert.equal(
      nextPhaseFromEntryPhase("full_time", "live_first_half"),
      "full_time_winddown",
    );
  });
});

describe("shouldSuppressWinddownComplete — match-age guard", () => {
  // Guards against transient phase glitches ending a live broadcast
  // prematurely. Seen during 2026-04-22 Burnley-City mid-match
  // restart cascade: both broadcasts flipped to `complete` about
  // 20 minutes into the match from what looked like a Sportmonks
  // state blip routing through onFulltime → winddown → clip-end.

  const HOUR_MS = 60 * 60 * 1000;

  it("suppresses completion for a broadcast < 60 minutes old", () => {
    const matchStart = 0;
    const now = 10 * 60 * 1000; // 10 minutes in
    assert.equal(shouldSuppressWinddownComplete(matchStart, now), true);
  });

  it("suppresses at exactly 59 minutes 59 seconds", () => {
    const matchStart = 0;
    const now = 59 * 60 * 1000 + 59_000;
    assert.equal(shouldSuppressWinddownComplete(matchStart, now), true);
  });

  it("allows completion at exactly 60 minutes (boundary)", () => {
    const matchStart = 0;
    const now = 60 * 60 * 1000;
    assert.equal(shouldSuppressWinddownComplete(matchStart, now), false);
  });

  it("allows completion for a 90-minute match at full-time", () => {
    const matchStart = 0;
    const now = 95 * 60 * 1000;
    assert.equal(shouldSuppressWinddownComplete(matchStart, now), false);
  });

  it("handles negative elapsed time (pre-match or clock skew) as suppressed", () => {
    const matchStart = HOUR_MS;
    const now = 0;
    assert.equal(shouldSuppressWinddownComplete(matchStart, now), true);
  });

  it("threshold matches the exported constant", () => {
    assert.equal(MIN_MATCH_AGE_MINUTES_FOR_COMPLETE, 60);
  });
});

describe("TRANSITION_FOR_PHASE — gameplay-transition entries", () => {
  // These synthetic entries are pushed to Kairos on phase transitions
  // so the narrator sees them as priority state-changing events
  // (same category as goals). The shape is stable.

  it("emits a KICKOFF transition for live_first_half", () => {
    const t = TRANSITION_FOR_PHASE.live_first_half;
    assert.ok(t);
    assert.equal(t?.eventType, "KICKOFF");
    assert.equal(t?.subjectTime, "1");
    assert.equal(t?.phase, "first_half");
  });

  it("emits a HALFTIME transition for halftime", () => {
    const t = TRANSITION_FOR_PHASE.halftime;
    assert.ok(t);
    assert.equal(t?.eventType, "HALFTIME");
    assert.equal(t?.subjectTime, "45");
  });

  it("emits a SECOND_HALF_KICKOFF transition for live_second_half", () => {
    const t = TRANSITION_FOR_PHASE.live_second_half;
    assert.ok(t);
    assert.equal(t?.eventType, "SECOND_HALF_KICKOFF");
    assert.equal(t?.subjectTime, "46");
  });

  it("emits a FULL_TIME transition for full_time_winddown", () => {
    const t = TRANSITION_FOR_PHASE.full_time_winddown;
    assert.ok(t);
    assert.equal(t?.eventType, "FULL_TIME");
    assert.equal(t?.subjectTime, "90");
  });

  it("does not emit a transition for operational phases (pre_ramp, warming, complete)", () => {
    // These are broadcast lifecycle, not gameplay transitions —
    // they shouldn't produce a match-ribbon event.
    assert.equal(TRANSITION_FOR_PHASE.pre_ramp, undefined);
    assert.equal(TRANSITION_FOR_PHASE.warming, undefined);
    assert.equal(TRANSITION_FOR_PHASE.complete, undefined);
  });
});

describe("decideClipEndAction — what to do after a clip finishes", () => {
  // The integration that the 2026-04-22 Burnley-City retro flagged:
  // when does the conductor auto-complete the broadcast on a clip-end
  // event? Pure decider so the conductor side can just apply the
  // outcome without re-checking conditions.

  const HOUR_MS = 60 * 60 * 1000;
  const matchStart = 1_700_000_000_000; // arbitrary epoch ms
  // For tests that don't exercise the closing-deadline guard.
  const noDeadline = { closingDeadlineMs: null, inFlightWork: false };

  it("advances the queue when there are still clips to play, even in winddown", () => {
    // The closing passage hasn't finished its run yet — letting it
    // play through is more important than the auto-complete trigger.
    const action = decideClipEndAction({
      phase: "full_time_winddown",
      readyQueueEmpty: false,
      matchStartMs: matchStart,
      nowMs: matchStart + 2 * HOUR_MS,
      ...noDeadline,
    });
    assert.deepEqual(action, { type: "advance_queue" });
  });

  it("advances the queue in any non-winddown phase, queue empty or not", () => {
    for (const phase of ["warming", "live_first_half", "halftime", "live_second_half", "complete"] as const) {
      const action = decideClipEndAction({
        phase,
        readyQueueEmpty: true,
        matchStartMs: matchStart,
        nowMs: matchStart + 2 * HOUR_MS,
        ...noDeadline,
      });
      assert.deepEqual(action, { type: "advance_queue" }, `phase=${phase}`);
    }
  });

  it("completes the broadcast in winddown with empty queue and a sane match age (no deadline guard)", () => {
    // Without the closing-deadline mechanism (legacy / replay path),
    // auto-complete fires immediately on the empty queue + sane match
    // age. New code paths supply a deadline.
    const action = decideClipEndAction({
      phase: "full_time_winddown",
      readyQueueEmpty: true,
      matchStartMs: matchStart,
      nowMs: matchStart + 95 * 60_000,
      ...noDeadline,
    });
    assert.deepEqual(action, { type: "complete_broadcast" });
  });

  it("suppresses auto-complete when the match is too young for full-time", () => {
    // The Burnley-City regression: phase glitched to winddown about
    // 20 minutes into the match. The guard should reject completion
    // and surface the elapsed minutes for telemetry.
    const action = decideClipEndAction({
      phase: "full_time_winddown",
      readyQueueEmpty: true,
      matchStartMs: matchStart,
      nowMs: matchStart + 20 * 60_000,
      ...noDeadline,
    });
    assert.equal(action.type, "suppress_winddown_complete");
    if (action.type === "suppress_winddown_complete") {
      assert.equal(action.elapsedMinutes, 20);
    }
  });

  it("crosses the 60-minute boundary cleanly — at exactly 60min, completes", () => {
    const action = decideClipEndAction({
      phase: "full_time_winddown",
      readyQueueEmpty: true,
      matchStartMs: matchStart,
      nowMs: matchStart + 60 * 60_000,
      ...noDeadline,
    });
    assert.equal(action.type, "complete_broadcast");
  });

  it("at 59 minutes 59 seconds, suppresses (matches shouldSuppressWinddownComplete)", () => {
    const action = decideClipEndAction({
      phase: "full_time_winddown",
      readyQueueEmpty: true,
      matchStartMs: matchStart,
      nowMs: matchStart + 59 * 60_000 + 59_000,
      ...noDeadline,
    });
    assert.equal(action.type, "suppress_winddown_complete");
  });

  describe("closing-passage deadline guard — Finding 7 protection", () => {
    // The 2026-05-03 live test surfaced the bug: at FT, the conductor
    // auto-completed the broadcast 38s in, well before the closing-
    // passage roundtrip (75s phase-flush + ~150s gen+synth+audio +
    // ~150s reflection cycle gen+synth+audio) had a chance to land.
    // The fix: hold auto-complete via `wait_for_closing_passage` until
    // the deadline AND idle state.
    //
    // FT observed at matchStart+90min. Deadline = FT + 300s.
    const ftObserved = matchStart + 90 * 60_000;
    const deadline = ftObserved + 300_000;

    it("waits when before deadline (the closing roundtrip hasn't completed yet)", () => {
      const action = decideClipEndAction({
        phase: "full_time_winddown",
        readyQueueEmpty: true,
        matchStartMs: matchStart,
        nowMs: ftObserved + 60_000, // 1 min after FT — closing still mid-roundtrip
        closingDeadlineMs: deadline,
        inFlightWork: false,
      });
      assert.equal(action.type, "wait_for_closing_passage");
      if (action.type === "wait_for_closing_passage") {
        assert.equal(action.deadlineMs, deadline);
      }
    });

    it("waits when in-flight work is queued, even past the deadline", () => {
      // A narrative is sitting in the synthesis queue — auto-complete
      // would cut off a clip about to start. Hold for the next
      // clip-end to re-evaluate.
      const action = decideClipEndAction({
        phase: "full_time_winddown",
        readyQueueEmpty: true,
        matchStartMs: matchStart,
        nowMs: ftObserved + 320_000, // past the deadline
        closingDeadlineMs: deadline,
        inFlightWork: true,
      });
      assert.equal(action.type, "wait_for_closing_passage");
    });

    it("completes when past the deadline with no in-flight work", () => {
      const action = decideClipEndAction({
        phase: "full_time_winddown",
        readyQueueEmpty: true,
        matchStartMs: matchStart,
        nowMs: ftObserved + 320_000,
        closingDeadlineMs: deadline,
        inFlightWork: false,
      });
      assert.equal(action.type, "complete_broadcast");
    });

    it("waits at the exact deadline boundary if any in-flight work is present", () => {
      // Edge case: the deadline timer fires at the same instant a
      // synthesis is wrapping up. Don't race — wait for the next
      // clip-end.
      const action = decideClipEndAction({
        phase: "full_time_winddown",
        readyQueueEmpty: true,
        matchStartMs: matchStart,
        nowMs: deadline,
        closingDeadlineMs: deadline,
        inFlightWork: true,
      });
      assert.equal(action.type, "wait_for_closing_passage");
    });

    it("completes at the exact deadline boundary when idle", () => {
      const action = decideClipEndAction({
        phase: "full_time_winddown",
        readyQueueEmpty: true,
        matchStartMs: matchStart,
        nowMs: deadline,
        closingDeadlineMs: deadline,
        inFlightWork: false,
      });
      assert.equal(action.type, "complete_broadcast");
    });

    it("the deadline guard takes priority over the match-age guard for closing-cycle scenarios", () => {
      // Both guards apply in winddown + empty queue. The match-age
      // guard fires first (suppresses if match is too young), so a
      // young match would suppress regardless of the deadline. The
      // deadline guard is reached only when match age is sane.
      const action = decideClipEndAction({
        phase: "full_time_winddown",
        readyQueueEmpty: true,
        matchStartMs: matchStart,
        nowMs: matchStart + 20 * 60_000, // young match — match-age guard fires
        closingDeadlineMs: matchStart + 20 * 60_000 - 1, // already past deadline
        inFlightWork: false,
      });
      assert.equal(action.type, "suppress_winddown_complete");
    });
  });
});

describe("decideSourcePushAllowed — content-time gate on entries pushed to Kairos", () => {
  // Content-time-driven gate. The conductor's own phase doesn't enter
  // the decision — only the entry's stamped `data.phase` /
  // `data.phaseSecond`. Pairs with the closing-boundary mechanism:
  // post-whistle texture inside the 15s extension flows; past 15s,
  // the gate closes so post-match noise (ads, studio chatter, etc.)
  // doesn't keep generating cycles.

  describe("ambient seed sources — always allowed", () => {
    it("narrative_voice with no data passes", () => {
      assert.equal(decideSourcePushAllowed("narrative_voice"), true);
    });

    it("narrative_context with no data passes", () => {
      assert.equal(decideSourcePushAllowed("narrative_context"), true);
    });

    it("ambient sources pass even with weird/missing phase data", () => {
      assert.equal(decideSourcePushAllowed("narrative_voice", {}), true);
      assert.equal(decideSourcePushAllowed("narrative_context", { phase: "halftime", phaseSecond: 600 }), true);
    });
  });

  describe("live content phases — full open for any source", () => {
    for (const phase of [
      "first_half",
      "live_first_half",
      "second_half",
      "live_second_half",
      "extra_time_first",
      "extra_time_second",
    ]) {
      for (const source of ["match_events", "match_action", "match_pressure", "match_stats", "moderator"]) {
        it(`${source} with phase=${phase} passes`, () => {
          assert.equal(decideSourcePushAllowed(source, { phase, phaseSecond: 600 }), true);
        });
      }
    }
  });

  describe("post-whistle texture window — first 15s of HT / FT / extra-time-halftime", () => {
    for (const phase of ["halftime", "full_time", "extra_time_halftime"]) {
      it(`${phase}, phaseSecond=0 passes (the whistle moment itself)`, () => {
        assert.equal(decideSourcePushAllowed("match_action", { phase, phaseSecond: 0 }), true);
      });

      it(`${phase}, phaseSecond=15 passes (the boundary itself, inclusive)`, () => {
        assert.equal(decideSourcePushAllowed("match_action", { phase, phaseSecond: 15 }), true);
      });

      it(`${phase}, phaseSecond=16 fails (one second past the boundary)`, () => {
        assert.equal(decideSourcePushAllowed("match_action", { phase, phaseSecond: 16 }), false);
      });

      it(`${phase}, phaseSecond=600 fails (deep into the break)`, () => {
        assert.equal(decideSourcePushAllowed("match_action", { phase, phaseSecond: 600 }), false);
      });
    }

    it("the texture window applies to all gated sources, not just match_action", () => {
      // A late-arriving pre-whistle Sportmonks event might land with
      // phase=halftime, phaseSecond=0 if its content-time stamping
      // floors at the boundary. The gate lets it through so the
      // closing cycle includes it.
      assert.equal(decideSourcePushAllowed("match_events", { phase: "halftime", phaseSecond: 5 }), true);
      assert.equal(decideSourcePushAllowed("moderator", { phase: "halftime", phaseSecond: 10 }), true);
    });

    it("the window constant is 15", () => {
      assert.equal(POST_WHISTLE_TEXTURE_WINDOW_SECONDS, 15);
    });
  });

  describe("pre-match window — match_action only", () => {
    // Confirmed during 2026-04-22 Burnley-City: without pre-match
    // atmosphere flowing, a broadcast activated 5 min before kickoff
    // sits in dead air until Sportmonks detects kickoff. match_action
    // (distilled stadium ambience) bridges that gap.

    it("match_action with phase=pre_match passes", () => {
      assert.equal(decideSourcePushAllowed("match_action", { phase: "pre_match" }), true);
    });

    it("other sources blocked pre-kickoff so phantom events can't land", () => {
      assert.equal(decideSourcePushAllowed("match_events", { phase: "pre_match" }), false);
      assert.equal(decideSourcePushAllowed("match_pressure", { phase: "pre_match" }), false);
      assert.equal(decideSourcePushAllowed("match_stats", { phase: "pre_match" }), false);
      assert.equal(decideSourcePushAllowed("moderator", { phase: "pre_match" }), false);
    });
  });

  describe("everything else — closed", () => {
    it("penalties — closed (out of scope for the closing-cycle work)", () => {
      assert.equal(decideSourcePushAllowed("match_action", { phase: "penalties" }), false);
    });

    it("missing phase — closed", () => {
      assert.equal(decideSourcePushAllowed("match_action", {}), false);
      assert.equal(decideSourcePushAllowed("match_action"), false);
    });

    it("non-string phase — closed", () => {
      assert.equal(decideSourcePushAllowed("match_action", { phase: 42 }), false);
    });

    it("unknown phase — closed", () => {
      assert.equal(decideSourcePushAllowed("match_action", { phase: "warmup" }), false);
    });
  });
});

describe("DATA_PHASE_TO_BROADCAST_PHASE — entry-phase mapping", () => {
  // Worth pinning as a fixture because changes to this map ripple
  // through replay behaviour and live fallback paths.

  it("covers the four gameplay phases", () => {
    assert.deepEqual(Object.keys(DATA_PHASE_TO_BROADCAST_PHASE).sort(), [
      "first_half",
      "full_time",
      "halftime",
      "second_half",
    ]);
  });

  it("pre_match is intentionally absent (warming is the initial phase, not entry-driven)", () => {
    assert.equal(DATA_PHASE_TO_BROADCAST_PHASE.pre_match, undefined);
  });
});
