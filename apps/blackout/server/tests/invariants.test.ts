import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { checkNarrativeInvariants } from "../src/conductor/invariants.js";
import type { KairosFeedEntry, KairosNarrativeOutput } from "../src/lib/kairos.js";

// Silence + capture console.warn / console.error so we can assert on
// which invariants fire. captureInvariant logs to one of those two
// depending on severity.
let warnings: string[] = [];
let errors: string[] = [];
const origWarn = console.warn;
const origError = console.error;

beforeEach(() => {
  warnings = [];
  errors = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
});
afterEach(() => {
  console.warn = origWarn;
  console.error = origError;
});

function makeEvent(id: string, eventType: string, extras: Record<string, unknown> = {}): KairosFeedEntry {
  return {
    id,
    source: "match_events",
    data: { eventType, ...extras },
    timestamp: new Date().toISOString(),
    created_at: new Date().toISOString(),
  };
}

function makeNarrative(text: string, covers: Array<{ entryId: string }> = []): KairosNarrativeOutput {
  return {
    id: "n1",
    broadcastId: "b1",
    text,
    generatedAt: new Date().toISOString(),
    covers,
  };
}

describe("checkNarrativeInvariants", () => {
  it("fires nothing when an uneventful batch is fully covered by prose", () => {
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("The ball is worked patiently across the back four."),
      batchEntries: [],
    });
    assert.equal(warnings.length, 0);
    assert.equal(errors.length, 0);
  });

  it("fires event_uncovered when a GOAL in the batch isn't cited", () => {
    const goal = makeEvent("goal-1", "GOAL", { player: "Welbeck" });
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("The ball loops harmlessly into the stands."),
      batchEntries: [goal],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[invariant:event_uncovered\]/);
    assert.match(warnings[0], /GOAL entry goal-1/);
  });

  it("does not fire event_uncovered when the GOAL is in covers", () => {
    const goal = makeEvent("goal-1", "GOAL", { player: "Welbeck" });
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("Welbeck scores.", [{ entryId: "goal-1" }]),
      batchEntries: [goal],
    });
    assert.equal(warnings.length, 0);
  });

  it("fires event_uncovered for RED_CARD without coverage", () => {
    const card = makeEvent("red-1", "RED_CARD", { player: "Fernández" });
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("The game continues at pace."),
      batchEntries: [card],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /\[invariant:event_uncovered\]/);
    assert.match(warnings[0], /RED_CARD/);
  });

  it("does not fire on non-priority event types (ZONE_ENTRY)", () => {
    const zone = makeEvent("zone-1", "ZONE_ENTRY");
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("The ball moves up the pitch."),
      batchEntries: [zone],
    });
    assert.equal(warnings.length, 0);
  });

  it("fires score_phrase_without_goal on '1-0' with no GOAL covered", () => {
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("A scruffy first half peters out at 1-0."),
      batchEntries: [],
    });
    const names = warnings.map((w) => w);
    const scoreHit = names.find((w) => /score_phrase_without_goal/.test(w));
    assert.ok(scoreHit, "expected a score_phrase_without_goal warning");
  });

  it("fires score_phrase_without_goal on 'equaliser' with no GOAL covered", () => {
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("And then the equaliser comes, out of nothing."),
      batchEntries: [],
    });
    const scoreHit = warnings.find((w) => /score_phrase_without_goal/.test(w));
    assert.ok(scoreHit, "expected a score_phrase_without_goal warning");
  });

  it("does not fire score_phrase_without_goal when a GOAL is cited", () => {
    const goal = makeEvent("goal-1", "GOAL");
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative(
        "Mitoma finds the equaliser, out of nothing.",
        [{ entryId: "goal-1" }],
      ),
      batchEntries: [goal],
    });
    const scoreHit = warnings.find((w) => /score_phrase_without_goal/.test(w));
    assert.equal(scoreHit, undefined);
  });

  // Regression: 2026-04-22 Brighton-Chelsea replay. The narrator said
  // The Delap case ("whether one goal will ever be enough") and the
  // scoring-verb framing ("Welbeck slotted home from close range") were
  // matched by broadened `\bgoal(s)?\b` and bare scoring-verb regexes
  // added 2026-04-22. Those patterns fired six times during the
  // 2026-04-26 FA Cup SF on legitimate prose referencing past goals
  // (Chelsea's scoring drought, prior leg goals) — false-positive rate
  // outweighed the benefit. Reverted 2026-04-26 to assertion-strength
  // patterns only (score changes, named scoring moments, ahead/level
  // constructions). Oblique goal hallucinations of the Delap class are
  // now caught by `event_uncovered` when a GOAL entry is in the batch
  // but uncited, which is the higher-precision signal.
  it("does NOT fire score_phrase_without_goal on bare goal-noun reference", () => {
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative(
        "Delap may have answered the question of how Chelsea score tonight. The question now is whether one goal will ever be enough.",
      ),
      batchEntries: [],
    });
    const scoreHit = warnings.find((w) => /score_phrase_without_goal/.test(w));
    assert.ok(!scoreHit, "bare goal noun + scoring verb must not fire post-2026-04-26 narrowing");
  });

  it("does NOT fire on past-tense scoring-verb references", () => {
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("Welbeck slotted home from close range in last week's leg."),
      batchEntries: [],
    });
    const scoreHit = warnings.find((w) => /score_phrase_without_goal/.test(w));
    assert.ok(!scoreHit, "past-tense reference to a prior-leg goal must not fire");
  });

  it("still fires on a clear score-change phrase with no GOAL in covers", () => {
    checkNarrativeInvariants({
      broadcastId: "b1",
      narrative: makeNarrative("Brighton lead 1-0 with twenty minutes to play."),
      batchEntries: [],
    });
    const scoreHit = warnings.find((w) => /score_phrase_without_goal/.test(w));
    assert.ok(scoreHit, "explicit score change must still be flagged when no GOAL is in covers");
  });
});
