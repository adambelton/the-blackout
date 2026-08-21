import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  collectContextText,
  collectModeratorDirectives,
  collectVoiceText,
  generate,
} from "../src/narrative/generator.js";
import { StubLLMClient, toolUseResponse } from "../src/llm/stub.js";
import type { FeedEntry } from "../src/types.js";
import type { GenerationContext } from "../src/narrative/types.js";
import type { LLMRequest } from "../src/llm/types.js";

/**
 * Source-type → prompt-location routing contract.
 *
 * Each `SourceType` in Kairos has a designated path through to the
 * generator's prompt. The 2026-05-10 moderator-directive bug
 * (issue 9: "No more quoting the match clock directly" never
 * reached the LLM) was a path-routing failure: moderator entries
 * surfaced as ordinary chunk entries that curation could evict, with
 * no top-of-prompt steering channel. Plumbing-level test coverage
 * was missing — a routing change wouldn't have failed CI.
 *
 * This file pins the routing contract: for each SourceType, plant a
 * feed entry with a distinctive marker, route it through the
 * appropriate collector (mirroring what `engine.ts` does), and
 * assert the marker shows up in the rendered prompt at the expected
 * location. Doubles as living documentation of the contract — a
 * reader can see at a glance what each source type does to the
 * prompt.
 */

function systemText(system: LLMRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system.map((s) => s.text).join("\n\n");
}

let seq = 0;
function entry(overrides: Partial<FeedEntry> & { content?: string } = {}): FeedEntry {
  seq++;
  const { content = `entry ${seq}`, data, ...rest } = overrides;
  return {
    id: `e${seq}`,
    broadcastId: "b1",
    sourceId: "src",
    sourceName: "src",
    sourceType: "event",
    timestamp: seq * 1000,
    data: data ?? { content },
    enrichmentTags: [],
    ...rest,
  };
}

const baseCtx: GenerationContext = {
  currentSubjectMinute: 23,
  entries: [
    {
      entryId: "e-feed",
      source: "match_action",
      timestamp: 1_000,
      minute: "23'",
      content: "FEED_MARKER",
    },
  ],
};

describe("feed-to-prompt routing — narrative_voice → system prompt # Voice section", () => {
  it("voice content from narrative_voice entries lands in the system prompt", () => {
    seq = 0;
    const e = entry({ sourceType: "narrative_voice", content: "VOICE_MARKER_X" });
    const voice = collectVoiceText([e]);
    const system = buildSystemPrompt(voice, "Context.");
    assert.match(system, /# Voice/);
    // Marker must land BELOW the # Voice header, not in another section.
    const voiceSection = system.split("# Voice")[1]?.split("# ")[0] ?? "";
    assert.match(voiceSection, /VOICE_MARKER_X/);
  });
});

describe("feed-to-prompt routing — narrative_context → system prompt # Context section", () => {
  it("context content from narrative_context entries lands in the system prompt", () => {
    seq = 0;
    const e = entry({ sourceType: "narrative_context", content: "CONTEXT_MARKER_X" });
    const context = collectContextText([e]);
    const system = buildSystemPrompt("Voice.", context);
    assert.match(system, /# Context/);
    const contextSection = system.split("# Context")[1]?.split("# ")[0] ?? "";
    assert.match(contextSection, /CONTEXT_MARKER_X/);
  });
});

describe("feed-to-prompt routing — moderator → user message's steering preamble", () => {
  it("moderator entries surface as live editorial steering at the top of the user message", async () => {
    seq = 0;
    const e = entry({ sourceType: "moderator", content: "MODERATOR_DIRECTIVE_X" });
    const directives = collectModeratorDirectives([e]);
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, baseCtx, {
      voice: "Voice.",
      context: "Context.",
      moderatorDirectives: directives,
    });
    const userMsg = llm.calls[0].messages[0].content;
    assert.match(userMsg, /Live editorial steering/);
    assert.match(userMsg, /MODERATOR_DIRECTIVE_X/);
    // Steering must appear BEFORE canonical events / feed context —
    // if it lands lower, curation/eviction logic upstream gets to
    // weight it the same as ordinary chunk entries (the regressed
    // shape pre-fix).
    const steeringIdx = userMsg.indexOf("Live editorial steering");
    const canonicalIdx = userMsg.indexOf("Canonical events");
    const feedIdx = userMsg.indexOf("Here is the latest");
    if (canonicalIdx >= 0) {
      assert.ok(
        steeringIdx < canonicalIdx,
        "steering preamble must appear above canonical events",
      );
    }
    if (feedIdx >= 0) {
      assert.ok(
        steeringIdx < feedIdx,
        "steering preamble must appear above the feed context block",
      );
    }
  });

  it("multiple moderator directives surface in chronological order", async () => {
    seq = 0;
    const e1 = entry({ sourceType: "moderator", timestamp: 1000, content: "FIRST_DIRECTIVE" });
    const e2 = entry({ sourceType: "moderator", timestamp: 2000, content: "SECOND_DIRECTIVE" });
    const directives = collectModeratorDirectives([e2, e1]); // input order shouldn't matter
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, baseCtx, {
      voice: "Voice.",
      context: "Context.",
      moderatorDirectives: directives,
    });
    const userMsg = llm.calls[0].messages[0].content;
    const firstIdx = userMsg.indexOf("FIRST_DIRECTIVE");
    const secondIdx = userMsg.indexOf("SECOND_DIRECTIVE");
    assert.ok(firstIdx >= 0 && secondIdx >= 0, "both directives must be present");
    assert.ok(
      firstIdx < secondIdx,
      "directives must render in timestamp-ascending order so later ones implicitly override earlier ones",
    );
  });

  it("zero moderator entries → no steering preamble at all", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, baseCtx, {
      voice: "Voice.",
      context: "Context.",
      moderatorDirectives: [],
    });
    const userMsg = llm.calls[0].messages[0].content;
    assert.doesNotMatch(userMsg, /Live editorial steering/);
  });
});

describe("feed-to-prompt routing — event (canonical) → user message's canonical-events preamble", () => {
  it("canonical events surface as their own preamble", async () => {
    seq = 0;
    const goal = entry({
      sourceType: "event",
      sourceCanonical: true,
      content: "GOAL_MARKER_X",
      data: {
        eventType: "GOAL",
        subjectTime: "23",
        player: "Player",
        team: "home",
        content: "GOAL_MARKER_X",
      },
    });
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, baseCtx, {
      voice: "Voice.",
      context: "Context.",
      canonicalEvents: [goal],
    });
    const userMsg = llm.calls[0].messages[0].content;
    assert.match(userMsg, /Canonical events/);
    // The canonical-events preamble surfaces the entry — exact format
    // is owned by `formatCanonicalEvents`, but the marker must appear.
    assert.match(userMsg, /GOAL_MARKER_X|GOAL/);
  });
});

describe("feed-to-prompt routing — chunk feed (any source) → user message's feed context block", () => {
  it("ctx.entries content lands in the feed context section of the user message", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, baseCtx, { voice: "Voice.", context: "Context." });
    const userMsg = llm.calls[0].messages[0].content;
    // The feed context is the tail of the user message, prefixed by
    // either "Here is the latest" or "Here are the new" (deltaMode).
    const feedHeaderIdx = Math.max(
      userMsg.indexOf("Here is the latest"),
      userMsg.indexOf("Here are the new"),
    );
    assert.ok(feedHeaderIdx >= 0, "feed context block must be present");
    const feedSection = userMsg.slice(feedHeaderIdx);
    assert.match(feedSection, /FEED_MARKER/);
  });
});
