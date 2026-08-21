import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  createTestContext,
  resetRuntimeData,
  closeConnection,
  jsonBody,
  patchBody,
  sql,
  type TestContext,
} from "./helpers.js";
import { ensureRuntime, stopRuntime } from "../src/broadcast.js";
import { LLMRateLimitError } from "../src/llm/types.js";
import { toolUseResponse } from "../src/llm/stub.js";

const FOOTBALL_PROSE = "The whistle had blown and the game began under the floodlights.";

/** A pipeline cycle now flows through curation before reaching the narrator,
 * so a single `narrative/generate` call drives a variable number of LLM
 * calls (6 enrichment + LLM-driven curator services + the narrator).
 * Tests that want to assert on the narrator's request locate it by the
 * `deliver_narrative` tool — its position in the call log shifts as the
 * curator/enrichment surface evolves. */
function findNarratorCall(calls: TestContext["llm"]["calls"]): TestContext["llm"]["calls"][number] | undefined {
  return calls.find((c) => (c.tools ?? []).some((t) => t.name === "deliver_narrative"));
}

const fullSources = [
  { name: "match_events", type: "event", canonical: true, enrichment_tags: ["momentum", "themes"] },
  { name: "moderator", type: "moderator" },
  { name: "narrative_context", type: "narrative_context" },
  { name: "narrative_voice", type: "narrative_voice" },
];

let ctx: TestContext;

const DEFAULT_VOICE_BRIEF = "Spare, unsentimental prose. Past tense. Short sentences. Concrete details.";
const DEFAULT_CONTEXT_BRIEF = "Championship play-off: Blackburn Rovers vs Coventry City.";
/** Anchor ambient seeds well before any test's event timestamps so
 *  range and count assertions for event data aren't perturbed. */
const AMBIENT_SEED_TIMESTAMP = 1_000_000;

async function createActiveBroadcast(
  briefs: { voice?: string; context?: string } = {},
): Promise<string> {
  const created = await ctx.fetch(
    "/broadcasts",
    jsonBody({ event_profile: "sporting_event", sources: fullSources }),
  );
  assert.equal(created.status, 201);
  const { broadcast } = await created.json() as { broadcast: { id: string } };

  // Seed voice and context before activation so the gate is satisfied.
  await ctx.fetch(
    `/broadcasts/${broadcast.id}/entries`,
    jsonBody({
      source: "narrative_voice",
      data: { content: briefs.voice ?? DEFAULT_VOICE_BRIEF },
      timestamp: AMBIENT_SEED_TIMESTAMP,
    }),
  );
  await ctx.fetch(
    `/broadcasts/${broadcast.id}/entries`,
    jsonBody({
      source: "narrative_context",
      data: { content: briefs.context ?? DEFAULT_CONTEXT_BRIEF },
      timestamp: AMBIENT_SEED_TIMESTAMP,
    }),
  );

  const activated = await ctx.fetch(`/broadcasts/${broadcast.id}`, patchBody({ status: "active" }));
  assert.equal(activated.status, 200);

  // Activation runs the brief initialisation pass — one Haiku call per
  // opt-in enrichment service plus one for ContextCurator's thread
  // inventory. Tests that assert on `ctx.llm.calls` care about what
  // happens *after* activation, not the priors-seeding noise from it,
  // so clear the call log here. The scripted-response queue stays
  // intact so tests can keep using whatever they seeded in beforeEach.
  ctx.llm.clearCalls();

  return broadcast.id;
}

describe("persistence integration", () => {
  before(async () => {
    ctx = await createTestContext([
      { text: FOOTBALL_PROSE, usage: { inputTokens: 100, outputTokens: 50 } },
      { text: FOOTBALL_PROSE, usage: { inputTokens: 100, outputTokens: 50 } },
    ]);
  });

  beforeEach(async () => {
    await resetRuntimeData();
    // Each cycle makes ~14 LLM calls (6 enrichment + 6 curation + narrative
    // + summary update). Seed a generous pool so tests that drive multiple
    // cycles don't exhaust the stub mid-pipeline. Services gracefully
    // degrade when the stub returns a plain {text, usage} (no tool call) —
    // they log and return prior context — so these responses work for all
    // service types; the test only asserts that generation persists.
    ctx.llm.reset(Array.from({ length: 50 }, () => ({
      text: FOOTBALL_PROSE,
      usage: { inputTokens: 100, outputTokens: 50 },
    })));
  });

  after(async () => {
    await resetRuntimeData();
    await closeConnection();
  });

  it("exposes seeded platform content", async () => {
    const profile = await ctx.fetch("/profiles/sporting_event").then((r) => r.json()) as {
      name: string;
      enrichmentServices: string[];
    };
    assert.equal(profile.name, "sporting_event");
    assert.equal(profile.enrichmentServices.length, 6);

    const specs = await ctx.fetch("/specs/momentum/sporting_event").then((r) => r.json()) as {
      versions: Array<{ status: string }>;
    };
    assert.equal(specs.versions[0].status, "experimental");
  });

  it("requires event_profile when creating a broadcast", async () => {
    const res = await ctx.fetch("/broadcasts", jsonBody({ sources: fullSources }));
    assert.equal(res.status, 400);
    const body = await res.json() as { error: string };
    assert.match(body.error, /event_profile/);
  });

  it("creates broadcasts pending with resolved specs", async () => {
    const res = await ctx.fetch(
      "/broadcasts",
      jsonBody({ event_profile: "sporting_event", sources: fullSources }),
    );
    assert.equal(res.status, 201);

    const body = await res.json() as {
      broadcast: { status: string };
      sources: unknown[];
      resolvedSpecs: unknown[];
    };
    assert.equal(body.broadcast.status, "pending");
    assert.equal(body.sources.length, 4);
    // 6 enrichment + 8 curation services in the sporting_event profile;
    // see apps/kairos/server/src/db/seed.ts. Update both together when the
    // service list grows.
    assert.equal(body.resolvedSpecs.length, 14);
  });

  it("rejects entries against a pending broadcast", async () => {
    const { broadcast } = await ctx
      .fetch("/broadcasts", jsonBody({ event_profile: "sporting_event", sources: fullSources }))
      .then((r) => r.json()) as { broadcast: { id: string } };

    const res = await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "match_events", data: { content: "goal", minute: 10 } }),
    );
    assert.equal(res.status, 409);
  });

  it("allows narrative_voice and narrative_context pushes while pending", async () => {
    const { broadcast } = await ctx
      .fetch("/broadcasts", jsonBody({ event_profile: "sporting_event", sources: fullSources }))
      .then((r) => r.json()) as { broadcast: { id: string } };

    const voicePush = await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "narrative_voice", data: { content: "Voice brief." } }),
    );
    assert.equal(voicePush.status, 201);

    const contextPush = await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "narrative_context", data: { content: "Context brief." } }),
    );
    assert.equal(contextPush.status, 201);

    // Event pushes are still rejected until activation — the curator
    // pipeline isn't running, and we don't want to accumulate event
    // data against a broadcast the moderator hasn't started.
    const eventPush = await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Early goal?", minute: 0 } }),
    );
    assert.equal(eventPush.status, 409);
  });

  it("refuses to activate when narrative_voice or narrative_context has no entries", async () => {
    const { broadcast } = await ctx
      .fetch("/broadcasts", jsonBody({ event_profile: "sporting_event", sources: fullSources }))
      .then((r) => r.json()) as { broadcast: { id: string } };

    // Only seed context — voice has no entries.
    await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "narrative_context", data: { content: "Context only." } }),
    );

    const res = await ctx.fetch(`/broadcasts/${broadcast.id}`, patchBody({ status: "active" }));
    assert.equal(res.status, 422);
    const body = await res.json() as { error: string };
    assert.match(body.error, /narrative_voice/);
  });

  it("refuses to activate when narrative_voice content is blank", async () => {
    const { broadcast } = await ctx
      .fetch("/broadcasts", jsonBody({ event_profile: "sporting_event", sources: fullSources }))
      .then((r) => r.json()) as { broadcast: { id: string } };

    await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "narrative_voice", data: { content: "   " } }),
    );
    await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "narrative_context", data: { content: "Context." } }),
    );

    const res = await ctx.fetch(`/broadcasts/${broadcast.id}`, patchBody({ status: "active" }));
    assert.equal(res.status, 422);
  });

  it("refuses to activate without narrative_context and narrative_voice", async () => {
    const { broadcast } = await ctx
      .fetch("/broadcasts", jsonBody({
        event_profile: "sporting_event",
        sources: [{ name: "match_events", type: "event" }],
      }))
      .then((r) => r.json()) as { broadcast: { id: string } };

    const res = await ctx.fetch(`/broadcasts/${broadcast.id}`, patchBody({ status: "active" }));
    assert.equal(res.status, 422);
  });

  it("persists entries with inherited enrichment tags", async () => {
    const id = await createActiveBroadcast();

    for (let i = 1; i <= 3; i++) {
      const res = await ctx.fetch(
        `/broadcasts/${id}/entries`,
        jsonBody({ source: "match_events", data: { content: `Entry ${i}`, minute: i } }),
      );
      assert.equal(res.status, 201);
    }

    const all = await ctx.fetch(`/broadcasts/${id}/entries?source=match_events`).then((r) => r.json()) as {
      entries: Array<{ sourceName: string; enrichmentTags: string[] }>;
    };
    assert.equal(all.entries.length, 3);
    assert.deepEqual(all.entries[0].enrichmentTags, ["momentum", "themes"]);

    const filtered = await ctx.fetch(`/broadcasts/${id}/entries?tag=momentum`).then((r) => r.json()) as {
      entries: unknown[];
    };
    assert.equal(filtered.entries.length, 3);

    const unmatched = await ctx.fetch(`/broadcasts/${id}/entries?tag=tension_conflict`).then((r) => r.json()) as {
      entries: unknown[];
    };
    assert.equal(unmatched.entries.length, 0);
  });

  it("filters feed entries by source name and timestamp range", async () => {
    const id = await createActiveBroadcast();

    const before = Date.now();
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Early" }, timestamp: before - 10_000 }),
    );
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Recent" }, timestamp: before }),
    );
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "moderator", data: { content: "Note from mod" } }),
    );

    const bySource = await ctx
      .fetch(`/broadcasts/${id}/entries?source=moderator`)
      .then((r) => r.json()) as { entries: Array<{ sourceName: string }> };
    assert.equal(bySource.entries.length, 1);
    assert.equal(bySource.entries[0].sourceName, "moderator");

    const byRange = await ctx
      .fetch(`/broadcasts/${id}/entries?from=${before - 5_000}&to=${before + 5_000}`)
      .then((r) => r.json()) as { entries: Array<{ data: { content: string } }> };
    assert.equal(byRange.entries.length, 2); // "Recent" + "Note from mod"
    assert.ok(byRange.entries.every((e) => e.data.content !== "Early"));
  });

  it("generates narrative via the stub LLM and persists it", async () => {
    const id = await createActiveBroadcast();

    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Kickoff", minute: 0 } }),
    );

    const res = await ctx.fetch(`/broadcasts/${id}/narrative/generate`, jsonBody({ consumerPrompt: "## Test\n\nA test preamble." }));
    assert.equal(res.status, 200);

    // External-cycle route is fire-and-forget over HTTP — the narrative
    // is persisted by the curator's onCurated handler before the route
    // resolves, but it lands in the DB / WS stream rather than in the
    // HTTP body. Fetch the persisted generation to assert on its
    // contents.
    const generations = await ctx.fetch(`/broadcasts/${id}/generations`).then((r) => r.json()) as {
      generations: Array<{ output: string; tokenUsage?: { inputTokens?: number } }>;
    };
    assert.equal(generations.generations.length, 1);
    assert.equal(generations.generations[0].output, FOOTBALL_PROSE);
    assert.equal(generations.generations[0].tokenUsage?.inputTokens, 100);

    // External cycles flow through enrichment + curation before reaching
    // the narrator (~13 LLM calls per cycle, plus a follow-up summary
    // update fired off the critical path). Drain pending work so the
    // summary call has landed, then locate the narrator request by tool
    // — its position in the log moves as the curator/enrichment surface
    // changes.
    const runtime = await ensureRuntime(id);
    assert.ok(runtime);
    await runtime.narrative.drainPendingWork();
    const narratorCall = findNarratorCall(ctx.llm.calls);
    assert.ok(narratorCall, "expected a narrator call with the deliver_narrative tool");
    const rawSystem0 = narratorCall.system;
    const system0 = typeof rawSystem0 === "string"
      ? rawSystem0
      : (rawSystem0 ?? []).map((s) => s.text).join("\n\n");
    assert.match(system0, /# Voice/);
    assert.match(system0, /# Task/);
    assert.match(system0, /deliver_narrative/);

    const history = await ctx.fetch(`/broadcasts/${id}/generations`).then((r) => r.json()) as {
      generations: Array<{ output: string; wordCount: number; triggerReason: string }>;
    };
    assert.equal(history.generations.length, 1);
    assert.equal(history.generations[0].output, FOOTBALL_PROSE);
    assert.equal(history.generations[0].triggerReason, "external");
    assert.ok(history.generations[0].wordCount > 0);
  });

  it("rehydrates runtime state after stop and re-reference", async () => {
    const id = await createActiveBroadcast();

    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Kickoff", minute: 0 } }),
    );
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Goal", minute: 10 } }),
    );

    // Mutate one enrichment service's state and persist it, so we can
    // verify rehydration restores more than just defaults.
    const runtimeBefore = await ensureRuntime(id);
    assert.ok(runtimeBefore);
    const momentumService = runtimeBefore.registry
      .getEnrichmentServices()
      .find((s) => s.name === "momentum");
    assert.ok(momentumService);
    const overrideReading = { direction: "rising", intensity: "high" };
    momentumService.hydrateStates(
      { "subj-overall": { label: "the scene", reading: overrideReading } },
      { "subj-overall": { label: "the scene", reading: overrideReading } },
      {},
    );
    await runtimeBefore.registry.persistEnrichmentStates();

    // Simulate a server restart by dropping the in-process runtime.
    stopRuntime(id);

    // First reference after restart — runtime should rehydrate.
    const runtime = await ensureRuntime(id);
    assert.ok(runtime, "expected runtime to rehydrate");
    // 2 seeded ambient entries + 2 pushed match_events = 4.
    assert.equal(runtime.feed.getAll().length, 4);

    const momentumAfter = runtime.pipeline
      .getSnapshots()
      .find((s) => s.name === "momentum");
    assert.ok(momentumAfter);
    assert.equal(momentumAfter.ready, true);
    assert.deepEqual(momentumAfter.expressed?.["subj-overall"]?.reading, overrideReading);
    assert.deepEqual(momentumAfter.unexpressed?.["subj-overall"]?.reading, overrideReading);
  });

  it("fires curator-driven generation when the pipeline flushes", async () => {
    const id = await createActiveBroadcast();
    const { getRuntime } = await import("../src/broadcast.js");
    const runtime = getRuntime(id);
    assert.ok(runtime);

    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Goal", minute: 12 } }),
    );

    // Directly flush the pipeline — same path the internal timer takes.
    await runtime.pipeline.flush();

    const history = await ctx.fetch(`/broadcasts/${id}/generations`).then((r) => r.json()) as {
      generations: Array<{ triggerReason: string }>;
    };
    assert.equal(history.generations.length, 1);
    assert.equal(history.generations[0].triggerReason, "accumulation");
  });

  it("hands the generator exactly the curator's selection — no parallel assembly", async () => {
    // Post-refactor contract: curation is the only authority on drops.
    // The persisted cycle's curation.selectedEntryIds must be identical
    // to the generation's contextPackage.includedEntryIds — no entry
    // enters the generator's context that the curator didn't choose,
    // and every entry the curator chose reaches the generator.
    const id = await createActiveBroadcast();
    const { getRuntime } = await import("../src/broadcast.js");
    const runtime = getRuntime(id);
    assert.ok(runtime);

    for (const minute of [10, 12, 14]) {
      await ctx.fetch(
        `/broadcasts/${id}/entries`,
        jsonBody({
          source: "match_events",
          data: { content: `Event at ${minute}`, minute },
        }),
      );
    }

    await runtime.pipeline.flush();

    const { cycles } = await ctx.fetch(`/broadcasts/${id}/cycles`).then((r) => r.json()) as {
      cycles: Array<{ id: string; generationId: string | null }>;
    };
    assert.equal(cycles.length, 1);
    const [cycle] = cycles;
    assert.ok(cycle.generationId, "expected the cycle to have produced a generation");

    const cycleDetail = await ctx.fetch(`/broadcasts/${id}/cycles/${cycle.id}`).then((r) => r.json()) as {
      curation: { selectedEntryIds: string[] };
    };
    const generation = await ctx.fetch(`/broadcasts/${id}/generations/${cycle.generationId}`).then((r) => r.json()) as {
      contextPackage: { includedEntryIds: string[] };
    };

    assert.deepEqual(
      [...cycleDetail.curation.selectedEntryIds].sort(),
      [...generation.contextPackage.includedEntryIds].sort(),
      "generator context must match curated selection exactly",
    );
  });

  it("enforces the token budget at the curation stage and keeps canonical entries", async () => {
    // Post-refactor: the token ceiling is curation's responsibility
    // (budget_reconciler runs last in the chain, evicts lowest-priority
    // first, never evicts canonical entries). Replaces the retired
    // assemble-stage oldest-first eviction.
    const created = await ctx.fetch(
      "/broadcasts",
      jsonBody({
        event_profile: "sporting_event",
        sources: fullSources,
        // Tiny ceiling — ~200 tokens is well below what the moderator
        // chatter below costs, so budget_reconciler is forced to fire.
        config: { generator: { max_context_tokens: 200 } },
      }),
    );
    assert.equal(created.status, 201);
    const { broadcast } = await created.json() as { broadcast: { id: string } };

    await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({
        source: "narrative_voice",
        data: { content: DEFAULT_VOICE_BRIEF },
        timestamp: AMBIENT_SEED_TIMESTAMP,
      }),
    );
    await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({
        source: "narrative_context",
        data: { content: DEFAULT_CONTEXT_BRIEF },
        timestamp: AMBIENT_SEED_TIMESTAMP,
      }),
    );
    await ctx.fetch(`/broadcasts/${broadcast.id}`, patchBody({ status: "active" }));

    const { getRuntime } = await import("../src/broadcast.js");
    const runtime = getRuntime(broadcast.id);
    assert.ok(runtime);

    // One canonical event (never evicted) plus eight chunky moderator
    // entries that collectively blow past the budget.
    const goalRes = await ctx.fetch(
      `/broadcasts/${broadcast.id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Goal, Oliveira", minute: 67 } }),
    );
    const goalEntry = await goalRes.json() as { id: string };

    const moderatorIds: string[] = [];
    for (let i = 0; i < 8; i++) {
      const mod = await ctx.fetch(
        `/broadcasts/${broadcast.id}/entries`,
        jsonBody({
          source: "moderator",
          data: {
            content:
              "A long moderator remark intended to consume a decent slice of the token budget so that at least a handful of these are evicted by the curator's budget reconciler when the cycle runs.",
          },
        }),
      );
      const entry = await mod.json() as { id: string };
      moderatorIds.push(entry.id);
    }

    await runtime.pipeline.flush();

    const { cycles } = await ctx.fetch(`/broadcasts/${broadcast.id}/cycles`).then((r) => r.json()) as {
      cycles: Array<{ id: string; generationId: string | null }>;
    };
    assert.equal(cycles.length, 1);
    const [cycle] = cycles;

    const cycleDetail = await ctx.fetch(`/broadcasts/${broadcast.id}/cycles/${cycle.id}`).then((r) => r.json()) as {
      curation: {
        selectedEntryIds: string[];
        decisions: Record<string, { entriesRemoved?: string[]; meta?: { totalCostAfter?: number; maxContextTokens?: number } }>;
      };
    };

    const reconciler = cycleDetail.curation.decisions.budget_reconciler;
    assert.ok(reconciler, "expected budget_reconciler to record its decision");
    assert.ok(
      (reconciler.entriesRemoved?.length ?? 0) > 0,
      "expected budget_reconciler to evict at least one entry under the tight budget",
    );
    assert.ok(
      (reconciler.meta?.totalCostAfter ?? Infinity) <= (reconciler.meta?.maxContextTokens ?? 0),
      "kept entries must fit under the budget ceiling",
    );

    const selected = new Set(cycleDetail.curation.selectedEntryIds);
    assert.ok(selected.has(goalEntry.id), "canonical entry must never be evicted");
    const removed = new Set(reconciler.entriesRemoved);
    assert.ok(!removed.has(goalEntry.id), "canonical entry must not appear in entriesRemoved");
    assert.ok(
      moderatorIds.some((mid) => removed.has(mid)),
      "eviction must target plain-priority moderator entries, not canonical events",
    );
  });

  it("caps consecutive empty-buffer cycles at the pipeline level", async () => {
    const id = await createActiveBroadcast();
    const { getRuntime } = await import("../src/broadcast.js");
    const runtime = getRuntime(id);
    assert.ok(runtime);

    // Curator no longer short-circuits empty cycles (per 2026-05-02
    // direction: silence is not a valid outcome — context_led mode
    // pulls from accumulated character/world context). The pipeline
    // is now the single authority on stopping silent broadcasts: it
    // runs the first N empty cycles through curation + generation,
    // then caps. Default cap is 2.

    // First empty cycle: curator runs, narrator is invoked.
    const callsBefore1 = ctx.llm.calls.length;
    await runtime.pipeline.flush();
    assert.ok(
      ctx.llm.calls.length > callsBefore1,
      "empty cycle 1: curator runs through enrichment + generation — LLM calls expected",
    );

    // Second empty cycle: same.
    const callsBefore2 = ctx.llm.calls.length;
    await runtime.pipeline.flush();
    assert.ok(
      ctx.llm.calls.length > callsBefore2,
      "empty cycle 2: still under the cap, runs again",
    );

    // Third empty cycle: cap reached, pipeline returns null without
    // calling enrichment / curator / generator.
    const callsBefore3 = ctx.llm.calls.length;
    const cappedReturn = await runtime.pipeline.flush();
    assert.equal(cappedReturn, null, "third empty cycle returns null (cap reached)");
    assert.equal(
      ctx.llm.calls.length,
      callsBefore3,
      "cap fires before any service runs — LLM call count must not change",
    );

    // A real entry resets the counter and fires an accumulation cycle.
    const callsBefore4 = ctx.llm.calls.length;
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Kickoff", minute: 0 } }),
    );
    await runtime.pipeline.flush();
    assert.ok(
      ctx.llm.calls.length > callsBefore4,
      "non-empty cycle resets the counter and runs",
    );
  });

  it("records consumer pacing feedback on the state tracker", async () => {
    const id = await createActiveBroadcast();
    const { getRuntime } = await import("../src/broadcast.js");
    const runtime = getRuntime(id);
    assert.ok(runtime);

    const res = await ctx.fetch(
      `/broadcasts/${id}/feedback`,
      jsonBody({ signal: "slow_down", words_per_minute: 135 }),
    );
    assert.equal(res.status, 200);

    const latest = runtime.stateTracker.getLatestPacingSignal();
    assert.ok(latest);
    assert.equal(latest.signal, "slow_down");
    assert.equal(latest.wordsPerMinute, 135);
  });

  it("rejects invalid feedback signals", async () => {
    const id = await createActiveBroadcast();

    const badSignal = await ctx.fetch(
      `/broadcasts/${id}/feedback`,
      jsonBody({ signal: "hurry_up", words_per_minute: 120 }),
    );
    assert.equal(badSignal.status, 400);

    const badWpm = await ctx.fetch(
      `/broadcasts/${id}/feedback`,
      jsonBody({ signal: "on_track", words_per_minute: -1 }),
    );
    assert.equal(badWpm.status, 400);
  });

  it("uses narrative_voice and narrative_context entries as the system prompt", async () => {
    const id = await createActiveBroadcast();

    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "narrative_voice", data: { content: "Write in spare, unsentimental prose." } }),
    );
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "narrative_context", data: { content: "Blackburn Rovers v Coventry City, Championship play-off." } }),
    );
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Kickoff", minute: 0 } }),
    );

    ctx.llm.setNarratorResponse(toolUseResponse({ prose: "The match began.", covers: [] }));
    const res = await ctx.fetch(`/broadcasts/${id}/narrative/generate`, jsonBody({ consumerPrompt: "## Test\n\nA test preamble." }));
    assert.equal(res.status, 200);

    const narratorCall = findNarratorCall(ctx.llm.calls);
    assert.ok(narratorCall, "expected a narrator call with the deliver_narrative tool");
    const rawSystem = narratorCall.system;
    const system = typeof rawSystem === "string"
      ? rawSystem
      : (rawSystem ?? []).map((s) => s.text).join("\n\n");
    assert.match(system, /Write in spare, unsentimental prose\./);
    assert.match(system, /Championship play-off/);
    // Fallback voice is not used when real voice content is supplied.
    assert.doesNotMatch(system, /Ernest Hemingway/);
  });

  it("persists and emits the narrator's covers list when the tool is used", async () => {
    const id = await createActiveBroadcast();

    const entryRes = await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Goal, Oliveira", minute: 67, subjectTime: "67+2" } }),
    );
    const entry = await entryRes.json() as { id: string };

    ctx.llm.setNarratorResponse(toolUseResponse({
      prose: "Oliveira struck it home.",
      covers: [
        { entryId: entry.id, subjectTime: "67+2" },
        { entryId: "not-a-real-id", subjectTime: "99+9" },
      ],
    }));

    const runtime = await ensureRuntime(id);
    assert.ok(runtime);
    const delivered: string[] = [];
    const fakeWs = { send: (m: string) => delivered.push(m), close: () => {}, on: () => {} };
    runtime.subscribers.add(fakeWs as never);

    const res = await ctx.fetch(`/broadcasts/${id}/narrative/generate`, jsonBody({ consumerPrompt: "## Test\n\nA test preamble." }));
    assert.equal(res.status, 200);

    // Covers are persisted by the curator's onCurated handler before
    // pipeline.flush resolves; fetch the generation to assert the
    // phantom-cover filter dropped the bogus entry id.
    const generations = await ctx.fetch(`/broadcasts/${id}/generations`).then((r) => r.json()) as {
      generations: Array<{ covers: Array<{ entryId: string; subjectTime?: string }> }>;
    };
    assert.equal(generations.generations.length, 1);
    const body = generations.generations[0];
    assert.equal(body.covers.length, 1, "phantom ids must be dropped");
    assert.equal(body.covers[0].entryId, entry.id);
    assert.equal(body.covers[0].subjectTime, "67+2");

    const history = await ctx.fetch(`/broadcasts/${id}/generations`).then((r) => r.json()) as {
      generations: Array<{ covers: Array<{ entryId: string; subjectTime?: string }> }>;
    };
    assert.equal(history.generations[0].covers.length, 1);
    assert.equal(history.generations[0].covers[0].entryId, entry.id);

    const wsNarrative = delivered.map((m) => JSON.parse(m)).find((m) => m.type === "narrative");
    assert.ok(wsNarrative, "expected narrative WS message");
    assert.equal(wsNarrative.narrative.covers.length, 1);
    assert.equal(wsNarrative.narrative.covers[0].entryId, entry.id);
  });

  // Deleted 2026-04-24 alongside the removal of the "inactive source"
  // concept — no code path ever set a source inactive, and the engine
  // no longer filters on the flag. Source inclusion is defined by what
  // is attached to the broadcast, not by a secondary enabled/disabled
  // gate.

  it("skips generation and notifies subscribers when the LLM rate-limits", async () => {
    const id = await createActiveBroadcast();

    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Kickoff", minute: 0 } }),
    );

    ctx.llm.setNarratorResponse(new LLMRateLimitError(12_000, "rate limited"));

    const runtime = await ensureRuntime(id);
    assert.ok(runtime);

    const delivered: string[] = [];
    const fakeWs = {
      send: (msg: string) => { delivered.push(msg); },
      close: () => {},
      on: () => {},
    };
    runtime.subscribers.add(fakeWs as never);

    const res = await ctx.fetch(
      `/broadcasts/${id}/narrative/generate`,
      jsonBody({ consumerPrompt: "## Test\n\nA test preamble." }),
    );
    // External-cycle path runs through curation; rate-limit hit during
    // generation surfaces as a 200 "no new content" response (the
    // route doesn't differentiate skip-from-rate-limit from
    // skip-from-empty — both return 200) plus a `generation_skipped`
    // WS cue that carries the actual reason.
    assert.equal(res.status, 200);

    const history = await ctx.fetch(`/broadcasts/${id}/generations`).then((r) => r.json()) as {
      generations: unknown[];
    };
    assert.equal(history.generations.length, 0, "rate-limited generations must not persist");

    const skipped = delivered.map((m) => JSON.parse(m)).find((m) => m.type === "generation_skipped");
    assert.ok(skipped, "expected a generation_skipped WS message");
    assert.equal(skipped.reason, "rate_limited");
    assert.equal(skipped.retryAfterMs, 12_000);
  });

  it("rejects narrative/generate without a consumerPrompt body", async () => {
    const id = await createActiveBroadcast();
    const res = await ctx.fetch(`/broadcasts/${id}/narrative/generate`, { method: "POST" });
    assert.equal(res.status, 400, "body-less request must be rejected — generateNow was retired");
    const body = await res.json() as { error?: string };
    assert.match(body.error ?? "", /consumerPrompt/);
  });

  it("rejects narrative/generate when consumerPrompt is empty", async () => {
    const id = await createActiveBroadcast();
    const res = await ctx.fetch(
      `/broadcasts/${id}/narrative/generate`,
      jsonBody({ consumerPrompt: "" }),
    );
    assert.equal(res.status, 400);
  });

  it("external cycles bypass the curator's empty-cycle short-circuit", async () => {
    // The curator drops cycles where `entries === 0 && annotations === 0`
    // to save LLM calls — but external cycles (consumer-driven, e.g.
    // Blackout's halftime / closing-passage triggers) must always go
    // through, even with an empty buffer. The conductor's FT transition
    // entry races the trigger HTTP call as parallel fire-and-forget
    // promises; if the trigger lands first, the curator sees an empty
    // buffer. Skipping there would mean no closing passage. This test
    // pins that exemption: external cycle on a quiet broadcast still
    // drives the curator's tier services (verified by LLM call count).
    const id = await createActiveBroadcast();
    const res = await ctx.fetch(
      `/broadcasts/${id}/narrative/generate`,
      jsonBody({ consumerPrompt: "## Closing\n\nWrap it up." }),
    );
    assert.equal(res.status, 200);

    // Even with no feed entries, the external cycle ran: enrichment +
    // curator services made LLM calls. If the short-circuit-exemption
    // for external cycles is removed in a future refactor, this drops
    // to zero.
    assert.ok(
      ctx.llm.calls.length > 0,
      "external cycle with empty buffer must drive curator tier services, not short-circuit",
    );
  });

  it("cascades deletion across sources, entries, generations, and states", async () => {
    const id = await createActiveBroadcast();

    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { content: "Goal", minute: 10 } }),
    );
    await ctx.fetch(`/broadcasts/${id}/narrative/generate`, jsonBody({ consumerPrompt: "## Test\n\nA test preamble." }));

    // Force an enrichment flush so at least one service state row exists.
    const runtime = await ensureRuntime(id);
    assert.ok(runtime);
    await runtime.registry.persistEnrichmentStates();

    // Sanity: child rows exist before deletion.
    const before = await sql`
      SELECT
        (SELECT count(*)::int FROM sources WHERE broadcast_id = ${id}) AS sources,
        (SELECT count(*)::int FROM feed_entries WHERE broadcast_id = ${id}) AS entries,
        (SELECT count(*)::int FROM generations WHERE broadcast_id = ${id}) AS generations,
        (SELECT count(*)::int FROM enrichment_service_states WHERE broadcast_id = ${id}) AS states
    `;
    assert.ok(before[0].sources > 0);
    assert.ok(before[0].entries > 0);
    assert.ok(before[0].generations > 0);
    assert.ok(before[0].states > 0);

    const del = await ctx.fetch(`/broadcasts/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);

    const after = await sql`
      SELECT
        (SELECT count(*)::int FROM broadcasts WHERE id = ${id}) AS broadcasts,
        (SELECT count(*)::int FROM sources WHERE broadcast_id = ${id}) AS sources,
        (SELECT count(*)::int FROM feed_entries WHERE broadcast_id = ${id}) AS entries,
        (SELECT count(*)::int FROM generations WHERE broadcast_id = ${id}) AS generations,
        (SELECT count(*)::int FROM enrichment_service_states WHERE broadcast_id = ${id}) AS states
    `;
    assert.equal(after[0].broadcasts, 0);
    assert.equal(after[0].sources, 0);
    assert.equal(after[0].entries, 0);
    assert.equal(after[0].generations, 0);
    assert.equal(after[0].states, 0);

    const reget = await ctx.fetch(`/broadcasts/${id}`);
    assert.equal(reget.status, 404);
  });
});
