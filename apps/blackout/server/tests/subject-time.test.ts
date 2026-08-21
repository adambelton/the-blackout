import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeLiveSubjectTime, computeSubjectPhaseAnchor } from "../src/lib/subject-time.js";
import type { SportmonksPeriod } from "../src/lib/sportmonks.js";

const KICKOFF = Date.parse("2026-04-26T20:00:00Z");

function firstHalfStarted(startedMs: number = KICKOFF): SportmonksPeriod {
  return {
    id: 1,
    fixture_id: 1,
    type_id: 1,
    started: Math.floor(startedMs / 1000),
    ended: null,
    counts_from: 0,
    ticking: true,
    sort_order: 1,
    description: "1H",
    time_added: 0,
    period_length: 45,
    minutes: 0,
    seconds: 0,
    has_timer: true,
  } as SportmonksPeriod;
}

describe("computeLiveSubjectTime — football minute is 1-indexed", () => {
  it("returns 1' at kickoff exactly (the first second after the whistle is 1', never 0')", () => {
    const out = computeLiveSubjectTime([firstHalfStarted()], null, KICKOFF);
    assert.equal(out, "1");
  });

  it("returns 1' for the entire first minute (0–59s elapsed)", () => {
    for (const offsetSeconds of [0, 1, 30, 59]) {
      const out = computeLiveSubjectTime([firstHalfStarted()], null, KICKOFF + offsetSeconds * 1000);
      assert.equal(out, "1", `at +${offsetSeconds}s expected 1', got ${out}`);
    }
  });

  it("rolls to 2' once 60s have elapsed", () => {
    const out = computeLiveSubjectTime([firstHalfStarted()], null, KICKOFF + 60_000);
    assert.equal(out, "2");
  });

  it("never emits 0' under any in-play offset", () => {
    // Sweep first ten minutes of the half — 0' must never appear in
    // any output. This is the canary for the off-by-one regression
    // that surfaced 2026-04-26 (broadcast clock read 0' for ~8
    // match-minutes, combined with Sportmonks period-data lag).
    for (let s = 0; s < 600; s++) {
      const out = computeLiveSubjectTime([firstHalfStarted()], null, KICKOFF + s * 1000);
      assert.notEqual(out, "0", `0' at +${s}s — kickoff is 1'`);
    }
  });

  it("normalises second-half minutes via counts_from=45", () => {
    const secondHalf: SportmonksPeriod = {
      ...firstHalfStarted(KICKOFF + 60 * 60_000),
      counts_from: 45,
      description: "2H",
    };
    // 1s into 2H → 46', not 1'.
    const out = computeLiveSubjectTime([secondHalf], null, KICKOFF + 60 * 60_000 + 1000);
    assert.equal(out, "46");
  });

  it("emits stoppage labels past the period's natural end (45+x)", () => {
    // 45 min elapsed → subject minute 46 → "45+1" (one minute into stoppage).
    const out = computeLiveSubjectTime([firstHalfStarted()], null, KICKOFF + 45 * 60_000);
    assert.equal(out, "45+1");
  });

  it("falls back to phase labels (HT) when no period contains the moment", () => {
    const ended: SportmonksPeriod = {
      ...firstHalfStarted(),
      started: Math.floor(KICKOFF / 1000),
      ended: Math.floor((KICKOFF + 47 * 60_000) / 1000),
      ticking: false,
      has_timer: true,
    };
    const out = computeLiveSubjectTime(
      [ended],
      { short_name: "HT" },
      KICKOFF + 50 * 60_000,
    );
    assert.equal(out, "HT");
  });

  it("returns pre_match before the whistle when no period has started", () => {
    const notStarted: SportmonksPeriod = {
      ...firstHalfStarted(),
      started: null,
      ended: null,
      ticking: false,
      has_timer: true,
    };
    const out = computeLiveSubjectTime([notStarted], { short_name: "NS" }, KICKOFF);
    assert.equal(out, "pre_match");
  });
});

describe("historical-period containment after a phase ends — Finding 4 regression", () => {
  // Scenario: Sportmonks fires HALFTIME. The first-half period now has
  // `ended` set and (per prod observation in the 2026-05-03 live test)
  // `has_timer: false`. An offset-corrected distillation anchor lands
  // INSIDE the ended period's wall-clock window. The phase resolution
  // must return `first_half`, not `halftime` — the audio describes
  // pre-whistle action.
  //
  // Pre-fix: the period-containment filter excluded periods with
  // `has_timer: false`, so the lookup fell through to the
  // state.short_name-based fallback ("HT") and stamped the entry as
  // halftime / phaseSecond=0. Reproduced in prod feed_entries.

  function firstHalfEndedPostHT(): SportmonksPeriod {
    return {
      ...firstHalfStarted(),
      ended: Math.floor((KICKOFF + 47 * 60_000) / 1000),
      ticking: false,
      // Sportmonks's observed behavior at HT: the 1H period's timer
      // flips OFF once the period ends.
      has_timer: false,
    };
  }

  it("computeSubjectPhaseAnchor returns first_half for a moment inside the ended 1H window", () => {
    const period = firstHalfEndedPostHT();
    // Audio observed at HT+5s wall-clock, offset-corrected back to 30s
    // before HT — content time is 46m30s of first half.
    const observedAtMs = KICKOFF + (45 * 60 + 30) * 1000;
    const anchor = computeSubjectPhaseAnchor(
      [period],
      { short_name: "HT" },
      observedAtMs,
    );
    assert.equal(anchor.phase, "first_half");
    assert.equal(anchor.phaseSecond, 45 * 60 + 30);
  });

  it("computeLiveSubjectTime returns the minute label for a moment inside the ended 1H window", () => {
    const period = firstHalfEndedPostHT();
    const observedAtMs = KICKOFF + (45 * 60 + 30) * 1000;
    const out = computeLiveSubjectTime(
      [period],
      { short_name: "HT" },
      observedAtMs,
    );
    assert.equal(out, "45+1", "stoppage-time minute, not the HT label");
  });

  it("computeSubjectPhaseAnchor falls through to halftime only when atWallClockMs is past 1H.ended", () => {
    const period = firstHalfEndedPostHT();
    // 50min elapsed — past the 1H ended timestamp (47min). This is a
    // genuine halftime moment, not a pre-whistle audio query.
    const observedAtMs = KICKOFF + 50 * 60_000;
    const anchor = computeSubjectPhaseAnchor(
      [period],
      { short_name: "HT" },
      observedAtMs,
    );
    assert.equal(anchor.phase, "halftime");
  });
});
