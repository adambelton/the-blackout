import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSystemPrompt,
  buildSystemSegments,
  collectContextText,
  collectModeratorDirectives,
  collectVoiceText,
  formatCanonicalEvents,
  generate,
  DELIVER_NARRATIVE_TOOL_NAME,
} from "../src/narrative/generator.js";
import { StubLLMClient, toolUseResponse } from "../src/llm/stub.js";
import type { FeedEntry } from "../src/types.js";
import type { GenerationContext } from "../src/narrative/types.js";
import type { LLMRequest } from "../src/llm/types.js";

/** Concatenate segment text for regex assertions regardless of form. */
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

describe("buildSystemPrompt", () => {
  it("composes voice, context, and task sections", () => {
    const prompt = buildSystemPrompt("Write like Hemingway.", "It's the FA Cup final.");
    assert.match(prompt, /# Voice/);
    assert.match(prompt, /Write like Hemingway\./);
    assert.match(prompt, /# Context/);
    assert.match(prompt, /FA Cup final/);
    assert.match(prompt, /# Task/);
    assert.match(prompt, /deliver_narrative/);
  });

  it("instructs the narrator not to leak coverage-span language into prose", () => {
    const prompt = buildSystemPrompt("Voice.", "Context.");
    // Baseline expresses the rule abstractly (no consumer-category
    // examples). Profile content carries the sport-flavoured examples
    // like "covering minutes 23–31" — see the `generation` service spec.
    assert.match(prompt, /stand on its own/);
    assert.match(prompt, /Do not describe the span of time/);
    assert.match(prompt, /do not narrate about your own act of narrating/);
  });

  it("throws when voice is empty — activation gate must have caught that", () => {
    assert.throws(() => buildSystemPrompt("", "Context is fine."), /narrative_voice is empty/);
  });

  it("throws when context is empty", () => {
    assert.throws(() => buildSystemPrompt("Voice is fine.", ""), /narrative_context is empty/);
  });
});

describe("collectVoiceText / collectContextText", () => {
  it("picks only entries matching the source type, ordered by timestamp", () => {
    seq = 0;
    const entries: FeedEntry[] = [
      entry({ sourceType: "narrative_voice", timestamp: 2000, content: "second voice line" }),
      entry({ sourceType: "narrative_context", timestamp: 500, content: "context" }),
      entry({ sourceType: "narrative_voice", timestamp: 1000, content: "first voice line" }),
      entry({ sourceType: "event", timestamp: 1500, content: "event" }),
    ];

    const voice = collectVoiceText(entries);
    const context = collectContextText(entries);

    assert.equal(voice, "first voice line\n\nsecond voice line");
    assert.equal(context, "context");
  });

  it("returns empty string when no matching entries exist", () => {
    seq = 0;
    assert.equal(collectVoiceText([]), "");
    assert.equal(collectContextText([entry()]), "");
  });
});

describe("collectModeratorDirectives", () => {
  it("returns moderator entries' content in timestamp order, trimmed", () => {
    seq = 0;
    const entries: FeedEntry[] = [
      entry({ sourceType: "moderator", timestamp: 3000, content: "Less metaphor more action." }),
      entry({ sourceType: "narrative_voice", timestamp: 1500, content: "voice" }),
      entry({ sourceType: "moderator", timestamp: 1000, content: " No more quoting the match clock directly. " }),
      entry({ sourceType: "event", timestamp: 2500, content: "event" }),
    ];
    assert.deepEqual(collectModeratorDirectives(entries), [
      "No more quoting the match clock directly.",
      "Less metaphor more action.",
    ]);
  });

  it("drops empty / whitespace-only moderator entries", () => {
    seq = 0;
    const entries: FeedEntry[] = [
      entry({ sourceType: "moderator", timestamp: 1000, content: "   " }),
      entry({ sourceType: "moderator", timestamp: 2000, content: "Real directive." }),
    ];
    assert.deepEqual(collectModeratorDirectives(entries), ["Real directive."]);
  });

  it("returns empty array when no moderator entries exist", () => {
    seq = 0;
    assert.deepEqual(collectModeratorDirectives([entry({ sourceType: "narrative_voice" })]), []);
    assert.deepEqual(collectModeratorDirectives([]), []);
  });
});

describe("generate", () => {
  const ctx: GenerationContext = {
    currentSubjectMinute: 67,
    entries: [
      {
        entryId: "e-abc",
        source: "match_events",
        timestamp: 1_000,
        minute: "67'",
        content: "Goal",
      },
    ],
  };

  it("parses a deliver_narrative tool call into prose + covers", async () => {
    const llm = new StubLLMClient([
      toolUseResponse({
        prose: "The stadium erupted.",
        covers: [{ entryId: "e-abc", subjectTime: "67+2" }],
      }),
    ]);

    const result = await generate(llm, ctx, { voice: "Voice brief.", context: "Context brief." });

    assert.equal(result.text, "The stadium erupted.");
    assert.equal(result.covers.length, 1);
    assert.equal(result.covers[0].entryId, "e-abc");
    assert.equal(result.covers[0].subjectTime, "67+2");
    assert.equal(result.toolCallFailed, false);

    // Request shape: forced tool choice, tool declared, entry id in user message.
    const call = llm.calls[0];
    assert.equal(call.toolChoice?.type, "tool");
    assert.equal((call.toolChoice as { name: string }).name, DELIVER_NARRATIVE_TOOL_NAME);
    assert.ok(call.tools?.some((t) => t.name === DELIVER_NARRATIVE_TOOL_NAME));
    assert.match(call.messages[0].content, /id:e-abc/);
    assert.match(systemText(call.system), /Voice brief\./);
    assert.match(systemText(call.system), /Context brief\./);
  });

  it("marks the system prompt cacheable and requests tool caching", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    const call = llm.calls[0];
    assert.ok(Array.isArray(call.system), "system should be segment array for cache control");
    const segments = call.system as Array<{ cache?: boolean }>;
    assert.ok(segments.some((s) => s.cache === true), "at least one system segment should be cached");
    assert.equal(call.cacheTools, true);
  });

  it("buildSystemSegments preserves the buildSystemPrompt text in one cacheable segment", () => {
    const prompt = buildSystemPrompt("Voice.", "Context.");
    const segments = buildSystemSegments("Voice.", "Context.");
    assert.equal(segments.length, 1);
    assert.equal(segments[0].text, prompt);
    assert.equal(segments[0].cache, true);
  });

  it("falls back to raw text when the model skips the tool", async () => {
    const llm = new StubLLMClient([
      { text: "Bare prose.", usage: { inputTokens: 10, outputTokens: 5 } },
    ]);

    const result = await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    assert.equal(result.text, "Bare prose.");
    assert.deepEqual(result.covers, []);
    assert.equal(result.toolCallFailed, true);
  });

  it("injects the running summary as the narrator's compact memory", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, { voice: "Voice.", context: "Context.", summary: "Blackburn lead 1-0 at the break." });

    const call = llm.calls[0];
    // The slot now frames itself as editorial carry rather than
    // "templated and authoritative" — earlier framing leaked model
    // trust onto curator-produced through-lines (the "as the brief
    // suggested" leak in 2026-05-10).
    assert.match(call.messages[0].content, /Broadcast memory so far/);
    assert.match(call.messages[0].content, /editorial carry/);
    assert.match(call.messages[0].content, /Canonical events are listed separately above/);
    assert.match(call.messages[0].content, /Do not re-narrate listed events/);
    assert.match(call.messages[0].content, /Blackburn lead 1-0/);
  });

  it("labels the feed section as delta when deltaMode is set", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, { voice: "Voice.", context: "Context.", deltaMode: true });

    const call = llm.calls[0];
    assert.match(call.messages[0].content, /new source entries since the previous passage/);
  });

  it("falls back to rolling-feed wording when deltaMode is off", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    const call = llm.calls[0];
    assert.match(call.messages[0].content, /latest context from the live feed/);
  });

  it("renders the target-words preamble with cycle duration when provided", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, {
      voice: "Voice.",
      context: "Context.",
      targetWords: 60,
      cycleDurationSeconds: 30,
    });

    const call = llm.calls[0];
    assert.match(call.messages[0].content, /Aim for roughly 60 words/);
    assert.match(call.messages[0].content, /30-second cycle/);
    assert.match(call.messages[0].content, /Undershoot if there is little to say/);
  });

  it("omits the target-words preamble when targetWords is missing or zero", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    const call = llm.calls[0];
    assert.doesNotMatch(call.messages[0].content, /Aim for roughly/);
  });

  it("splices the consumerPrompt into the user message verbatim", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    const preamble = "## Halftime\n\nReflect on the first half. The second begins shortly.";
    await generate(llm, ctx, {
      voice: "Voice.",
      context: "Context.",
      consumerPrompt: preamble,
    });

    const call = llm.calls[0];
    // Verbatim — Kairos must not rewrite or interpret the consumer's preamble.
    assert.match(call.messages[0].content, /## Halftime/);
    assert.match(call.messages[0].content, /Reflect on the first half\. The second begins shortly\./);
  });

  it("omits the consumerPrompt preamble when blank or missing", async () => {
    const llm = new StubLLMClient([
      toolUseResponse({ prose: "ok", covers: [] }),
      toolUseResponse({ prose: "ok", covers: [] }),
    ]);
    await generate(llm, ctx, { voice: "Voice.", context: "Context." });
    await generate(llm, ctx, { voice: "Voice.", context: "Context.", consumerPrompt: "   " });

    // Neither call should mention the consumerPrompt-rendering shape — there
    // is no fixed preamble text we can grep for, so verify by absence: a
    // missing/blank prompt must not leak whitespace artefacts. We assert
    // both calls produced a stable user-message shape (feed header on the
    // last line before the feed body).
    for (const call of llm.calls) {
      assert.doesNotMatch(call.messages[0].content, /\n\n\n\nFeed/);
    }
  });

  it("renders the previous-passage preamble when provided", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, {
      voice: "Voice.",
      context: "Context.",
      previousPassage: "Coventry have been patient this afternoon, rebuilding move after move.",
    });

    const call = llm.calls[0];
    assert.match(call.messages[0].content, /Previous passage — continue in its voice and tempo/);
    assert.match(call.messages[0].content, /Coventry have been patient this afternoon/);
  });

  it("omits the previous-passage preamble when blank or missing", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);

    await generate(llm, ctx, { voice: "Voice.", context: "Context.", previousPassage: "   " });

    const call = llm.calls[0];
    assert.doesNotMatch(call.messages[0].content, /Previous passage/);
  });

  it("strips inline `{{ref:<id>}}` anchors from prose and attaches charOffset to matching covers", async () => {
    const llm = new StubLLMClient([
      toolUseResponse({
        prose: "And then {{ref:e-abc}}Welbeck slices across the box.",
        covers: [{ entryId: "e-abc", subjectTime: "67+2" }],
      }),
    ]);

    const result = await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    // Listener-visible prose must not contain the anchor.
    assert.equal(result.text, "And then Welbeck slices across the box.");
    assert.doesNotMatch(result.text, /\{\{ref:/);
    // Declared cover picks up the anchor's offset.
    assert.equal(result.covers.length, 1);
    assert.equal(result.covers[0].entryId, "e-abc");
    assert.equal(result.covers[0].subjectTime, "67+2");
    assert.equal(result.covers[0].charOffset, "And then ".length);
  });

  it("keeps covers without an anchor — charOffset is simply absent", async () => {
    const llm = new StubLLMClient([
      toolUseResponse({
        prose: "A quiet passage with no anchors at all.",
        covers: [{ entryId: "e-abc" }],
      }),
    ]);

    const result = await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    assert.equal(result.text, "A quiet passage with no anchors at all.");
    assert.equal(result.covers.length, 1);
    assert.equal(result.covers[0].entryId, "e-abc");
    assert.equal(result.covers[0].charOffset, undefined);
  });

  it("uses the first anchor when an entry is referenced multiple times", async () => {
    const llm = new StubLLMClient([
      toolUseResponse({
        prose: "{{ref:e-abc}}Welbeck starts it. Later, {{ref:e-abc}}Welbeck finishes.",
        covers: [{ entryId: "e-abc" }],
      }),
    ]);

    const result = await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    assert.equal(result.covers[0].charOffset, 0);
  });

  it("strips an anchor whose id isn't declared in covers (warning path) without surfacing it in prose", async () => {
    const llm = new StubLLMClient([
      toolUseResponse({
        prose: "The keeper {{ref:e-ghost}}stays rooted.",
        covers: [],
      }),
    ]);

    const result = await generate(llm, ctx, { voice: "Voice.", context: "Context." });

    assert.equal(result.text, "The keeper stays rooted.");
    assert.equal(result.covers.length, 0);
  });

  it("teaches the generator the anchor convention in the system prompt", async () => {
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, ctx, { voice: "Voice.", context: "Context." });
    const call = llm.calls[0];
    assert.match(systemText(call.system), /\{\{ref:/);
    assert.match(systemText(call.system), /word boundary/);
  });
});

describe("feed listing — chronological sort by content ordinal", () => {
  // Without sorting, the LLM sees entries in arrival order. A
  // late-arriving pre-whistle event (post-FT distillation describing
  // the dying moments) lands AFTER the synthetic FULL_TIME marker in
  // arrival order, but BEFORE it in content time. Pre-fix, the
  // generator would open closing prose on the whistle then circle
  // back to the action. Finding 5 in the 2026-05-03 live test debrief.
  it("sorts the feed by content ordinal so chronology is preserved regardless of arrival order", async () => {
    const halftimeMarker = {
      entryId: "ht",
      source: "match_events",
      timestamp: 100, // arrived FIRST
      minute: "45'",
      phase: "halftime",
      phaseSecond: 0,
      content: "Half-time whistle.",
    };
    const lateFirstHalfAction = {
      entryId: "late-1h",
      source: "match_action",
      timestamp: 200, // arrived AFTER the whistle marker
      minute: "45+1'",
      phase: "first_half",
      phaseSecond: 2700,
      content: "Yamashita made an excellent save.",
    };
    const sortedCtx: GenerationContext = {
      currentSubjectMinute: 45,
      currentSubjectPhase: "halftime",
      currentSubjectPhaseSecond: 0,
      entries: [halftimeMarker, lateFirstHalfAction],
    };

    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, sortedCtx, { voice: "Voice.", context: "Context." });

    const userText = llm.calls[0].messages[0].content;
    const lateIdx = userText.indexOf("Yamashita");
    const htIdx = userText.indexOf("Half-time whistle");
    assert.ok(lateIdx >= 0, "first-half action present in feed");
    assert.ok(htIdx >= 0, "halftime marker present in feed");
    assert.ok(
      lateIdx < htIdx,
      "first-half content listed before halftime marker, regardless of arrival order",
    );
  });
});

describe("formatCanonicalEvents", () => {
  // Antidote to Haiku summary drift (2026-04-22 Burnley-City: the
  // summary silently dropped Haaland's goal, narrator subsequently
  // claimed City hadn't scored). The canonical events prelude
  // carries priority entries verbatim as ground truth.

  function priorityEntry(
    id: string,
    data: Record<string, unknown>,
    timestamp = 0,
  ): FeedEntry {
    return {
      id,
      broadcastId: "b1",
      sourceId: "match_events",
      sourceName: "match_events",
      sourceType: "event",
      timestamp,
      data,
      enrichmentTags: [],
    };
  }

  it("emits nothing when the list is empty or undefined", () => {
    assert.equal(formatCanonicalEvents(undefined), "");
    assert.equal(formatCanonicalEvents([]), "");
  });

  it("renders entries as a bulleted list under a ground-truth heading", () => {
    const out = formatCanonicalEvents([
      priorityEntry("e1", { content: "GOAL — Haaland (Manchester City) 0-1", subjectTime: "6" }, 1000),
    ]);
    assert.match(out, /Canonical events \(ground truth — the authoritative record, never contradict\):/);
    assert.match(out, /- \[6'\] GOAL — Haaland \(Manchester City\) 0-1/);
  });

  it("sorts entries chronologically by timestamp regardless of input order", () => {
    const out = formatCanonicalEvents([
      priorityEntry("late", { content: "GOAL — Welbeck 1-0", subjectTime: "80" }, 3000),
      priorityEntry("early", { content: "YELLOW — Hinshelwood", subjectTime: "12" }, 1000),
      priorityEntry("mid", { content: "GOAL — Rutter 2-0", subjectTime: "45" }, 2000),
    ]);
    const lines = out.split("\n").filter((l) => l.startsWith("-"));
    assert.equal(lines.length, 3);
    assert.match(lines[0], /YELLOW/);
    assert.match(lines[1], /Rutter/);
    assert.match(lines[2], /Welbeck/);
  });

  it("omits the subjectTime prefix when it's missing", () => {
    const out = formatCanonicalEvents([
      priorityEntry("e1", { content: "KICKOFF" }, 1000),
    ]);
    assert.match(out, /- KICKOFF/);
    assert.doesNotMatch(out, /\[\s*'\]/);
  });

  it("falls back to JSON-stringifying the data when no content string is present", () => {
    const out = formatCanonicalEvents([
      priorityEntry("e1", { eventType: "PENALTY", player: "Haaland" }, 1000),
    ]);
    // Exact format doesn't matter; just that some recognisable
    // representation is there rather than dropping the entry.
    assert.match(out, /PENALTY/);
    assert.match(out, /Haaland/);
  });

  it("is threaded into the generator prompt as a preamble when canonicalEvents is supplied", async () => {
    const localCtx: GenerationContext = {
      currentSubjectMinute: null,
      entries: [],
    };
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, localCtx, {
      voice: "Voice.",
      context: "Context.",
      canonicalEvents: [
        priorityEntry("e1", { content: "GOAL — Haaland 0-1", subjectTime: "6" }, 1000),
      ],
    });
    const call = llm.calls[0];
    assert.match(call.messages[0].content, /Canonical events \(ground truth/);
    assert.match(call.messages[0].content, /GOAL — Haaland 0-1/);
  });

  it("does not include a canonical-events preamble when the list is absent", async () => {
    const localCtx: GenerationContext = {
      currentSubjectMinute: null,
      entries: [],
    };
    const llm = new StubLLMClient([toolUseResponse({ prose: "ok", covers: [] })]);
    await generate(llm, localCtx, { voice: "Voice.", context: "Context." });
    const call = llm.calls[0];
    assert.doesNotMatch(call.messages[0].content, /Canonical events/);
  });
});
