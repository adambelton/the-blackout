/**
 * Full-stack replay: pump a previously captured broadcast's feed through
 * the Blackout + Kairos pipeline as-if-live, so RoomConductor fires real
 * Claude (via Kairos), real Replicate (illustrations), and real OpenAI
 * (TTS) against captured source data.
 *
 * Contrast with `apps/kairos/server/scripts/replay.ts`, which replays directly
 * against the Kairos engine and skips the Blackout side entirely. That
 * script is cheap and fast for validating engine mechanics; this script
 * exists to feel what a broadcast looks like end-to-end.
 *
 * Flow:
 *   1. Create a fresh Blackout broadcast (no fixture, no radio source —
 *      BroadcastRunner soft-fails, leaving the RoomConductor in charge.
 *      That's exactly what we want: no contaminating Sportmonks polling
 *      and no live Deepgram transcription mixing with the replay).
 *   2. PATCH briefs from the captured broadcast (and optional TTS voice).
 *   3. Activate → Blackout flips to live, RoomConductor subscribes to
 *      Kairos, and Kairos spins up its narrative pipeline.
 *   4. Stream the captured Kairos entries (minus ambients, which the
 *      activation path has already seeded) into the new Kairos broadcast
 *      at SPEED×, preserving original cadence. Optionally windowed to
 *      [kickoff - N, kickoff + M] seconds for short voice/pipeline smokes.
 *   5. Leave the broadcast live for manual exploration. User completes
 *      it via the moderator console when done.
 *
 * Usage (full replay, 10×):
 *   SOURCE_BROADCAST_ID=f037784b-... pnpm --filter @blackout/server \
 *     exec tsx scripts/replay-full-stack.ts [SPEED=10]
 *
 * Usage (voice smoke — real-time, kickoff-anchored 7-min window, Hume voice):
 *   SOURCE_BROADCAST_ID=f037784b-... \
 *   SPEED=1 \
 *   WINDOW_BEFORE_KICKOFF_SEC=120 \
 *   WINDOW_AFTER_KICKOFF_SEC=300 \
 *   TTS_VOICE_ID=... TTS_PROVIDER=hume \
 *     pnpm --filter @blackout/server exec tsx scripts/replay-full-stack.ts
 */

import "../src/env.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_BROADCAST_ID = process.env.SOURCE_BROADCAST_ID ?? process.argv[2];
// Alternative to SOURCE_BROADCAST_ID when the source broadcast is no
// longer in Kairos' DB — read from the on-disk export produced by
// `apps/kairos/server/scripts/export-broadcast.ts` instead.
const SOURCE_LOCAL_DIR = process.env.SOURCE_LOCAL_DIR || null;
const SPEED = parseFloat(process.env.SPEED ?? "1");
const BLACKOUT_URL = process.env.BLACKOUT_URL ?? "http://localhost:4000";
const KAIROS_URL = process.env.KAIROS_URL ?? "http://localhost:5050";
const MAX_ENTRIES = process.env.MAX_ENTRIES ? parseInt(process.env.MAX_ENTRIES, 10) : null;
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || null;
const TTS_PROVIDER = process.env.TTS_PROVIDER || null;
const WINDOW_BEFORE_KICKOFF_SEC = process.env.WINDOW_BEFORE_KICKOFF_SEC
  ? parseFloat(process.env.WINDOW_BEFORE_KICKOFF_SEC)
  : null;
const WINDOW_AFTER_KICKOFF_SEC = process.env.WINDOW_AFTER_KICKOFF_SEC
  ? parseFloat(process.env.WINDOW_AFTER_KICKOFF_SEC)
  : null;

if (!SOURCE_BROADCAST_ID && !SOURCE_LOCAL_DIR) {
  console.error(
    "Usage: SOURCE_BROADCAST_ID=<kairos-uuid> [or] SOURCE_LOCAL_DIR=<path> pnpm --filter @blackout/server exec tsx scripts/replay-full-stack.ts",
  );
  process.exit(1);
}

interface CapturedEntry {
  id: string;
  sourceName: string;
  sourceType: string;
  timestamp: string;
  data: Record<string, unknown>;
}

// Load a previously captured broadcast's brief + entries from the
// on-disk export (events.jsonl + transcription.txt + narrative_context.md).
// Used when the source broadcast is no longer in Kairos's DB.
function loadFromLocalDir(dir: string): {
  matchBrief: string;
  entries: CapturedEntry[];
} {
  const matchBrief = readFileSync(join(dir, "narrative_context.md"), "utf8");

  const entries: CapturedEntry[] = [];

  // events.jsonl → match_events entries. Each line is
  // `{ id, timestamp, ...data }` so strip the wrapping fields back out.
  const eventsRaw = readFileSync(join(dir, "events.jsonl"), "utf8");
  for (const line of eventsRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const obj = JSON.parse(trimmed) as Record<string, unknown>;
    const id = String(obj.id ?? "");
    const timestamp = String(obj.timestamp ?? "");
    if (!timestamp) continue;
    const { id: _, timestamp: __, ...data } = obj;
    entries.push({
      id,
      sourceName: "match_events",
      sourceType: "match_events",
      timestamp,
      data,
    });
  }

  // transcription.txt → transcription entries. Format per line (from
  // export-broadcast.ts): `<iso-ts> [<subjectTime>'] <content>` where
  // the trailing `'` is part of the emitted format.
  const transRaw = readFileSync(join(dir, "transcription.txt"), "utf8");
  const transRe = /^(\S+)\s+\[([^\]]*)\]\s*(.*)$/;
  for (const line of transRaw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = transRe.exec(trimmed);
    if (!m) continue;
    const [, ts, ctRaw, content] = m;
    // Strip the trailing `'` emitted by export-broadcast.ts.
    const subjectTime = ctRaw.replace(/'$/, "");
    entries.push({
      id: `local-tx-${entries.length}`,
      sourceName: "transcription",
      sourceType: "transcription",
      timestamp: ts,
      data: { content, subjectTime },
    });
  }

  // Kairos applies entries in timestamp order — events and transcription
  // share a wall clock, so interleave them chronologically.
  entries.sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return { matchBrief, entries };
}

function kairosHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const key = process.env.KAIROS_API_KEY;
  if (key) h["Authorization"] = `Bearer ${key}`;
  return h;
}

async function kairosGet<T>(path: string): Promise<T> {
  const res = await fetch(`${KAIROS_URL}${path}`, { headers: kairosHeaders() });
  if (!res.ok) throw new Error(`Kairos GET ${path} → ${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

async function kairosPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${KAIROS_URL}${path}`, {
    method: "POST",
    headers: kairosHeaders(),
    body: JSON.stringify(body),
  });
}

function blackoutHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const secret = process.env.INTERNAL_API_SECRET;
  if (secret) h["X-Internal-Api-Secret"] = secret;
  return h;
}

async function blackoutPost(path: string, body: unknown): Promise<Response> {
  return fetch(`${BLACKOUT_URL}${path}`, {
    method: "POST",
    headers: blackoutHeaders(),
    body: JSON.stringify(body),
  });
}

async function blackoutPatch(path: string, body: unknown): Promise<Response> {
  return fetch(`${BLACKOUT_URL}${path}`, {
    method: "PATCH",
    headers: blackoutHeaders(),
    body: JSON.stringify(body),
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log(
    `[replay] source: ${SOURCE_LOCAL_DIR ?? SOURCE_BROADCAST_ID}  speed: ${SPEED}×`,
  );

  // 1. Load the captured brief + entries. Prefer the local directory
  //    when set (Kairos DB may have been reset); otherwise pull from
  //    Kairos, which remains the source of truth when the original
  //    broadcast still exists there.
  let matchBrief: string;
  let live: CapturedEntry[];
  if (SOURCE_LOCAL_DIR) {
    const loaded = loadFromLocalDir(SOURCE_LOCAL_DIR);
    matchBrief = loaded.matchBrief;
    live = loaded.entries;
  } else {
    const { entries } = await kairosGet<{ entries: CapturedEntry[] }>(
      `/broadcasts/${SOURCE_BROADCAST_ID}/entries`,
    );
    const context = entries.find((e) => e.sourceType === "narrative_context");
    if (!context) {
      throw new Error("Source broadcast is missing narrative_context entry");
    }
    matchBrief = String((context.data.content as string) ?? "");
    live = entries.filter(
      (e) =>
        e.sourceType !== "narrative_voice" && e.sourceType !== "narrative_context",
    );
  }

  // Kickoff-anchored window: pull the earliest entry whose data marks
  // `phase: "first_half"` + `phaseSecond`, back-solve to the wall-clock
  // time of kickoff, and keep only entries inside [kickoff - before,
  // kickoff + after]. If either bound is unset, that side is unbounded.
  let windowed = live;
  if (WINDOW_BEFORE_KICKOFF_SEC != null || WINDOW_AFTER_KICKOFF_SEC != null) {
    const anchor = live.find((e) => {
      const d = e.data as { phase?: unknown; phaseSecond?: unknown };
      return d.phase === "first_half" && typeof d.phaseSecond === "number";
    });
    if (!anchor) {
      throw new Error(
        "Kickoff-windowed replay requires a first_half entry with phaseSecond in the source — none found",
      );
    }
    const phaseSecond = Number((anchor.data as { phaseSecond: number }).phaseSecond);
    const kickoffMs = new Date(anchor.timestamp).getTime() - phaseSecond * 1000;
    const fromMs =
      WINDOW_BEFORE_KICKOFF_SEC != null
        ? kickoffMs - WINDOW_BEFORE_KICKOFF_SEC * 1000
        : -Infinity;
    const toMs =
      WINDOW_AFTER_KICKOFF_SEC != null
        ? kickoffMs + WINDOW_AFTER_KICKOFF_SEC * 1000
        : Infinity;
    windowed = live.filter((e) => {
      const t = new Date(e.timestamp).getTime();
      return t >= fromMs && t <= toMs;
    });
    console.log(
      `[replay] kickoff @ ${new Date(kickoffMs).toISOString()}; window ` +
        `${WINDOW_BEFORE_KICKOFF_SEC ?? "∞"}s before → ` +
        `${WINDOW_AFTER_KICKOFF_SEC ?? "∞"}s after → ${windowed.length} entries`,
    );
  }

  const slice = MAX_ENTRIES != null ? windowed.slice(0, MAX_ENTRIES) : windowed;
  const cap = MAX_ENTRIES != null ? ` (capped from ${windowed.length})` : "";
  console.log(`[replay] source has ${live.length} live entries; ${windowed.length} in window${cap}; ${slice.length} will replay`);

  // 2. Derive a label from the captured briefs for the new broadcast
  //    header. Best-effort — falls back to the broadcast id if parsing
  //    fails.
  const headerLine = matchBrief.split("\n").find((l) => l.includes("vs")) ?? "";
  const teams = headerLine.match(/([A-Z][^.]*?)\s+vs\s+([A-Z][^.]*?)\./);
  const homeTeam = teams?.[1] ?? "Home (replay)";
  const awayTeam = teams?.[2] ?? "Away (replay)";

  const matchDate = new Date().toISOString();
  const create = await blackoutPost("/broadcasts", {
    homeTeam,
    awayTeam,
    competition: "Replay",
    matchDate,
    matchBrief,
  });
  if (!create.ok) {
    throw new Error(`Blackout broadcast create failed: ${create.status} ${await create.text()}`);
  }
  const blackout = (await create.json()) as {
    id: string;
    kairosBroadcastId: string;
  };
  console.log(`[replay] blackout broadcast: ${blackout.id}`);
  console.log(`[replay] kairos broadcast:   ${blackout.kairosBroadcastId}`);

  // 3. Override the TTS voice before activation if the env vars ask for it —
  //    smoke runs frequently want a specific provider/voice (e.g. Hume's
  //    booming british narrator) rather than the server default.
  if (TTS_VOICE_ID || TTS_PROVIDER) {
    const patch: Record<string, unknown> = {};
    if (TTS_VOICE_ID) patch.ttsVoiceId = TTS_VOICE_ID;
    if (TTS_PROVIDER) patch.ttsProvider = TTS_PROVIDER;
    const vp = await blackoutPatch(`/broadcasts/${blackout.id}`, patch);
    if (!vp.ok) {
      throw new Error(`Set TTS voice/provider failed: ${vp.status} ${await vp.text()}`);
    }
    console.log(`[replay] tts override: provider=${TTS_PROVIDER ?? "(default)"} voiceId=${TTS_VOICE_ID ?? "(default)"}`);
  }

  // Enable TTS. Broadcasts default to ttsEnabled=false (moderator toggles
  // it on pre-go-live); for a replay we want to hear the narrator
  // immediately.
  const tts = await blackoutPatch(`/broadcasts/${blackout.id}`, { ttsEnabled: true });
  if (!tts.ok) {
    throw new Error(`Enable TTS failed: ${tts.status} ${await tts.text()}`);
  }

  // 4. Flip to live. activateBroadcast will seed briefs, flip Kairos to
  //    active, and start the RoomConductor. The runner soft-fails on
  //    missing fixtureId/radioSourceId — that's intentional for replay.
  const activate = await blackoutPatch(`/broadcasts/${blackout.id}`, { status: "live" });
  if (!activate.ok) {
    throw new Error(`Activate failed: ${activate.status} ${await activate.text()}`);
  }
  console.log(`[replay] activated. matchroom: ${BLACKOUT_URL.replace(":4000", ":3000")}/matchroom/${blackout.id}`);
  console.log(`[replay] moderator: ${BLACKOUT_URL.replace(":4000", ":3000")}/moderator/${blackout.id}`);

  // Short delay so the conductor has time to attach to the Kairos feed
  // before entries start flooding in.
  await sleep(2000);

  // 4. Replay entries, preserving inter-arrival gaps scaled by SPEED.
  const firstTs = slice[0] ? new Date(slice[0].timestamp).getTime() : Date.now();
  const t0 = Date.now();
  let pushed = 0;
  let lastLog = Date.now();

  for (const entry of slice) {
    const origDelay = new Date(entry.timestamp).getTime() - firstTs;
    const scaled = origDelay / SPEED;
    const target = t0 + scaled;
    const wait = target - Date.now();
    if (wait > 5) await sleep(wait);

    const res = await kairosPost(`/broadcasts/${blackout.kairosBroadcastId}/entries`, {
      source: entry.sourceName,
      data: entry.data,
    });
    if (!res.ok) {
      console.error(`[replay] push failed at ${pushed}: ${res.status} ${await res.text()}`);
      break;
    }
    pushed++;

    if (pushed % 100 === 0 || Date.now() - lastLog > 15_000) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`[replay] ${pushed}/${slice.length} pushed (t+${elapsed}s)`);
      lastLog = Date.now();
    }
  }

  console.log(`\n[replay] done. ${pushed} entries pushed.`);
  console.log(`[replay] broadcast ${blackout.id} left LIVE — complete it via the moderator console when ready.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
