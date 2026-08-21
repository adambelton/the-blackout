import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toFeedEntry } from "../src/ws/moderator-feed-shape.js";
import type { KairosFeedEntry } from "../src/lib/kairos.js";

const baseEntry = {
  id: "e1",
  timestamp: 1_700_000_000,
  created_at: "2026-04-22T20:00:00.000Z",
};

const entry = (
  source: string,
  data: Record<string, unknown>,
  overrides: Partial<KairosFeedEntry> = {},
): KairosFeedEntry =>
  ({
    ...baseEntry,
    source,
    data,
    ...overrides,
  }) as unknown as KairosFeedEntry;

describe("toFeedEntry — moderator UI shape mapping", () => {
  it("drops match_stats entirely (would swamp the scroll pane)", () => {
    assert.equal(toFeedEntry(entry("match_stats", { kind: "ball_position", x: 1, y: 1 })), null);
  });

  it("drops unknown sources — the operator's vocabulary is the const-array in @blackout/shared, not whatever-string-the-runner-might-push", () => {
    // Adding a new source means: extend KAIROS_SOURCE_NAMES + the
    // matching branch in toFeedEntry. The previous "passthrough"
    // behaviour was the source-as-identifier smell F19 fixed.
    assert.equal(toFeedEntry(entry("future_unknown_source", { content: "hi" })), null);
  });

  describe("match_events", () => {
    it("preserves the source name and stamps GOAL as the subType", () => {
      const result = toFeedEntry(
        entry("match_events", {
          eventType: "GOAL",
          content: "Haaland scores",
          player: "Erling Haaland",
          team: { side: "away", name: "Manchester City" },
          minute: 23,
          extraMinute: null,
          subjectTime: "23",
          result: "0-1",
        }),
      );
      assert.ok(result);
      assert.equal(result.source, "match_events");
      assert.equal(result.subType, "GOAL");
      assert.equal(result.content, "Haaland scores");
      assert.equal(result.minute, 23);
      assert.equal(result.contentTime, "23");
      assert.equal(result.metadata?.eventType, "GOAL");
      assert.equal(result.metadata?.player, "Erling Haaland");
      assert.equal(result.metadata?.team, "away");
      assert.equal(result.metadata?.teamName, "Manchester City");
      assert.equal(result.metadata?.isGoal, true);
    });

    it("derives team from the legacy team-as-string shape", () => {
      const result = toFeedEntry(
        entry("match_events", {
          eventType: "YELLOW_CARD",
          team: "home",
          minute: 12,
        }),
      );
      assert.ok(result);
      assert.equal(result.source, "match_events");
      assert.equal(result.subType, "YELLOW_CARD");
      assert.equal(result.metadata?.team, "home");
      assert.equal(result.metadata?.isGoal, false);
    });

    it("falls back to data.text when data.content is missing", () => {
      const result = toFeedEntry(
        entry("match_events", { eventType: "SUBSTITUTION", text: "Foden on for De Bruyne", minute: 60 }),
      );
      assert.ok(result);
      assert.equal(result.content, "Foden on for De Bruyne");
      assert.equal(result.subType, "SUBSTITUTION");
    });
  });

  describe("match_pressure", () => {
    it("preserves the source name and stamps PRESSURE_UPDATE as the subType", () => {
      const result = toFeedEntry(
        entry("match_pressure", {
          eventType: "PRESSURE_UPDATE",
          content: "[PRESSURE] City (45s): 60% territory",
          team: { side: "away", name: "Manchester City" },
          subjectTime: "23",
        }),
      );
      assert.ok(result);
      assert.equal(result.source, "match_pressure");
      assert.equal(result.subType, "PRESSURE_UPDATE");
      assert.equal(result.metadata?.eventType, "PRESSURE_UPDATE");
      // Pressure isn't a goal — the split goal flag must follow
      // eventType, not source.
      assert.equal(result.metadata?.isGoal, false);
    });
  });

  describe("match_action — distilled commentary", () => {
    it("stamps atmosphere as the subType and carries no parent linkage", () => {
      const result = toFeedEntry(
        entry("match_action", {
          kind: "atmosphere",
          content: "The Amex is rising as Brighton break.",
          subjectTime: "23",
        }),
      );
      assert.ok(result);
      assert.equal(result.source, "match_action");
      assert.equal(result.subType, "atmosphere");
      assert.equal(result.metadata?.parentSourceId, undefined);
    });

    it("stamps event_texture as the subType and surfaces parentSourceId + eventClass when present", () => {
      const result = toFeedEntry(
        entry("match_action", {
          kind: "event_texture",
          content: "Mitoma cuts in from the left, Kadıoğlu's nod back.",
          eventClass: "GOAL",
          parentSourceId: "156672294",
        }),
      );
      assert.ok(result);
      assert.equal(result.source, "match_action");
      assert.equal(result.subType, "event_texture");
      assert.equal(result.metadata?.parentSourceId, "156672294");
      assert.equal(result.metadata?.eventClass, "GOAL");
    });
  });

  describe("transcription (retired pre-distillation cutover)", () => {
    it("drops `transcription` entries — production no longer pushes them; replays from before the cutover would surface raw commentary the moderator shouldn't see", () => {
      assert.equal(
        toFeedEntry(
          entry("transcription", {
            content: "and they break forward",
            subjectTime: "23",
            minute: 23,
          }),
        ),
        null,
      );
    });
  });

  describe("moderator", () => {
    it("preserves the source name, no subType (the source itself is the classification)", () => {
      const result = toFeedEntry(
        entry("moderator", { content: "watch the left back", subjectTime: "12" }),
      );
      assert.ok(result);
      assert.equal(result.source, "moderator");
      assert.equal(result.subType, undefined);
      assert.equal(result.content, "watch the left back");
      assert.equal(result.metadata, undefined);
    });
  });

  describe("narrative_context / narrative_voice", () => {
    it("preserves narrative_context source name and content as-is (no UI prefix)", () => {
      const result = toFeedEntry(
        entry("narrative_context", { content: "Match brief: City vs Burnley." }),
      );
      assert.ok(result);
      assert.equal(result.source, "narrative_context");
      assert.equal(result.subType, undefined);
      assert.equal(result.content, "Match brief: City vs Burnley.");
      assert.equal(result.minute, null);
      assert.equal(result.extraMinute, null);
    });

    it("preserves narrative_voice source name", () => {
      const result = toFeedEntry(entry("narrative_voice", { content: "A literary football voice." }));
      assert.ok(result);
      assert.equal(result.source, "narrative_voice");
      assert.equal(result.content, "A literary football voice.");
    });
  });

  describe("timestamp resolution", () => {
    it("prefers numeric timestamp when present", () => {
      const result = toFeedEntry(
        entry("moderator", { content: "x" }, { timestamp: 5_000 }),
      );
      assert.equal(result?.timestamp, 5_000);
    });

    it("falls back to parsing created_at when timestamp is missing", () => {
      const result = toFeedEntry({
        id: "e1",
        source: "moderator",
        data: { content: "x" },
        created_at: "2026-04-22T20:00:00.000Z",
      } as unknown as KairosFeedEntry);
      assert.equal(result?.timestamp, Date.parse("2026-04-22T20:00:00.000Z"));
    });
  });
});
