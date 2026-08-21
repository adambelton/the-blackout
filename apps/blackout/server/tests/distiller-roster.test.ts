import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildUserMessage } from "../src/lib/distiller.js";

/**
 * Distiller roster-threading contract.
 *
 * Real bug from 2026-04-26: the distiller's user-message did not
 * include the lineup roster, so Haiku had no canonical reference for
 * player names. Deepgram mis-hears (e.g. "Vogel" for Bogle, "Menzo"
 * for Enzo) propagated through the distillation outputs into the
 * narrator, who wrote 94 confident words about a fictional Leeds
 * equaliser — narrating "Euler Brand finishes cleanly" in a 1-0
 * Chelsea win.
 *
 * Contract: when rosters are supplied, the user message includes
 * a "Squad lists for this fixture" section with both teams labelled
 * by side and named where supplied. When rosters are empty/absent,
 * the section is omitted (no false constraint imposed pre-lineup).
 */
describe("buildUserMessage — roster threading", () => {
  it("includes home + away rosters when both are supplied", () => {
    const msg = buildUserMessage({
      lines: ["something happened"],
      homeRoster: ["Cole Palmer", "Enzo Fernández"],
      awayRoster: ["Jayden Bogle", "Pascal Struijk"],
      homeTeamName: "Chelsea",
      awayTeamName: "Leeds United",
    });

    assert.match(msg, /Squad lists for this fixture/);
    assert.match(msg, /Chelsea \(home\)/);
    assert.match(msg, /Leeds United \(away\)/);
    assert.match(msg, /Cole Palmer/);
    assert.match(msg, /Enzo Fernández/);
    assert.match(msg, /Jayden Bogle/);
    assert.match(msg, /Pascal Struijk/);
  });

  it("omits the rosters section entirely when both rosters are empty", () => {
    const msg = buildUserMessage({
      lines: ["something happened"],
      homeRoster: [],
      awayRoster: [],
    });
    assert.doesNotMatch(msg, /Squad lists/);
  });

  it("omits the rosters section when neither field is supplied", () => {
    const msg = buildUserMessage({ lines: ["a", "b"] });
    assert.doesNotMatch(msg, /Squad lists/);
  });

  it("includes only the home roster when away is absent", () => {
    const msg = buildUserMessage({
      lines: ["x"],
      homeRoster: ["Cole Palmer"],
      homeTeamName: "Chelsea",
    });
    assert.match(msg, /Squad lists for this fixture/);
    assert.match(msg, /Chelsea \(home\)/);
    assert.doesNotMatch(msg, /\(away\)/);
    assert.match(msg, /Cole Palmer/);
  });

  it("falls back to generic Home/Away labels when team names are not supplied", () => {
    const msg = buildUserMessage({
      lines: ["x"],
      homeRoster: ["Player A"],
      awayRoster: ["Player B"],
    });
    assert.match(msg, /^### Home$/m);
    assert.match(msg, /^### Away$/m);
  });

  it("preserves the existing match-clock anchor + recent canonical events sections", () => {
    const msg = buildUserMessage({
      lines: ["x"],
      subjectTimeAnchor: "45+1",
      recentCanonicalEvents: ["GOAL @23"],
      homeRoster: ["P"],
    });
    assert.match(msg, /Match-clock anchor/);
    assert.match(msg, /45\+1/);
    assert.match(msg, /Recent canonical events/);
    assert.match(msg, /GOAL @23/);
    assert.match(msg, /Squad lists/);
  });
});
