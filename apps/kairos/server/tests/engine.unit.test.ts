/**
 * Direct tests for `NarrativeEngine.run()` — the 340-line method on the
 * critical path that the audit flagged as having no unit coverage. Each
 * test exercises one load-bearing behaviour through `driveGeneration`,
 * the engine's only public entry point, and asserts on observable
 * outputs: the returned `NarrativeOutput`, the persisted `generations`
 * row, and the WebSocket messages the engine broadcast to subscribers.
 *
 * `Feed` is stubbed via a duck-typed `getAll()` — the engine only
 * reads from it, so the wire contract is "give me entries." The real
 * `BroadcastStateTracker` is used with an unused `ServiceRegistry`
 * cast, since none of the engine's call paths exercise the registry
 * method. `StubLLMClient` scripts the narrator response and the test
 * inspects its recorded calls to assert what the generator was given.
 *
 * `db` is real (the test DB, migrated by `pretest`) — the engine
 * writes directly via `db.insert(generations)` so the test asserts on
 * actual persisted rows. Each test inserts its own broadcast row +
 * source row and tears the runtime down via `resetRuntimeData`.
 */

import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { closeConnection, resetRuntimeData, sql } from "./helpers.js";
import { db } from "../src/db/client.js";
import {
  broadcasts,
  generations,
  sources as sourcesTable,
} from "../src/db/schema.js";
import { NarrativeEngine } from "../src/narrative/engine.js";
import { BroadcastStateTracker } from "../src/curation/state-tracker.js";
import { StubLLMClient, toolUseResponse } from "../src/llm/stub.js";
import { LLMRateLimitError } from "../src/llm/types.js";
import { subjectOrdinalForEntry } from "../src/pipeline/subject-time.js";
import type { Feed } from "../src/feed.js";
import type { ServiceRegistry } from "../src/registry.js";
import type { CuratedPayload } from "../src/curation/types.js";
import type { FeedEntry } from "../src/types.js";
import type { WebSocket } from "ws";

interface RecordedSend {
  raw: string;
  parsed: Record<string, unknown>;
}

function recordingSubscribers(): { set: Set<WebSocket>; sent: RecordedSend[] } {
  const sent: RecordedSend[] = [];
  const fake = {
    send: (payload: string) => {
      sent.push({ raw: payload, parsed: JSON.parse(payload) });
    },
  } as unknown as WebSocket;
  return { set: new Set([fake]), sent };
}

function fakeFeed(entries: FeedEntry[]): Feed {
  return { getAll: () => entries } as unknown as Feed;
}

/** Feed whose snapshot can be swapped between cycles via `setEntries`. */
function mutableFakeFeed(initial: FeedEntry[]): { feed: Feed; setEntries: (next: FeedEntry[]) => void } {
  let current = initial;
  const feed = { getAll: () => current } as unknown as Feed;
  return { feed, setEntries: (next) => { current = next; } };
}

function entry(broadcastId: string, sourceId: string, overrides: Partial<FeedEntry> & { content?: string } = {}): FeedEntry {
  const { content, data, ...rest } = overrides;
  return {
    id: rest.id ?? crypto.randomUUID(),
    broadcastId,
    sourceId,
    sourceName: rest.sourceName ?? "match_events",
    sourceType: rest.sourceType ?? "event",
    sourceCanonical: rest.sourceCanonical ?? true,
    timestamp: rest.timestamp ?? Date.now(),
    data: data ?? { content: content ?? "GOAL — Welbeck scores", subjectTime: "23" },
    enrichmentTags: rest.enrichmentTags ?? [],
  } as FeedEntry;
}

/**
 * Voice + context entries the engine pulls from the feed before
 * calling `buildSystemPrompt`. The activation gate guarantees they
 * exist in production; the engine throws if either is empty. Add
 * these to every fake-feed snapshot the engine reads from.
 */
function ambientEntries(broadcastId: string, sourceId: string): FeedEntry[] {
  return [
    {
      id: crypto.randomUUID(),
      broadcastId,
      sourceId,
      sourceName: "narrative_voice",
      sourceType: "narrative_voice",
      sourceCanonical: false,
      timestamp: 0,
      data: { content: "Spare, unsentimental prose. Short sentences." },
      enrichmentTags: [],
    } as FeedEntry,
    {
      id: crypto.randomUUID(),
      broadcastId,
      sourceId,
      sourceName: "narrative_context",
      sourceType: "narrative_context",
      sourceCanonical: false,
      timestamp: 0,
      data: { content: "Brighton vs Chelsea, league fixture." },
      enrichmentTags: [],
    } as FeedEntry,
  ];
}

async function setupBroadcast(): Promise<{ broadcastId: string; sourceId: string }> {
  const [broadcast] = await db
    .insert(broadcasts)
    .values({ eventProfileName: "sporting_event", status: "active" })
    .returning();
  const [source] = await db
    .insert(sourcesTable)
    .values({
      broadcastId: broadcast.id,
      name: "match_events",
      type: "event",
      canonical: true,
    })
    .returning();
  return { broadcastId: broadcast.id, sourceId: source.id };
}

function basicCurated(
  broadcastId: string,
  entries: FeedEntry[],
  overrides: Partial<CuratedPayload> = {},
): CuratedPayload {
  return {
    broadcastId,
    entries,
    annotations: [],
    originalAnnotations: [],
    context: {
      mode: "action_led",
      summary: undefined,
      relevantThreads: [],
      arcPhase: null,
      urgentSubjects: [],
      conflicts: [],
      decisions: {},
      pacing: { recommendedWordCount: 0, cadenceMs: 30_000 },
      selectedAnnotations: [],
      recentCycles: [],
      elapsedMs: 0,
      triggerReason: "accumulation",
      serviceLastSurfacedAt: {},
    },
    triggerReason: "accumulation",
    generatedAt: Date.now(),
    ...overrides,
  } as CuratedPayload;
}

const NARRATOR_PROSE = "Welbeck arrived. The home end erupted. Brighton ahead at the half-hour.";

before(async () => {
  await resetRuntimeData();
});

after(async () => {
  await closeConnection();
});

beforeEach(async () => {
  await resetRuntimeData();
});

describe("NarrativeEngine — contentTime monotonic clamp", () => {
  it("clamps a regressing batch contentTime to the previous floor", async () => {
    const { broadcastId, sourceId } = await setupBroadcast();
    const llm = new StubLLMClient([]);
    llm.setNarratorResponse(toolUseResponse({ prose: NARRATOR_PROSE, covers: [] }));
    const tracker = new BroadcastStateTracker(broadcastId, {} as ServiceRegistry);
    const { set: subscribers, sent } = recordingSubscribers();

    // First cycle: timestamp T1, subjectTime "23" — contentTime
    // settles at 23 and becomes the monotonic floor.
    // Timestamps near Date.now() so the prior-cycle's triggeredAt
    // (auto-stamped at DB insert) sits between cycle 1's entry and
    // cycle 2's entry. computeBatchEntries filters entries strictly
    // newer than triggeredAt — if all entries are in the deep past,
    // cycle 2's batch is empty and contentTime falls through to null
    // (the clamp doesn't engage on null).
    const baseTs = Date.now();
    const ambient = ambientEntries(broadcastId, sourceId);
    const e1 = entry(broadcastId, sourceId, {
      timestamp: baseTs - 5_000,
      data: { content: "first", subjectTime: "23" },
    });
    const e2 = entry(broadcastId, sourceId, {
      timestamp: baseTs + 60_000,
      data: { content: "second", subjectTime: "18" },
    });

    const { feed, setEntries } = mutableFakeFeed([...ambient, e1]);
    const engine = new NarrativeEngine(broadcastId, feed, subscribers, llm, tracker);

    const out1 = await engine.driveGeneration(basicCurated(broadcastId, [e1]));
    assert.ok(out1, "first cycle should return a NarrativeOutput");
    assert.equal(out1.contentTime, 23);

    // Second cycle: feed snapshot now also includes e2; the batch
    // filter (entries strictly newer than the first cycle's
    // `triggeredAt`) yields only e2, whose subjectTime is 18 —
    // earlier than the 23 floor. Clamp should pin emitted
    // contentTime to 23.
    setEntries([...ambient, e1, e2]);
    llm.setNarratorResponse(toolUseResponse({ prose: NARRATOR_PROSE, covers: [] }));
    const out2 = await engine.driveGeneration(basicCurated(broadcastId, [e2]));
    assert.ok(out2);
    assert.equal(out2.contentTime, 23, "regressing batch must clamp to the floor");

    // Three persisted rows the engine touched — narrative for both
    // cycles. The second one's contentTime is the clamp result,
    // not the raw 18.
    const narratives = sent.filter((s) => s.parsed.type === "narrative");
    assert.equal(narratives.length, 2);

    await engine.drainPendingWork();
  });

  it("advances the floor when contentTime moves forward", async () => {
    const { broadcastId, sourceId } = await setupBroadcast();
    const llm = new StubLLMClient([]);
    llm.setNarratorResponse(toolUseResponse({ prose: NARRATOR_PROSE, covers: [] }));
    const tracker = new BroadcastStateTracker(broadcastId, {} as ServiceRegistry);
    const { set: subscribers } = recordingSubscribers();

    const baseTs = Date.now();
    const ambient = ambientEntries(broadcastId, sourceId);
    const e1 = entry(broadcastId, sourceId, { timestamp: baseTs - 5_000, data: { content: "a", subjectTime: "23" } });
    const e2 = entry(broadcastId, sourceId, { timestamp: baseTs + 60_000, data: { content: "b", subjectTime: "47" } });

    const { feed, setEntries } = mutableFakeFeed([...ambient, e1]);
    const engine = new NarrativeEngine(broadcastId, feed, subscribers, llm, tracker);

    const o1 = await engine.driveGeneration(basicCurated(broadcastId, [e1]));
    assert.equal(o1?.contentTime, 23);

    setEntries([...ambient, e1, e2]);
    llm.setNarratorResponse(toolUseResponse({ prose: NARRATOR_PROSE, covers: [] }));
    const o2 = await engine.driveGeneration(basicCurated(broadcastId, [e2]));
    assert.equal(o2?.contentTime, 47, "forward-moving batch advances the floor");

    await engine.drainPendingWork();
  });
});

describe("NarrativeEngine — pacing precedence", () => {
  it("uses pacing.recommendedWordCount over the cycleDurationMs-derived target", async () => {
    const { broadcastId, sourceId } = await setupBroadcast();
    const llm = new StubLLMClient([]);
    llm.setNarratorResponse(toolUseResponse({ prose: NARRATOR_PROSE, covers: [] }));
    const tracker = new BroadcastStateTracker(broadcastId, {} as ServiceRegistry);
    const { set: subscribers } = recordingSubscribers();

    const entries = [entry(broadcastId, sourceId, { data: { content: "x", subjectTime: "23" } })];
    const engine = new NarrativeEngine(
      broadcastId,
      fakeFeed([...ambientEntries(broadcastId, sourceId), ...entries]),
      subscribers,
      llm,
      tracker,
      { cycleDurationMs: 30_000, narrationWpm: 150, utilization: 0.8 },
    );

    const curated = basicCurated(broadcastId, entries, {
      context: {
        ...basicCurated(broadcastId, entries).context,
        pacing: { recommendedWordCount: 42, cadenceMs: 30_000 },
      },
    });

    const out = await engine.driveGeneration(curated);
    assert.ok(out);

    const [row] = await db
      .select()
      .from(generations)
      .where(eq(generations.id, out.id));
    const ctxPkg = row.contextPackage as { targetWords?: number; wpmSource?: string };
    assert.equal(ctxPkg.targetWords, 42, "pacing wordCount wins over config-derived");
    assert.equal(ctxPkg.wpmSource, "pacing");

    // And the generator received the same target — assert via the
    // recorded LLM request's user message (the generator embeds
    // `target=Nw` only when the cycle carries a pacing decision).
    const narratorCall = llm.calls.find((c) =>
      (c.tools ?? []).some((t) => t.name === "deliver_narrative"),
    );
    assert.ok(narratorCall);
    const userMessage =
      typeof narratorCall.messages[0].content === "string"
        ? narratorCall.messages[0].content
        : JSON.stringify(narratorCall.messages[0].content);
    assert.match(userMessage, /42\s+words/i, "user message should signal the 42-word pacing target");

    await engine.drainPendingWork();
  });

  it("falls back to the config-derived target when pacing.recommendedWordCount is zero", async () => {
    const { broadcastId, sourceId } = await setupBroadcast();
    const llm = new StubLLMClient([]);
    llm.setNarratorResponse(toolUseResponse({ prose: NARRATOR_PROSE, covers: [] }));
    const tracker = new BroadcastStateTracker(broadcastId, {} as ServiceRegistry);
    const { set: subscribers } = recordingSubscribers();

    const entries = [entry(broadcastId, sourceId, { data: { content: "x", subjectTime: "23" } })];
    const engine = new NarrativeEngine(
      broadcastId,
      fakeFeed([...ambientEntries(broadcastId, sourceId), ...entries]),
      subscribers,
      llm,
      tracker,
      { cycleDurationMs: 30_000, narrationWpm: 150, utilization: 0.8 },
    );

    const out = await engine.driveGeneration(basicCurated(broadcastId, entries));
    assert.ok(out);

    const [row] = await db.select().from(generations).where(eq(generations.id, out.id));
    const ctxPkg = row.contextPackage as { targetWords?: number; wpmSource?: string };
    // 30s × 150wpm × 0.8 / 60 = 60 words.
    assert.equal(ctxPkg.targetWords, 60);
    assert.equal(ctxPkg.wpmSource, "config");

    await engine.drainPendingWork();
  });
});

describe("NarrativeEngine — drainBoundaryOrdinal filters canonical events", () => {
  it("only includes canonical events at or before the drain boundary", async () => {
    const { broadcastId, sourceId } = await setupBroadcast();
    const llm = new StubLLMClient([]);
    llm.setNarratorResponse(toolUseResponse({ prose: NARRATOR_PROSE, covers: [] }));
    const tracker = new BroadcastStateTracker(broadcastId, {} as ServiceRegistry);
    const { set: subscribers } = recordingSubscribers();

    // Three canonical events, subjectTimes 10, 20, 30 — ordinals
    // computed from phase "live_first_half" + phaseSecond derived
    // from the minute (subjectOrdinalForEntry walks phase+phaseSecond).
    // The runtime path stamps phase/phaseSecond on the entry's `data`;
    // we mirror that here so subjectOrdinalForEntry returns a sensible
    // ordering.
    function canonical(id: string, minute: number): FeedEntry {
      return entry(broadcastId, sourceId, {
        id,
        data: {
          content: `goal-marker-${minute}`,
          subjectTime: `${minute}`,
          phase: "live_first_half",
          phaseSecond: minute * 60,
          eventClass: "GOAL",
        },
      });
    }
    const allEntries = [canonical("e-10", 10), canonical("e-20", 20), canonical("e-30", 30)];

    // drainBoundaryOrdinal at the ordinal of minute 20. Anything past
    // it should drop out of the canonical-events preamble. Compute
    // via `subjectOrdinalForEntry` so the live PHASE_BASE table is
    // the source of truth.
    const drainBoundary = subjectOrdinalForEntry(allEntries[1]) as number;
    assert.ok(drainBoundary != null, "minute 20 must have a computable ordinal");

    // Curated entry uses a distinct content marker so its appearance
    // in the user message doesn't pollute the canonical-events
    // assertion. The cycle narrates `cycle-narrate-target`; the
    // canonical preamble carries `goal-marker-N` only when the
    // entry survives the drain-boundary filter.
    const curatedEntry = entry(broadcastId, sourceId, {
      id: "cycle-target",
      sourceCanonical: false,
      data: {
        content: "cycle-narrate-target",
        subjectTime: "10",
        phase: "live_first_half",
        phaseSecond: 600,
      },
    });

    const engine = new NarrativeEngine(
      broadcastId,
      fakeFeed([...ambientEntries(broadcastId, sourceId), ...allEntries, curatedEntry]),
      subscribers,
      llm,
      tracker,
    );

    const curated = basicCurated(broadcastId, [curatedEntry], { drainBoundaryOrdinal: drainBoundary });
    const out = await engine.driveGeneration(curated);
    assert.ok(out);

    // The narrator's system prompt + user message carry the
    // canonical-events preamble. Inspect the recorded call.
    const narratorCall = llm.calls.find((c) =>
      (c.tools ?? []).some((t) => t.name === "deliver_narrative"),
    );
    assert.ok(narratorCall);
    const systemText = (narratorCall.system ?? []).map((s) => s.text).join("\n");
    const userText =
      typeof narratorCall.messages[0].content === "string"
        ? narratorCall.messages[0].content
        : "";
    const combined = `${systemText}\n${userText}`;

    // Events at minute 10 and 20 (≤ boundary) included; minute 30
    // (after boundary) excluded.
    assert.match(combined, /goal-marker-10/, "event at minute 10 should appear");
    assert.match(combined, /goal-marker-20/, "event at minute 20 should appear");
    assert.doesNotMatch(combined, /goal-marker-30/, "event at minute 30 must be filtered");

    await engine.drainPendingWork();
  });
});

describe("NarrativeEngine — LLMRateLimitError handling", () => {
  it("emits generation_skipped and persists no row when the narrator rate-limits", async () => {
    const { broadcastId, sourceId } = await setupBroadcast();
    const llm = new StubLLMClient([]);
    llm.setNarratorResponse(new LLMRateLimitError(5000, "rate-limited"));
    const tracker = new BroadcastStateTracker(broadcastId, {} as ServiceRegistry);
    const { set: subscribers, sent } = recordingSubscribers();

    const entries = [entry(broadcastId, sourceId, { data: { content: "x", subjectTime: "23" } })];
    const engine = new NarrativeEngine(
      broadcastId,
      fakeFeed([...ambientEntries(broadcastId, sourceId), ...entries]),
      subscribers,
      llm,
      tracker,
    );

    const out = await engine.driveGeneration(
      basicCurated(broadcastId, entries, { triggerReason: "accumulation" }),
    );
    assert.equal(out, null, "rate-limit yields a null NarrativeOutput");

    const skipped = sent.find((s) => s.parsed.type === "generation_skipped");
    assert.ok(skipped, "expected a generation_skipped WS message");
    assert.equal((skipped.parsed as { reason: string }).reason, "rate_limited");
    assert.equal((skipped.parsed as { retryAfterMs: number }).retryAfterMs, 5000);
    assert.equal((skipped.parsed as { triggerReason: string }).triggerReason, "accumulation");

    const narratives = sent.filter((s) => s.parsed.type === "narrative");
    assert.equal(narratives.length, 0, "no narrative message should fire on rate-limit");

    const persisted = await db
      .select()
      .from(generations)
      .where(eq(generations.broadcastId, broadcastId));
    assert.equal(persisted.length, 0, "no generations row should be inserted on rate-limit");

    await engine.drainPendingWork();
  });
});
