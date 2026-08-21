import { describe, it, before, after, mock } from "node:test";
import assert from "node:assert/strict";
import { serve, type ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Broadcast } from "@blackout/shared";

/**
 * Cross-app end-to-end pipeline contract.
 *
 * Spins up a real Kairos in-process (Hono app + WS upgrade), points
 * the Blackout's kairos client at it, and drives synthesized
 * Sportmonks fixture data through the same code path the production
 * BroadcastRunner uses:
 *
 *   Synthesized Sportmonks fixture
 *     → SportmonksEventSource.handleFixtureFeed (real)
 *     → onEvent / onKickoff / onHalftime callbacks (real)
 *     → kairos.pushEntry (real HTTP to in-process Kairos)
 *     → Kairos persistence + WS fan-out (real)
 *     → Blackout subscribeFeed receives entry (real WS roundtrip)
 *     → buildBroadcastView reads back via REST (real)
 *
 * The runner's bigger orchestration (Deepgram, distillation, pressure)
 * is out of scope here — the tests above each cover it. This file is
 * the wiring contract: every callback the source emits must reach the
 * matchroom-shaped view.
 */

// --- Module-level mocks (must run before any conductor / view import) -

mock.module("../src/db/client.js", {
  namedExports: {
    db: {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => Promise.resolve([]),
          }),
        }),
      }),
    },
    sql: () => Promise.resolve([]),
  },
});

mock.module("../src/conductor/index.js", {
  namedExports: {
    getRoomConductor: () => null,
    ensureRoomConductor: async () => null,
    stopRoomConductor: () => undefined,
    stopAllRoomConductors: () => undefined,
    listRoomConductors: () => [],
    RoomConductor: class {},
  },
});

mock.module("../src/lib/storage/index.js", {
  namedExports: {
    getStorage: () => ({ getPublicUrl: async () => null }),
  },
});

// --- Kairos in-process server setup ---------------------------------

const KAIROS_API_KEY = "e2e-test-key";

// Env vars KAIROS_URL + KAIROS_API_KEY are captured into module-level
// constants by kairos.ts on first import. Set them BEFORE the dynamic
// kairos imports happen inside before(). KAIROS_URL is patched to the
// real port the in-process server gets — this works because we delay
// importing kairos.ts until after the server is listening.
// `=` not `??=` — this test imports Kairos's app.ts in-process and
// needs DATABASE_URL pointing at kairos_test specifically. The
// global tests/test-env.ts default is blackout_test (for the
// Blackout's lazy db client); force-override here for Kairos's use.
process.env.DATABASE_URL = "postgresql://localhost:5432/kairos_test";
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.KAIROS_API_KEYS = KAIROS_API_KEY;
process.env.KAIROS_API_KEY = KAIROS_API_KEY;

let kairosHttp: ServerType;
let kairosWss: WebSocketServer;
let kairosPort: number;

// Lazily imported inside before() once KAIROS_URL points at the
// running in-process Kairos.
let kairosClient: typeof import("../src/lib/kairos.js");
let buildBroadcastView: typeof import("../src/lib/broadcast-view.js")["buildBroadcastView"];
let SportmonksEventSource: typeof import("../src/sources/sportmonks.js")["SportmonksEventSource"];

before(async () => {

  // Import Kairos server pieces directly — bending the module-boundary
  // rule for test purposes (Kairos doesn't import the Blackout, but
  // the Blackout's tests are allowed to import Kairos to stand up an
  // in-process roundtrip target).
  const { createApp } = await import("../../../kairos/server/src/app.js" as string) as { createApp: () => import("hono").Hono };
  const { ensureRuntime, setRuntimeDependencies } = await import("../../../kairos/server/src/broadcast.js" as string) as {
    ensureRuntime: (id: string) => Promise<{ feed: { getAll: () => Array<unknown> }; subscribers: Set<import("ws").WebSocket> } | null>;
    setRuntimeDependencies: (deps: { llm?: unknown }) => void;
  };
  const { StubLLMClient } = await import("../../../kairos/server/src/llm/index.js" as string) as { StubLLMClient: new (responses: unknown[]) => unknown };
  const { handleFeedSubscription } = await import("../../../kairos/server/src/ws/feed.js" as string) as { handleFeedSubscription: (ws: import("ws").WebSocket, runtime: unknown) => void };
  const { sql: kairosSql } = await import("../../../kairos/server/src/db/client.js" as string) as { sql: { end: () => Promise<void>; (...args: unknown[]): Promise<unknown> } };

  // Stub the LLM so the in-process Kairos makes zero real Anthropic
  // calls — this test asserts on the canonical-state wiring, not on
  // narrative. The empty stub throws "exhausted" on the first
  // non-imagery call; the pipeline swallows it (brief-init failures
  // are logged + swallowed; a failed cycle becomes generation_skipped),
  // so the runtime keeps fanning entries out. Without it the runtime
  // builds an AnthropicLLMClient against the fake key and burns minutes
  // on 401s × the SDK's retry-backoff during brief-init and every cycle.
  setRuntimeDependencies({ llm: new StubLLMClient([]) });

  // Truncate runtime data so the test starts from a clean slate.
  await kairosSql`TRUNCATE broadcasts, sources, feed_entries, generations, enrichment_service_states RESTART IDENTITY CASCADE`;

  const app = createApp();
  const onListen = new Promise<number>((r) => {
    kairosHttp = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => r(info.port));
  });
  kairosPort = await onListen;

  // WS upgrade — mirror the production server's wiring (auth + route match).
  kairosWss = new WebSocketServer({ noServer: true });
  (kairosHttp as unknown as Server).on("upgrade", (req, socket, head) => {
    const match = req.url?.match(/^\/broadcasts\/([^/]+)\/feed$/);
    if (!match) {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1]?.trim() ?? null;
    if (bearer !== KAIROS_API_KEY) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    kairosWss.handleUpgrade(req, socket, head, async (ws) => {
      const broadcastId = match[1];
      const runtime = await ensureRuntime(broadcastId);
      if (!runtime) {
        ws.close(4004, `Broadcast ${broadcastId} is not active`);
        return;
      }
      handleFeedSubscription(ws, runtime);
    });
  });

  // Point the Blackout's kairos client at our in-process server BEFORE
  // its module-level constants get captured.
  process.env.KAIROS_URL = `http://127.0.0.1:${kairosPort}`;

  // Now safe to import the Blackout-side modules — KAIROS_URL +
  // KAIROS_API_KEY are both set.
  kairosClient = await import("../src/lib/kairos.js");
  ({ buildBroadcastView } = await import("../src/lib/broadcast-view.js"));
  ({ SportmonksEventSource } = await import("../src/sources/sportmonks.js"));
});

after(async () => {
  // Stop every active Kairos runtime BEFORE closing the WS server +
  // HTTP socket — runtime intervals (enrichment pipeline, summary
  // updater) hold the event loop open otherwise. Tests pass; without
  // this the process just doesn't exit.
  const { stopAllRuntimes, setRuntimeDependencies } = await import("../../../kairos/server/src/broadcast.js" as string) as { stopAllRuntimes: () => void; setRuntimeDependencies: (deps: { llm?: unknown }) => void };
  stopAllRuntimes();
  setRuntimeDependencies({}); // unhook the stub LLM so a later in-process Kairos import in the same run isn't affected
  await new Promise<void>((r) => kairosWss.close(() => r()));
  await new Promise<void>((r) => kairosHttp.close(() => r()));
  const { sql: kairosSql } = await import("../../../kairos/server/src/db/client.js" as string) as { sql: { end: () => Promise<void> } };
  await kairosSql.end();
});

// --- Synthesis helpers ----------------------------------------------

interface FakeFixture {
  events: Array<{
    id: number;
    type_id: number;
    minute: number;
    extra_minute: number | null;
    participant_id: number;
    player_name: string | null;
    related_player_name?: string | null;
    info?: string | null;
    result?: string | null;
  }>;
  timeline: unknown[];
  trends: unknown[];
  ballCoordinates: unknown[];
  statistics: unknown[];
  state: { short_name: string };
  state_id: number;
  starting_at: string | null;
  participants: Array<{ id: number; name: string; short_code: string; meta: { location: "home" | "away" } }>;
  periods: unknown[];
}

function fixture(overrides: Partial<FakeFixture> = {}): FakeFixture {
  return {
    events: [],
    timeline: [],
    trends: [],
    ballCoordinates: [],
    statistics: [],
    state: { short_name: "1H" },
    state_id: 2,
    starting_at: "2026-05-02T14:00:00Z",
    participants: [
      { id: 100, name: "Burnley", short_code: "BUR", meta: { location: "home" } },
      { id: 200, name: "Manchester City", short_code: "MCI", meta: { location: "away" } },
    ],
    periods: [],
    ...overrides,
  };
}

interface RawEvent {
  id: number;
  type_id: number;
  minute: number;
  participant_id: number;
  player_name: string | null;
  result?: string;
  extra_minute?: number;
}

function rawEvent(overrides: Partial<RawEvent>): RawEvent {
  return {
    id: 1,
    type_id: 14,
    minute: 12,
    participant_id: 200,
    player_name: "Erling Haaland",
    result: "0-1",
    ...overrides,
  } as RawEvent;
}

async function createKairosBroadcast(): Promise<string> {
  const created = await fetch(`${process.env.KAIROS_URL}/broadcasts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KAIROS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_profile: "sporting_event",
      sources: [
        { name: "match_events", type: "event", canonical: true },
        { name: "match_pressure", type: "event", canonical: false },
        { name: "match_stats", type: "event", canonical: false },
        { name: "match_action", type: "event", canonical: false },
        { name: "moderator", type: "moderator" },
        { name: "narrative_context", type: "narrative_context" },
        { name: "narrative_voice", type: "narrative_voice" },
      ],
    }),
  });
  assert.equal(created.status, 201);
  const { broadcast } = await created.json() as { broadcast: { id: string } };

  // Seed voice + context + activate (mimicking what the kairos-bridge does).
  await kairosClient.pushEntry(broadcast.id, {
    source: "narrative_voice",
    data: { content: "Spare prose. Past tense." },
  });
  await kairosClient.pushEntry(broadcast.id, {
    source: "narrative_context",
    data: { content: "Premier League: Burnley vs Manchester City." },
  });

  const activated = await fetch(`${process.env.KAIROS_URL}/broadcasts/${broadcast.id}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${KAIROS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ status: "active" }),
  });
  assert.equal(activated.status, 200);

  return broadcast.id;
}

/** Wire a SportmonksEventSource through to the real Kairos client —
 *  same orchestration BroadcastRunner does in production, distilled
 *  to just the contract we're testing. */
function wireSourceToKairos(
  source: InstanceType<typeof SportmonksEventSource>,
  kairosBroadcastId: string,
  pushed: Array<{ source: string; data: Record<string, unknown> }>,
): void {
  source.start({
    onEvent: (data) => {
      pushed.push({ source: "match_events", data });
      void kairosClient.pushEntry(kairosBroadcastId, { source: "match_events", data });
    },
    onStat: () => {},
    onError: () => {},
    onKickoff: () => {
      const data = { eventType: "KICKOFF", content: "Kickoff", subjectTime: "1", phase: "first_half", phaseSecond: 0, team: null, player: null, synthetic: true };
      pushed.push({ source: "match_events", data });
      void kairosClient.pushEntry(kairosBroadcastId, { source: "match_events", data });
    },
    onHalftime: () => {
      const data = { eventType: "HALFTIME", content: "HT", subjectTime: "45", phase: "halftime", phaseSecond: 0, team: null, player: null, synthetic: true };
      pushed.push({ source: "match_events", data });
      void kairosClient.pushEntry(kairosBroadcastId, { source: "match_events", data });
    },
    onSecondHalfKickoff: () => {
      const data = { eventType: "SECOND_HALF_KICKOFF", content: "2H", subjectTime: "46", phase: "second_half", phaseSecond: 0, team: null, player: null, synthetic: true };
      pushed.push({ source: "match_events", data });
      void kairosClient.pushEntry(kairosBroadcastId, { source: "match_events", data });
    },
    onFulltime: () => {
      const data = { eventType: "FULL_TIME", content: "FT", subjectTime: "90", phase: "full_time", phaseSecond: 0, team: null, player: null, synthetic: true };
      pushed.push({ source: "match_events", data });
      void kairosClient.pushEntry(kairosBroadcastId, { source: "match_events", data });
    },
  });
  // teamMap is normally populated by startPolling's first fetch. Inject
  // directly so we can call handleFixtureFeed without HTTP.
  (source as unknown as { teamMap: unknown }).teamMap = {
    100: { side: "home", name: "Burnley", shortCode: "BUR" },
    200: { side: "away", name: "Manchester City", shortCode: "MCI" },
  };
}

function feed(source: InstanceType<typeof SportmonksEventSource>, fix: FakeFixture): void {
  (source as unknown as { handleFixtureFeed: (f: FakeFixture) => void }).handleFixtureFeed(fix);
}

/** Wait for a value to settle. */
async function settle<T>(getter: () => T | null | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = getter();
    if (v != null) return v;
    if (Date.now() - start > timeoutMs) throw new Error("settle timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function fakeBroadcast(kairosId: string): Broadcast {
  return {
    id: "blackout-broadcast-id",
    homeTeam: "Burnley",
    awayTeam: "Manchester City",
    competition: "Premier League",
    matchDate: "2026-05-02T14:00:00.000Z",
    status: "live",
    kairosBroadcastId: kairosId,
    createdAt: "2026-05-02T13:00:00.000Z",
    updatedAt: "2026-05-02T13:00:00.000Z",
  } as Broadcast;
}

// --- Tests ----------------------------------------------------------

describe("E2E: Sportmonks → Kairos → buildBroadcastView", () => {
  it("a full match arc lands every event + every phase in canonical state", async () => {
    const kairosId = await createKairosBroadcast();
    const source = new SportmonksEventSource();
    const pushed: Array<{ source: string; data: Record<string, unknown> }> = [];
    wireSourceToKairos(source, kairosId, pushed);

    // Poll 1: 1H starts, no events. Triggers onKickoff (first time
    // an in-play state is observed by the source).
    feed(source, fixture({ state_id: 2, state: { short_name: "1H" }, events: [] }));

    // Poll 2: still 1H, a goal lands.
    feed(source, fixture({
      state_id: 2,
      state: { short_name: "1H" },
      events: [rawEvent({ id: 1000, type_id: 14, minute: 12, player_name: "Erling Haaland", result: "0-1" })],
    }));

    // Poll 3: yellow card.
    feed(source, fixture({
      state_id: 2,
      state: { short_name: "1H" },
      events: [
        rawEvent({ id: 1000, type_id: 14, minute: 12, player_name: "Erling Haaland", result: "0-1" }),
        rawEvent({ id: 1001, type_id: 19, minute: 23, player_name: "Dan Burn", participant_id: 100, result: undefined }),
      ],
    }));

    // Poll 4: state flips to HT.
    feed(source, fixture({ state_id: 3, state: { short_name: "HT" }, events: [] }));

    // Poll 5: 2H starts.
    feed(source, fixture({ state_id: 22, state: { short_name: "2H" }, events: [] }));

    // Poll 6: second goal late on.
    feed(source, fixture({
      state_id: 22,
      state: { short_name: "2H" },
      events: [
        rawEvent({ id: 1002, type_id: 14, minute: 78, player_name: "Phil Foden", result: "0-2" }),
      ],
    }));

    // Poll 7: full time.
    feed(source, fixture({ state_id: 5, state: { short_name: "FT" }, events: [] }));

    // Wait for all the pushed pushEntry promises to settle.
    await new Promise((r) => setTimeout(r, 200));

    // 1. Verify Kairos has every entry we pushed.
    const list = await kairosClient.listBroadcastEntries(kairosId, { source: "match_events" });
    const eventTypes = list.map((e) => (e.data as { eventType?: string }).eventType ?? "?");
    assert.deepEqual(
      eventTypes.sort(),
      ["FULL_TIME", "GOAL", "GOAL", "HALFTIME", "KICKOFF", "SECOND_HALF_KICKOFF", "YELLOW_CARD"].sort(),
      "Kairos has all 4 phase transitions + 2 goals + 1 yellow card",
    );

    // 2. Verify the canonical state builder produces the right view.
    const view = await buildBroadcastView(fakeBroadcast(kairosId));

    // Every event present
    const revealedTypes = view.revealedEvents.map((e) => e.eventType);
    assert.equal(revealedTypes.includes("KICKOFF"), true);
    assert.equal(revealedTypes.includes("GOAL"), true);
    assert.equal(revealedTypes.includes("YELLOW_CARD"), true);
    assert.equal(revealedTypes.includes("HALFTIME"), true);
    assert.equal(revealedTypes.includes("SECOND_HALF_KICKOFF"), true);
    assert.equal(revealedTypes.includes("FULL_TIME"), true);
    assert.equal(view.revealedEvents.filter((e) => e.eventType === "GOAL").length, 2);

    // Score derived
    assert.equal(view.score.home, 0);
    assert.equal(view.score.away, 2);

    // Final minute label
    assert.equal(view.currentContentMinute, "FT");
  });

  it("Kairos-side dedup collapses a re-emitted same-sourceId event across multiple polls", async () => {
    const kairosId = await createKairosBroadcast();

    // Bypass SportmonksEventSource — its in-process seenEventIds
    // already dedups same-id pushes within a single runner. The
    // contract being asserted here is the KAIROS write-layer dedup,
    // which catches the post-restart case where a fresh runner
    // re-pushes events Kairos already has.
    const data = {
      kind: "event",
      sourceId: 9000,
      eventType: "GOAL",
      minute: 12,
      player: "Haaland",
      teamName: "Manchester City",
      team: "away",
      result: "0-1",
      content: "GOAL",
    };

    const first = await kairosClient.pushEntry(kairosId, { source: "match_events", data });
    const second = await kairosClient.pushEntry(kairosId, { source: "match_events", data });
    const third = await kairosClient.pushEntry(kairosId, { source: "match_events", data });

    assert.equal(second.id, first.id, "second push returns the first entry");
    assert.equal(third.id, first.id, "third push also returns the first entry");

    const list = await kairosClient.listBroadcastEntries(kairosId, { source: "match_events" });
    const goals = list.filter((e) => (e.data as { eventType?: string }).eventType === "GOAL");
    assert.equal(goals.length, 1, "Kairos write-layer dedup collapsed the duplicate sourceId pushes");

    const view = await buildBroadcastView(fakeBroadcast(kairosId));
    assert.equal(view.score.away, 1, "view layer reflects single goal");
  });

  it("WS roundtrip: a subscriber receives every entry pushed to Kairos in real time", async () => {
    const kairosId = await createKairosBroadcast();
    const received: Array<{ data: { eventType?: string; content?: string } }> = [];
    let synced = false;

    const sub = kairosClient.subscribeFeed(kairosId, {
      onSync: () => { synced = true; },
      onEntry: (entry) => {
        received.push(entry as { data: { eventType?: string; content?: string } });
      },
    });

    // Wait for the WS handshake + initial sync.
    await settle(() => (synced ? true : null), 3000);

    const source = new SportmonksEventSource();
    const pushed: Array<{ source: string; data: Record<string, unknown> }> = [];
    wireSourceToKairos(source, kairosId, pushed);

    // KICKOFF + GOAL + HALFTIME — drive each through the source and
    // wait for the WS subscriber to see them.
    feed(source, fixture({ state_id: 2, events: [] }));
    feed(source, fixture({
      state_id: 2,
      events: [rawEvent({ id: 8000, type_id: 14, minute: 12, player_name: "Haaland", result: "0-1" })],
    }));
    feed(source, fixture({ state_id: 3, state: { short_name: "HT" }, events: [] }));

    await settle(() => {
      const types = received.map((e) => e.data.eventType ?? "?");
      return types.includes("KICKOFF") && types.includes("GOAL") && types.includes("HALFTIME") ? true : null;
    }, 3000);

    const types = received.map((e) => e.data.eventType ?? "?");
    assert.equal(types.includes("KICKOFF"), true, "KICKOFF reached the WS subscriber");
    assert.equal(types.includes("GOAL"), true, "GOAL reached the WS subscriber");
    assert.equal(types.includes("HALFTIME"), true, "HALFTIME reached the WS subscriber");

    sub.close();
  });
});
