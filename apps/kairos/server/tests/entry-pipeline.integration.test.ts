import { before, after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WebSocket } from "ws";
import {
  createTestContext,
  resetRuntimeData,
  closeConnection,
  jsonBody,
  patchBody,
  type TestContext,
} from "./helpers.js";
import { ensureRuntime, getRuntime, stopRuntime } from "../src/broadcast.js";

/**
 * Entry pipeline contract — Kairos side.
 *
 * Locks down the contracts the Blackout's broadcast-runner depends on
 * when it pushes match events into Kairos:
 *
 *   1. Every event-type the Blackout pushes round-trips intact via the
 *      list endpoint — Kairos's storage is opaque to the data shape,
 *      but that opacity is the contract: nothing the consumer puts in
 *      `data` is silently dropped or transformed.
 *   2. Synthetic phase entries (KICKOFF / HALFTIME / etc) — pushed by
 *      the conductor — persist with their `synthetic: true` marker
 *      intact so the canonical-state builder on the Blackout side can
 *      key its dedup off `eventType`.
 *   3. WS fan-out: an entry pushed via REST reaches every subscriber
 *      registered on the runtime. This is the path the conductor
 *      relies on to receive its own synthetic phase entry back.
 *   4. Dedup: documents the current behavior (Kairos accepts every
 *      push as a fresh row — task #27 will introduce defense-in-depth
 *      dedup at the write layer; this test will flip from "two rows"
 *      to "one row" when that lands).
 *   5. Recovery: a fresh runtime started against an existing broadcast
 *      hydrates every persisted entry into its in-memory cache.
 */

const VOICE = "Spare, unsentimental prose. Past tense. Short sentences.";
const CONTEXT = "Premier League: Newcastle United vs Brighton.";

const fullSources = [
  { name: "match_events", type: "event", canonical: true, enrichment_tags: ["momentum"] },
  { name: "moderator", type: "moderator" },
  { name: "narrative_context", type: "narrative_context" },
  { name: "narrative_voice", type: "narrative_voice" },
];

let ctx: TestContext;

/** Minimal WS-shape mock with a no-op close. The runtime calls
 *  `ws.close()` on shutdown — without it, stopAllRuntimes throws
 *  inside the test's beforeEach hook and every subsequent test is
 *  cancelled. */
function fakeWs(sink: string[]): WebSocket {
  return {
    send: (data: string) => sink.push(data),
    close: () => {},
  } as unknown as WebSocket;
}

async function createActiveBroadcast(): Promise<string> {
  const created = await ctx.fetch(
    "/broadcasts",
    jsonBody({ event_profile: "sporting_event", sources: fullSources }),
  );
  assert.equal(created.status, 201);
  const { broadcast } = await created.json() as { broadcast: { id: string } };

  await ctx.fetch(
    `/broadcasts/${broadcast.id}/entries`,
    jsonBody({ source: "narrative_voice", data: { content: VOICE } }),
  );
  await ctx.fetch(
    `/broadcasts/${broadcast.id}/entries`,
    jsonBody({ source: "narrative_context", data: { content: CONTEXT } }),
  );

  const activated = await ctx.fetch(
    `/broadcasts/${broadcast.id}`,
    patchBody({ status: "active" }),
  );
  assert.equal(activated.status, 200);
  return broadcast.id;
}

// --- Setup ----------------------------------------------------------

describe("Kairos entry pipeline — contract for the Blackout's broadcast-runner", () => {
  before(async () => {
    ctx = await createTestContext();
  });

  beforeEach(async () => {
    await resetRuntimeData();
    // Generous LLM stub pool so empty-cycle generations don't trip
    // the mocked client. Tests in this file don't assert on
    // generations — they assert on the entry pipeline itself.
    ctx.llm.reset(
      Array.from({ length: 50 }, () => ({
        text: "Stub.",
        usage: { inputTokens: 10, outputTokens: 5 },
      })),
    );
  });

  after(async () => {
    await resetRuntimeData();
    await closeConnection();
  });

  // --- 1. Per-event-type round trip --------------------------------

  // Mirrors the Blackout's EVENT_TYPE_MAP (apps/blackout/server/src/lib/sportmonks.ts).
  // Every Sportmonks type_id the Blackout maps must round-trip
  // through Kairos with its data intact.
  const SPORTMONKS_EVENT_TYPES = [
    "GOAL",
    "OWN_GOAL",
    "PENALTY",
    "PENALTY_MISS",
    "SUBSTITUTION",
    "YELLOW_CARD",
    "RED_CARD",
    "SECOND_YELLOW",
    "VAR",
    "VAR_CARD",
  ] as const;

  for (const eventType of SPORTMONKS_EVENT_TYPES) {
    it(`round-trips ${eventType} entries intact via the list endpoint`, async () => {
      const id = await createActiveBroadcast();
      const data = {
        kind: "event",
        sourceId: 12345,
        eventType,
        minute: 12,
        extraMinute: null,
        teamName: "Manchester City",
        team: "away",
        player: "Erling Haaland",
        result: "0-1",
        content: `${eventType} — Haaland 12'`,
        subjectTime: "12",
      };

      const pushed = await ctx.fetch(
        `/broadcasts/${id}/entries`,
        jsonBody({ source: "match_events", data }),
      );
      assert.equal(pushed.status, 201, `push of ${eventType} must succeed`);

      const list = await ctx
        .fetch(`/broadcasts/${id}/entries?source=match_events`)
        .then((r) => r.json()) as { entries: Array<{ data: Record<string, unknown> }> };

      assert.equal(list.entries.length, 1);
      const round = list.entries[0].data;
      assert.equal(round.eventType, eventType);
      assert.equal(round.sourceId, 12345);
      assert.equal(round.minute, 12);
      assert.equal(round.player, "Erling Haaland");
      assert.equal(round.teamName, "Manchester City");
    });
  }

  // --- 2. Synthetic phase entries ----------------------------------

  const SYNTHETIC_PHASES = ["KICKOFF", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME"] as const;

  for (const eventType of SYNTHETIC_PHASES) {
    it(`round-trips synthetic ${eventType} phase entries with the synthetic marker preserved`, async () => {
      const id = await createActiveBroadcast();
      const data = {
        eventType,
        content: `${eventType} whistle`,
        subjectTime: eventType === "KICKOFF" ? "1" : eventType === "HALFTIME" ? "45" : eventType === "SECOND_HALF_KICKOFF" ? "46" : "90",
        phase: eventType === "KICKOFF" ? "first_half" : eventType === "HALFTIME" ? "halftime" : eventType === "SECOND_HALF_KICKOFF" ? "second_half" : "full_time",
        team: null,
        player: null,
        synthetic: true,
      };

      const pushed = await ctx.fetch(
        `/broadcasts/${id}/entries`,
        jsonBody({ source: "match_events", data }),
      );
      assert.equal(pushed.status, 201);

      const list = await ctx
        .fetch(`/broadcasts/${id}/entries?source=match_events`)
        .then((r) => r.json()) as { entries: Array<{ data: Record<string, unknown> }> };

      assert.equal(list.entries.length, 1);
      assert.equal(list.entries[0].data.eventType, eventType);
      assert.equal(list.entries[0].data.synthetic, true);
      assert.equal(list.entries[0].data.phase, data.phase);
    });
  }

  // --- 3. WS fan-out ------------------------------------------------

  it("fans pushed entries out to every WebSocket subscriber on the runtime", async () => {
    const id = await createActiveBroadcast();
    const runtime = getRuntime(id);
    assert.ok(runtime, "runtime must be active for fan-out");

    // The Blackout's conductor connects via real WS in production;
    // here we register two minimal WebSocket-shaped fakes directly on
    // the runtime so we can observe the fan-out path without binding
    // a port.
    const sentA: string[] = [];
    const sentB: string[] = [];
    runtime.subscribers.add(fakeWs(sentA));
    runtime.subscribers.add(fakeWs(sentB));

    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({
        source: "match_events",
        data: { eventType: "KICKOFF", synthetic: true, content: "Kickoff", subjectTime: "1" },
      }),
    );

    assert.equal(sentA.length, 1, "subscriber A must receive the entry");
    assert.equal(sentB.length, 1, "subscriber B must receive the entry");
    const parsedA = JSON.parse(sentA[0]) as { type: string; entry: { data: Record<string, unknown> } };
    assert.equal(parsedA.type, "entry");
    assert.equal(parsedA.entry.data.eventType, "KICKOFF");
    assert.equal(parsedA.entry.data.synthetic, true);
  });

  it("WS fan-out delivers EVERY pushed entry in order", async () => {
    const id = await createActiveBroadcast();
    const runtime = getRuntime(id);
    assert.ok(runtime);

    const sent: string[] = [];
    runtime.subscribers.add(fakeWs(sent));

    const types = ["KICKOFF", "GOAL", "YELLOW_CARD", "HALFTIME"];
    for (const t of types) {
      await ctx.fetch(
        `/broadcasts/${id}/entries`,
        jsonBody({
          source: "match_events",
          data: { eventType: t, content: t, subjectTime: "1" },
        }),
      );
    }

    assert.equal(sent.length, 4);
    const received = sent.map((s) => (JSON.parse(s) as { entry: { data: { eventType: string } } }).entry.data.eventType);
    assert.deepEqual(received, types);
  });

  // --- 4. Dedup at the write layer ---------------------------------

  it("dedups by data.sourceId within (broadcast, source) — second push returns the first entry", async () => {
    // Defense in depth: the Blackout's runner now reseeds dedup state
    // across restarts (see seedFromExistingEntries), but Kairos is the
    // last line. If a runner ever regresses or a third-party consumer
    // double-pushes, Kairos collapses the duplicate by checking
    // `data.sourceId` against existing rows for the same source.
    const id = await createActiveBroadcast();
    const data = {
      kind: "event",
      sourceId: 99999,
      eventType: "GOAL",
      minute: 12,
      player: "Haaland",
      teamName: "Manchester City",
      content: "GOAL — Haaland 12'",
    };

    const first = await ctx
      .fetch(`/broadcasts/${id}/entries`, jsonBody({ source: "match_events", data }))
      .then((r) => r.json()) as { id: string };
    const second = await ctx
      .fetch(`/broadcasts/${id}/entries`, jsonBody({ source: "match_events", data }))
      .then((r) => r.json()) as { id: string };

    assert.equal(second.id, first.id, "duplicate push must return the first entry");

    const list = await ctx
      .fetch(`/broadcasts/${id}/entries?source=match_events`)
      .then((r) => r.json()) as { entries: Array<unknown> };
    assert.equal(list.entries.length, 1, "only one row persisted");
  });

  it("does NOT dedup entries without a sourceId (synthetic phase entries, ambient sources, ad-hoc moderator notes)", async () => {
    // Synthetic phase entries (KICKOFF/HALFTIME/etc) intentionally
    // don't carry a sourceId — they're conductor-emitted, not
    // externally identified. Same for ambient writer briefs and
    // free-form moderator notes. Kairos shouldn't collapse them just
    // because a re-pushed brief has identical content; the consumer
    // is the authority on whether a duplicate is a regression.
    const id = await createActiveBroadcast();
    const data = {
      eventType: "KICKOFF",
      synthetic: true,
      content: "Kickoff",
      subjectTime: "1",
    };

    await ctx.fetch(`/broadcasts/${id}/entries`, jsonBody({ source: "match_events", data }));
    await ctx.fetch(`/broadcasts/${id}/entries`, jsonBody({ source: "match_events", data }));

    const list = await ctx
      .fetch(`/broadcasts/${id}/entries?source=match_events`)
      .then((r) => r.json()) as { entries: Array<unknown> };
    assert.equal(list.entries.length, 2, "no sourceId → no Kairos-side dedup; the consumer's view layer handles synthetic-eventType collapsing");
  });

  it("dedup is scoped to (broadcast, source) — same sourceId across different sources is allowed", async () => {
    const id = await createActiveBroadcast();
    const data = { sourceId: 555, content: "thing" };

    // Push to match_events, then to moderator with the same sourceId.
    // These are different sources (different uuid in the sources
    // table), so dedup must NOT collapse them.
    const first = await ctx
      .fetch(`/broadcasts/${id}/entries`, jsonBody({ source: "match_events", data }))
      .then((r) => r.json()) as { id: string };
    const second = await ctx
      .fetch(`/broadcasts/${id}/entries`, jsonBody({ source: "moderator", data }))
      .then((r) => r.json()) as { id: string };

    assert.notEqual(first.id, second.id, "same sourceId across different sources stays as two distinct rows");
  });

  it("dedup is scoped per broadcast — same sourceId in a different broadcast is independent", async () => {
    const id1 = await createActiveBroadcast();
    const id2 = await createActiveBroadcast();
    const data = { sourceId: 777, content: "x" };

    const a = await ctx
      .fetch(`/broadcasts/${id1}/entries`, jsonBody({ source: "match_events", data }))
      .then((r) => r.json()) as { id: string };
    const b = await ctx
      .fetch(`/broadcasts/${id2}/entries`, jsonBody({ source: "match_events", data }))
      .then((r) => r.json()) as { id: string };

    assert.notEqual(a.id, b.id, "same sourceId in different broadcasts stays independent");
  });

  // --- 5. Recovery --------------------------------------------------

  it("recovery: stopping and re-starting the runtime hydrates every persisted entry into the cache", async () => {
    const id = await createActiveBroadcast();
    const events = [
      { eventType: "KICKOFF", synthetic: true, content: "Kickoff", subjectTime: "1" },
      { eventType: "GOAL", sourceId: 100, minute: 12, player: "Haaland", content: "GOAL" },
      { eventType: "YELLOW_CARD", sourceId: 101, minute: 23, player: "Burn", content: "YELLOW" },
      { eventType: "HALFTIME", synthetic: true, content: "HT", subjectTime: "45" },
    ];
    for (const data of events) {
      await ctx.fetch(`/broadcasts/${id}/entries`, jsonBody({ source: "match_events", data }));
    }

    // Tear down the runtime (simulates a server restart).
    await stopRuntime(id);
    assert.equal(getRuntime(id), undefined, "runtime cleared from registry");

    // Rebuild the runtime — the Feed should hydrate every entry from
    // the database. This is the contract the Blackout-side conductor
    // relies on after a deploy or process restart.
    await ensureRuntime(id);
    const runtime = getRuntime(id);
    assert.ok(runtime, "runtime re-registered");

    const cached = runtime.feed.getAll();
    const matchEvents = cached.filter((e) => e.sourceName === "match_events");
    assert.equal(matchEvents.length, 4, "all 4 match_events entries hydrated into the runtime cache");
    const types = matchEvents.map((e) => (e.data as { eventType: string }).eventType);
    assert.deepEqual(types, ["KICKOFF", "GOAL", "YELLOW_CARD", "HALFTIME"]);
  });

  it("recovery: REST list endpoint returns the same entries before and after a runtime restart", async () => {
    const id = await createActiveBroadcast();
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { eventType: "GOAL", sourceId: 200, content: "GOAL" } }),
    );
    await ctx.fetch(
      `/broadcasts/${id}/entries`,
      jsonBody({ source: "match_events", data: { eventType: "HALFTIME", synthetic: true, content: "HT" } }),
    );

    const before = await ctx.fetch(`/broadcasts/${id}/entries?source=match_events`).then((r) => r.json()) as { entries: Array<{ data: { eventType: string } }> };

    await stopRuntime(id);
    await ensureRuntime(id);

    const after = await ctx.fetch(`/broadcasts/${id}/entries?source=match_events`).then((r) => r.json()) as { entries: Array<{ data: { eventType: string } }> };

    assert.equal(before.entries.length, after.entries.length);
    assert.deepEqual(
      before.entries.map((e) => e.data.eventType),
      after.entries.map((e) => e.data.eventType),
    );
  });
});

