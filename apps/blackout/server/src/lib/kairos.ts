import WebSocket from "ws";
import {
  SOURCE,
  type PipelineCycleSummary,
  type PipelineCycleDetail,
  type PipelineGeneration,
} from "@blackout/shared";
import { startHeartbeat } from "./kairos-heartbeat.js";

const KAIROS_URL = process.env.KAIROS_URL || "http://localhost:5050";
const KAIROS_API_KEY = process.env.KAIROS_API_KEY;

function baseUrl(): string {
  return KAIROS_URL.replace(/\/$/, "");
}

function wsUrl(): string {
  return baseUrl().replace(/^http/, "ws");
}

function authHeaders(): Record<string, string> {
  // Kairos gates every non-health route on a Bearer token. Missing
  // the key is almost certainly a misconfigured deploy — fail loud
  // so the operator notices instead of silently 401-ing every call.
  if (!KAIROS_API_KEY) {
    throw new Error(
      "KAIROS_API_KEY is not set — Blackout server cannot authenticate to Kairos",
    );
  }
  return { Authorization: `Bearer ${KAIROS_API_KEY}` };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Kairos ${method} ${path} ${res.status}: ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

// --- Types matching Kairos's API responses ---

export type KairosSourceType =
  | "event"
  | "moderator"
  | "narrative_context"
  | "narrative_voice";

export interface KairosSourceInput {
  name: string;
  type: KairosSourceType;
  canonical?: boolean;
}

export interface KairosBroadcast {
  id: string;
  status: "pending" | "active" | "paused" | "complete";
  eventProfileName: string;
  createdAt: string;
  updatedAt: string;
}

interface BroadcastEnvelope {
  broadcast: KairosBroadcast;
  sources?: unknown[];
  resolvedSpecs?: unknown;
}

export interface KairosFeedEntry {
  id: string;
  source: string;
  data: Record<string, unknown>;
  timestamp: string;
  created_at: string;
}

interface KairosHealth {
  status: string;
  timestamp: string;
  services: { name: string; status: string; message?: string }[];
}

export interface KairosNarrativeCover {
  entryId: string;
  subjectTime?: string;
  /** Char offset in the prose where the generator anchored this
   * entry (from the stripped `{{ref:...}}` marker). Consumers map
   * `charOffset / prose.length * audioDurationMs` to schedule
   * per-entry reveals in sync with the narrator's speech. Absent
   * when no anchor was placed — fall back to audio-end reveal. */
  charOffset?: number;
}

/**
 * Imagery decision produced by Kairos's parallel Haiku call. Arrives
 * twice: once as an early `imagery_decision` WS message the moment
 * Haiku finishes (ahead of the Sonnet narrative, so the conductor can
 * start image work in parallel), and again attached to the later
 * `narrative` message.
 *
 * Decisions:
 * - `pool`: pick a pre-prepared item the consumer pushed to Kairos's
 *   content pool. Carries `poolItemId` and opaque `consumerMetadata`
 *   threaded back from that item — the consumer resolves its own
 *   bytes from that blob.
 * - `generate`: the consumer's image provider (Replicate, here) runs
 *   with `prompt` to produce fresh bytes.
 * - `hold`: keep whatever's currently displayed. Emitted on LLM
 *   failure or malformed output.
 */
export interface KairosNarrativeImagery {
  decision: "pool" | "generate" | "hold";
  prompt?: string;
  poolItemId?: string;
  consumerMetadata?: Record<string, unknown> | null;
  rationale?: string;
}

/** Shape of the early-fire `imagery_decision` WS message. */
export interface KairosImageryDecision {
  narrativeId: string;
  broadcastId: string;
  imagery: KairosNarrativeImagery;
}

export interface KairosNarrativeOutput {
  id: string;
  broadcastId: string;
  text: string;
  wordCount?: number;
  generatedAt: string;
  /**
   * Entries the narrator explicitly cited — a strict subset of
   * `batchEntryIds` filtered to what the prose materially references.
   */
  covers?: KairosNarrativeCover[];
  /**
   * Entries that appeared in this cycle's batch — i.e. everything
   * new since the prior cycle's trigger, minus ambient sources.
   * Consumers use this for UI reveal-gating: audio-end reveals every
   * batch entry the narrator didn't explicitly cite. Superset of
   * `covers`. May include entries curation dropped from the
   * generator's view — the reveal contract is about what the cycle
   * observed, not what the prose drew on.
   */
  batchEntryIds?: string[];
  /**
   * Earliest `subjectTime` across the cycle's batch, parsed-leading-int
   * (so `"45+2"` → 45). Null when no batch entry carries a numeric
   * subjectTime. Consumers drive the match clock from this at the
   * moment the passage's audio begins — decoupling the clock from
   * specific event coverage.
   */
  contentTime?: number | null;
  /** Imagery decision — paired with this narrative. May be absent on
   * Kairos-side failure (conductor should then hold whatever's on screen). */
  imagery?: KairosNarrativeImagery;
}

export interface KairosGenerationSkipped {
  reason: "rate_limited" | string;
  retryAfterMs?: number;
  triggerReason?: string;
}

export type PacingSignal = "slow_down" | "speed_up" | "on_track";

// --- Client API ---

export async function getHealth(): Promise<KairosHealth> {
  return request("GET", "/health");
}

/**
 * Create a broadcast in Kairos.
 *
 * Sources are declared inline. Every broadcast must include exactly one
 * `narrative_context` and one `narrative_voice` source for Kairos to
 * accept activation. Tags and spec overrides are resolved by Kairos
 * from the selected `eventProfile`.
 */
export async function createBroadcast(input: {
  eventProfile: string;
  sources: KairosSourceInput[];
}): Promise<KairosBroadcast> {
  const envelope = await request<BroadcastEnvelope>("POST", "/broadcasts", {
    event_profile: input.eventProfile,
    sources: input.sources,
  });
  return envelope.broadcast;
}

export async function getBroadcast(id: string): Promise<KairosBroadcast> {
  const envelope = await request<BroadcastEnvelope>("GET", `/broadcasts/${id}`);
  return envelope.broadcast;
}

export async function deleteBroadcast(id: string): Promise<void> {
  await request("DELETE", `/broadcasts/${id}`);
}

export async function activateBroadcast(id: string): Promise<KairosBroadcast> {
  const envelope = await request<BroadcastEnvelope>("PATCH", `/broadcasts/${id}`, {
    status: "active",
  });
  return envelope.broadcast;
}

export async function completeBroadcast(id: string): Promise<KairosBroadcast> {
  const envelope = await request<BroadcastEnvelope>("PATCH", `/broadcasts/${id}`, {
    status: "complete",
  });
  return envelope.broadcast;
}

/**
 * Push an entry onto a broadcast's feed.
 *
 * `source` is the source name as registered at broadcast creation.
 * `data` is the consumer-shaped payload — football-specific fields
 * (minute, extraMinute, content, player…) live inside it.
 */
export async function pushEntry(
  broadcastId: string,
  entry: {
    source: string;
    data: Record<string, unknown>;
    timestamp?: string;
  },
): Promise<KairosFeedEntry> {
  return request("POST", `/broadcasts/${broadcastId}/entries`, entry);
}

export async function sendFeedback(
  broadcastId: string,
  signal: PacingSignal,
  wordsPerMinute: number,
): Promise<void> {
  await request("POST", `/broadcasts/${broadcastId}/feedback`, {
    signal,
    words_per_minute: wordsPerMinute,
  });
}

/**
 * Trigger an off-schedule cycle on Kairos with a consumer-supplied
 * preamble. The pipeline runs its normal enrich → curate → generate
 * path; the preamble is spliced verbatim into the LLM's user message
 * so the consumer can shape the moment for things only the consumer's
 * domain understands (a halftime reflection, a closing passage, etc.).
 *
 * Replaces the older `triggerReason: string` interface — Kairos's
 * `trigger_reason` enum is now domain-agnostic (`accumulation` /
 * `external`) and football-specific labels are owned by the Blackout
 * side. The conductor builds the actual prompt text and passes it
 * through here.
 */
export async function triggerNarrativeGeneration(
  broadcastId: string,
  consumerPrompt: string,
): Promise<void> {
  await request(
    "POST",
    `/broadcasts/${broadcastId}/narrative/generate`,
    { consumerPrompt },
  );
}

/**
 * The most recent gameplay-state transition entry on a broadcast (the
 * synthetic match_events entries the conductor pushes on phase change:
 * KICKOFF / HALFTIME / SECOND_HALF_KICKOFF / FULL_TIME). Used at
 * conductor startup to recover the broadcast's current phase from
 * history rather than restarting at `warming` and racing through the
 * FSM via the feed's sync-on-connect (which would re-push every
 * transition entry as a duplicate). Returns the eventType of the
 * latest transition, or null if no transition has happened yet.
 */
const TRANSITION_EVENT_TYPES = new Set([
  "KICKOFF",
  "HALFTIME",
  "SECOND_HALF_KICKOFF",
  "FULL_TIME",
]);

export async function getLatestTransitionEventType(
  broadcastId: string,
): Promise<"KICKOFF" | "HALFTIME" | "SECOND_HALF_KICKOFF" | "FULL_TIME" | null> {
  const entries = await listBroadcastEntries(broadcastId, { source: SOURCE.matchEvents });
  let latest: { eventType: string; timestamp: number } | null = null;
  for (const entry of entries) {
    const data = entry.data as Record<string, unknown> | undefined;
    const eventType = typeof data?.eventType === "string" ? data.eventType : null;
    if (!eventType || !TRANSITION_EVENT_TYPES.has(eventType)) continue;
    const ts = typeof entry.timestamp === "number"
      ? entry.timestamp
      : Date.parse((entry.created_at as string) ?? "") || 0;
    if (!latest || ts > latest.timestamp) {
      latest = { eventType, timestamp: ts };
    }
  }
  return latest
    ? (latest.eventType as "KICKOFF" | "HALFTIME" | "SECOND_HALF_KICKOFF" | "FULL_TIME")
    : null;
}

// --- Pipeline inspector (completed broadcasts) ---

/** List pipeline-cycle summaries for a broadcast, newest-first. */
export async function listCycles(
  broadcastId: string,
  limit = 200,
): Promise<PipelineCycleSummary[]> {
  const { cycles } = await request<{ cycles: PipelineCycleSummary[] }>(
    "GET",
    `/broadcasts/${broadcastId}/cycles?limit=${limit}`,
  );
  return cycles;
}

/** Fetch the full detail payload for a single cycle. */
export async function getCycle(
  broadcastId: string,
  cycleId: string,
): Promise<PipelineCycleDetail> {
  return request("GET", `/broadcasts/${broadcastId}/cycles/${cycleId}`);
}

/** Fetch the broadcast-level flow-health summary — wall / content
 * / prose / target. Used by the inspector's header. */
export async function getBroadcastHealth(
  broadcastId: string,
): Promise<import("@blackout/shared").BroadcastHealth> {
  return request("GET", `/broadcasts/${broadcastId}/health`);
}

/** Fetch a persisted generation by id. */
export async function getGeneration(
  broadcastId: string,
  generationId: string,
): Promise<PipelineGeneration> {
  return request("GET", `/broadcasts/${broadcastId}/generations/${generationId}`);
}

/** List every generation for a broadcast. Used by the moderator
 * bootstrap to restore the narratives panel after a refresh — the
 * Kairos `triggeredAt` ordering is descending; the moderator UI
 * sorts ascending so callers should resort if needed. */
export async function listGenerations(
  broadcastId: string,
): Promise<PipelineGeneration[]> {
  const { generations } = await request<{ generations: PipelineGeneration[] }>(
    "GET",
    `/broadcasts/${broadcastId}/generations`,
  );
  return generations;
}

/**
 * Query feed entries on a Kairos broadcast, typically to surface the
 * voice / context ambient entries for the inspector header. Permissive
 * shape — inspector reads `data.content` and the caller doesn't need
 * strict typing for entries it's only rendering.
 */
export async function listBroadcastEntries(
  broadcastId: string,
  params: { source?: string } = {},
): Promise<Array<Record<string, unknown>>> {
  const query = params.source ? `?source=${encodeURIComponent(params.source)}` : "";
  const { entries } = await request<{ entries: Array<Record<string, unknown>> }>(
    "GET",
    `/broadcasts/${broadcastId}/entries${query}`,
  );
  return entries;
}

// --- Content pool ---
//
// Kairos holds the pool authoritatively; Blackout's studio routes
// proxy through this client. Pool items carry an opaque
// `consumer_metadata` blob the consumer populates with whatever
// pointer it needs — for Blackout, that's the illustrationId of the
// local broadcast_illustrations row holding the image bytes.

export interface KairosPoolItem {
  id: string;
  broadcastId: string;
  prompt: string;
  tags: string[];
  consumerMetadata: Record<string, unknown> | null;
  createdAt: number;
}

export async function listPoolItems(
  broadcastId: string,
): Promise<KairosPoolItem[]> {
  const { items } = await request<{ items: KairosPoolItem[] }>(
    "GET",
    `/broadcasts/${broadcastId}/pool`,
  );
  return items;
}

export async function createPoolItem(
  broadcastId: string,
  input: {
    prompt: string;
    tags?: string[];
    consumerMetadata?: Record<string, unknown> | null;
  },
): Promise<KairosPoolItem> {
  return request("POST", `/broadcasts/${broadcastId}/pool`, {
    prompt: input.prompt,
    tags: input.tags ?? [],
    consumer_metadata: input.consumerMetadata ?? null,
  });
}

export async function updatePoolItem(
  broadcastId: string,
  itemId: string,
  updates: {
    tags?: string[];
    consumerMetadata?: Record<string, unknown> | null;
  },
): Promise<KairosPoolItem> {
  const body: Record<string, unknown> = {};
  if (updates.tags !== undefined) body.tags = updates.tags;
  if (updates.consumerMetadata !== undefined)
    body.consumer_metadata = updates.consumerMetadata;
  return request("PATCH", `/broadcasts/${broadcastId}/pool/${itemId}`, body);
}

export async function deletePoolItem(
  broadcastId: string,
  itemId: string,
): Promise<void> {
  await request("DELETE", `/broadcasts/${broadcastId}/pool/${itemId}`);
}

/**
 * Subscribe to a broadcast's feed via WebSocket. Reconnects with
 * exponential backoff (1s, 2s, 4s, capped at 10s) if Kairos closes
 * the connection — important because tsx-watch restarts of Kairos
 * (dev) and platform-level restarts (prod) would otherwise orphan
 * the Blackout's conductor and silently stop narrations reaching
 * the matchroom. Confirmed failure mode 2026-04-22 Burnley-City.
 *
 * Returns a control object with `.close()` — callers don't touch
 * the underlying socket. `close()` tears down the subscription
 * *intentionally*, and the auto-reconnect path will not fire.
 */
export interface FeedSubscription {
  close: () => void;
}

/** Heartbeat constants. The conductor's WS subscription to Kairos
 * relies on these to detect a half-open connection — TCP-alive but
 * Kairos's runtime no longer routes narratives to the subscriber.
 *
 * Real bug from 2026-04-26: Kairos restarted multiple times during
 * mid-broadcast edits. The conductor's TCP socket stayed in a
 * "connected" state after each restart, but Kairos's new runtime had
 * no record of the subscriber. Result: 1h 56m of silent broadcast.
 * TCP keepalive alone is insufficient; an application-level ping +
 * timeout catches the half-open state within `intervalMs + timeoutMs`. */
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

export function subscribeFeed(
  broadcastId: string,
  callbacks: {
    onEntry: (entry: KairosFeedEntry) => void;
    onSync?: (entries: KairosFeedEntry[]) => void;
    onNarrative?: (narrative: KairosNarrativeOutput) => void;
    /** Early-fire imagery decision, ahead of the paired narrative. */
    onImageryDecision?: (decision: KairosImageryDecision) => void;
    onGenerationSkipped?: (info: KairosGenerationSkipped) => void;
    onClose?: () => void;
  },
): FeedSubscription {
  let ws: WebSocket | null = null;
  let intentionallyClosed = false;
  let reconnectAttempt = 0;
  let heartbeat: ReturnType<typeof startHeartbeat> | null = null;

  const connect = (): void => {
    // WebSocket handshake sends the Authorization header like any
    // other HTTP request, so Kairos's apiKeyAuth middleware (which
    // applies to /*) gates the upgrade the same way REST routes go.
    ws = new WebSocket(
      `${wsUrl()}/broadcasts/${broadcastId}/feed`,
      { headers: authHeaders() },
    );

    ws.on("open", () => {
      if (reconnectAttempt > 0) {
        console.log(`[kairos-client] feed WS reconnected after ${reconnectAttempt} attempt(s)`);
      }
      reconnectAttempt = 0;
      // Tear down any previous-cycle heartbeat (defensive — close
      // handler clears it, but `open` is the right place to restart
      // the cycle on a fresh socket).
      heartbeat?.stop();
      const socket = ws;
      if (!socket) return;
      heartbeat = startHeartbeat(
        {
          ping: () => {
            if (socket.readyState !== WebSocket.OPEN) return;
            try { socket.ping(); } catch { /* socket gone — close handler will fire */ }
          },
          terminate: () => {
            console.warn(
              `[kairos-client] feed WS heartbeat timeout (no pong in ${HEARTBEAT_TIMEOUT_MS}ms) — terminating to force reconnect`,
            );
            try { socket.terminate(); } catch { /* already gone */ }
          },
        },
        { intervalMs: HEARTBEAT_INTERVAL_MS, timeoutMs: HEARTBEAT_TIMEOUT_MS },
      );
    });

    ws.on("pong", () => {
      // Kairos answered our ping — connection is alive end-to-end.
      heartbeat?.onPong();
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "sync" && callbacks.onSync) {
          callbacks.onSync(msg.entries);
        } else if (msg.type === "entry") {
          callbacks.onEntry(msg.entry);
        } else if (msg.type === "narrative" && callbacks.onNarrative) {
          callbacks.onNarrative(msg.narrative);
        } else if (msg.type === "imagery_decision" && callbacks.onImageryDecision) {
          callbacks.onImageryDecision({
            narrativeId: msg.narrativeId,
            broadcastId: msg.broadcastId,
            imagery: msg.imagery,
          });
        } else if (msg.type === "generation_skipped" && callbacks.onGenerationSkipped) {
          callbacks.onGenerationSkipped({
            reason: msg.reason,
            retryAfterMs: msg.retryAfterMs,
            triggerReason: msg.triggerReason,
          });
        }
      } catch {
        console.error("[kairos-client] failed to parse WS message");
      }
    });

    ws.on("unexpected-response", (_req, res) => {
      console.error(
        `[kairos-client] WS handshake rejected: ${res.statusCode} ${res.statusMessage}`,
      );
    });

    ws.on("close", (code, reason) => {
      heartbeat?.stop();
      heartbeat = null;
      const reasonStr = reason?.toString("utf8") || "";
      if (intentionallyClosed) {
        console.log(
          `[kairos-client] feed WS closed intentionally (code=${code}${reasonStr ? `, reason="${reasonStr}"` : ""})`,
        );
        callbacks.onClose?.();
        return;
      }
      const delayMs = Math.min(10_000, 1000 * 2 ** reconnectAttempt);
      reconnectAttempt++;
      console.log(
        `[kairos-client] feed WS closed (code=${code}${reasonStr ? `, reason="${reasonStr}"` : ""}) — reconnecting in ${delayMs}ms (attempt ${reconnectAttempt})`,
      );
      setTimeout(() => {
        if (intentionallyClosed) return;
        connect();
      }, delayMs);
    });

    ws.on("error", (err) => {
      console.error("[kairos-client] WS error:", err.message);
    });
  };

  connect();

  return {
    close: () => {
      intentionallyClosed = true;
      heartbeat?.stop();
      heartbeat = null;
      try { ws?.close(); } catch { /* already closed */ }
    },
  };
}
