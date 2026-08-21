import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as WsServerSocket } from "ws";

/**
 * Blackout's Kairos WebSocket client contract.
 *
 * `kairos.subscribeFeed` is the path the conductor uses to receive
 * its own synthetic phase entries (KICKOFF / HALFTIME / etc) back
 * from Kairos after pushing them via REST. The 2026-05-02 live test
 * surfaced "no KICKOFF in combined feed" — these tests pin the WS
 * message-parsing + dispatch contract end-to-end so any drift in
 * the wire format between Kairos and the Blackout's client is
 * caught locally.
 *
 * A real WebSocketServer (from `ws`) accepts the connection on a
 * random localhost port; the test then sends synthesized messages
 * and asserts the client invokes the right callback with the right
 * payload shape.
 */

// Env must be set BEFORE importing kairos.ts — module-level constants.
let httpServer: Server;
let wss: WebSocketServer;
let port: number;

before(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", () => r()));
  port = (httpServer.address() as AddressInfo).port;
  process.env.KAIROS_URL = `http://127.0.0.1:${port}`;
  process.env.KAIROS_API_KEY = "test-key";
});

after(async () => {
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => httpServer.close(() => r()));
});

const { subscribeFeed } = await import("../src/lib/kairos.js");

// --- helpers --------------------------------------------------------

/** Wait for the next WS connection to land on the test server. */
function nextConnection(): Promise<WsServerSocket> {
  return new Promise((resolve) => {
    wss.once("connection", (ws: WsServerSocket) => resolve(ws));
  });
}

/** Wait for a value to become non-null/undefined, polling at 5ms. */
async function waitFor<T>(getter: () => T | null | undefined, timeoutMs = 1000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = getter();
    if (v != null) return v;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- Tests ----------------------------------------------------------

describe("subscribeFeed — WS message parsing & callback dispatch", () => {
  it("forwards sync messages to onSync with the entries array", async () => {
    let synced: unknown = null;
    const conn = nextConnection();
    const sub = subscribeFeed("b1", {
      onEntry: () => {},
      onSync: (entries) => { synced = entries; },
    });

    const serverWs = await conn;
    serverWs.send(JSON.stringify({
      type: "sync",
      entries: [
        { id: "e1", source: "match_events", data: { eventType: "KICKOFF", synthetic: true }, timestamp: 1 },
        { id: "e2", source: "match_events", data: { eventType: "GOAL", sourceId: 100 }, timestamp: 2 },
      ],
    }));

    const result = await waitFor(() => synced) as Array<{ data: { eventType: string } }>;
    assert.equal(result.length, 2);
    assert.equal(result[0].data.eventType, "KICKOFF");
    assert.equal(result[1].data.eventType, "GOAL");
    sub.close();
  });

  it("forwards entry messages to onEntry with the parsed entry", async () => {
    const received: Array<{ data: { eventType: string } }> = [];
    const conn = nextConnection();
    const sub = subscribeFeed("b2", {
      onEntry: (entry) => { received.push(entry as { data: { eventType: string } }); },
    });

    const serverWs = await conn;
    // Push every phase + a real event in sequence — the contract
    // says the Blackout-side conductor sees them all.
    const types = ["KICKOFF", "GOAL", "HALFTIME", "SECOND_HALF_KICKOFF", "FULL_TIME"];
    for (const t of types) {
      serverWs.send(JSON.stringify({
        type: "entry",
        entry: { id: `e-${t}`, source: "match_events", data: { eventType: t }, timestamp: Date.now() },
      }));
    }

    await waitFor(() => (received.length === 5 ? true : null));
    assert.deepEqual(received.map((e) => e.data.eventType), types);
    sub.close();
  });

  it("forwards narrative messages to onNarrative", async () => {
    let narrative: unknown = null;
    const conn = nextConnection();
    const sub = subscribeFeed("b3", {
      onEntry: () => {},
      onNarrative: (n) => { narrative = n; },
    });

    const serverWs = await conn;
    serverWs.send(JSON.stringify({
      type: "narrative",
      narrative: {
        narrativeId: "n1",
        text: "The whistle blew.",
        wordCount: 3,
        prose: "The whistle blew.",
        covers: [{ entryId: "e-KICKOFF" }],
        batchEntryIds: ["e-KICKOFF"],
      },
    }));

    const result = await waitFor(() => narrative) as { narrativeId: string; text: string };
    assert.equal(result.narrativeId, "n1");
    assert.equal(result.text, "The whistle blew.");
    sub.close();
  });

  it("forwards imagery_decision messages to onImageryDecision with reshaped fields", async () => {
    let decision: unknown = null;
    const conn = nextConnection();
    const sub = subscribeFeed("b4", {
      onEntry: () => {},
      onImageryDecision: (d) => { decision = d; },
    });

    const serverWs = await conn;
    serverWs.send(JSON.stringify({
      type: "imagery_decision",
      narrativeId: "n2",
      broadcastId: "b4",
      imagery: { action: "generate", prompt: "a referee in golden light" },
    }));

    const result = await waitFor(() => decision) as {
      narrativeId: string;
      broadcastId: string;
      imagery: { action: string; prompt: string };
    };
    assert.equal(result.narrativeId, "n2");
    assert.equal(result.broadcastId, "b4");
    assert.equal(result.imagery.action, "generate");
    sub.close();
  });

  it("forwards generation_skipped messages to onGenerationSkipped", async () => {
    let skipped: unknown = null;
    const conn = nextConnection();
    const sub = subscribeFeed("b5", {
      onEntry: () => {},
      onGenerationSkipped: (s) => { skipped = s; },
    });

    const serverWs = await conn;
    serverWs.send(JSON.stringify({
      type: "generation_skipped",
      reason: "rate_limited",
      retryAfterMs: 30_000,
      triggerReason: "accumulation",
    }));

    const result = await waitFor(() => skipped) as {
      reason: string; retryAfterMs: number; triggerReason: string;
    };
    assert.equal(result.reason, "rate_limited");
    assert.equal(result.retryAfterMs, 30_000);
    assert.equal(result.triggerReason, "accumulation");
    sub.close();
  });

  it("invokes onClose when the server closes intentionally (after sub.close())", async () => {
    let closed = false;
    const conn = nextConnection();
    const sub = subscribeFeed("b6", {
      onEntry: () => {},
      onClose: () => { closed = true; },
    });
    await conn; // wait until upgrade lands
    sub.close();
    await waitFor(() => (closed ? true : null));
    assert.equal(closed, true);
  });

  it("ignores messages with unknown types without throwing", async () => {
    let entryReceived = false;
    const conn = nextConnection();
    const sub = subscribeFeed("b7", {
      onEntry: () => { entryReceived = true; },
    });

    const serverWs = await conn;
    serverWs.send(JSON.stringify({ type: "unknown_message_type", payload: "garbage" }));
    serverWs.send(JSON.stringify({ type: "entry", entry: { id: "e-real", data: { eventType: "GOAL" } } }));

    await waitFor(() => (entryReceived ? true : null));
    assert.equal(entryReceived, true);
    sub.close();
  });

  it("authenticates with Bearer KAIROS_API_KEY on the upgrade request", async () => {
    let authHeaderSeen: string | undefined;
    const oneOff = new Promise<void>((resolve) => {
      wss.once("connection", (_ws, req) => {
        authHeaderSeen = req.headers.authorization;
        resolve();
      });
    });

    const sub = subscribeFeed("b8", { onEntry: () => {} });
    await oneOff;
    assert.equal(authHeaderSeen, "Bearer test-key");
    sub.close();
  });
});

describe("subscribeFeed — phase-entry roundtrip via realistic message order", () => {
  it("delivers the conductor's own KICKOFF synthetic entry back via WS, in the order Kairos would push", async () => {
    // The exact sequence Kairos sends after a fresh activation:
    //   1. sync (zero entries on a fresh broadcast)
    //   2. entry — narrative_voice (pushed during activation)
    //   3. entry — narrative_context
    //   4. entry — KICKOFF synthetic (pushed by conductor.transitionTo
    //      after Sportmonks first poll)
    // The Blackout's conductor relies on every one of those `entry`
    // events firing onEntry. If the WS client mis-parses the wire
    // format, the matchroom never sees KICKOFF — exactly the
    // 2026-05-02 live symptom.
    const synced: unknown[] = [];
    const entries: Array<{ data: { eventType?: string; content?: string } }> = [];
    const conn = nextConnection();
    const sub = subscribeFeed("b-sequence", {
      onSync: (s) => synced.push(s),
      onEntry: (e) => entries.push(e as { data: { eventType?: string; content?: string } }),
    });

    const serverWs = await conn;
    serverWs.send(JSON.stringify({ type: "sync", entries: [] }));
    serverWs.send(JSON.stringify({
      type: "entry",
      entry: { id: "e1", source: "narrative_voice", data: { content: "voice brief" } },
    }));
    serverWs.send(JSON.stringify({
      type: "entry",
      entry: { id: "e2", source: "narrative_context", data: { content: "context brief" } },
    }));
    serverWs.send(JSON.stringify({
      type: "entry",
      entry: {
        id: "e3",
        source: "match_events",
        data: { eventType: "KICKOFF", synthetic: true, content: "Kickoff", subjectTime: "1" },
      },
    }));

    await waitFor(() => (entries.length === 3 ? true : null));
    assert.equal(synced.length, 1);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].data.content, "voice brief");
    assert.equal(entries[1].data.content, "context brief");
    assert.equal(entries[2].data.eventType, "KICKOFF");
    sub.close();
  });
});
