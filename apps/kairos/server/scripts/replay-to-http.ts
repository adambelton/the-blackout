/**
 * Replay past source entries from the Kairos DB into a running Kairos
 * server over HTTP. Unlike `scripts/replay.ts` (which runs Kairos
 * in-process for quality testing), this version pushes to a live
 * Kairos on `localhost:5050` so an external consumer — the Blackout
 * server's RoomConductor — can subscribe over the normal WS and
 * exercise the real multi-process pipeline end-to-end.
 *
 * Expected flow:
 *   1. Kairos server running on :5050
 *   2. Blackout server running on :4000
 *   3. A fresh Blackout broadcast created + activated (this creates
 *      and activates the TARGET Kairos broadcast via kairos-bridge)
 *   4. Run this script with:
 *        SOURCE_BROADCAST_ID=<past Kairos broadcast uuid> \
 *        TARGET_BROADCAST_ID=<new Kairos broadcast uuid> \
 *        [SPEED=5] [MAX_ENTRIES=150]
 *
 * The script reads past entries from the local Kairos Postgres, sorts
 * by timestamp, and replays them at accelerated speed to the target
 * broadcast. Kairos's pipeline generates narratives live, which flow
 * over WS to the Blackout conductor, which synthesises TTS and emits
 * play cues to every subscribed browser.
 */

import "../src/env.js";
import { asc, eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import { feedEntries, sources as sourcesTable } from "../src/db/schema.js";

const SOURCE_BROADCAST_ID = process.env.SOURCE_BROADCAST_ID;
const TARGET_BROADCAST_ID = process.env.TARGET_BROADCAST_ID;
const KAIROS_URL = process.env.KAIROS_URL ?? "http://localhost:5050";
const SPEED = parseFloat(process.env.SPEED ?? "5");
const START_INDEX = process.env.START_INDEX
  ? parseInt(process.env.START_INDEX, 10)
  : 0;
const MAX_ENTRIES = process.env.MAX_ENTRIES
  ? parseInt(process.env.MAX_ENTRIES, 10)
  : 200;

if (!SOURCE_BROADCAST_ID || !TARGET_BROADCAST_ID) {
  console.error(
    "Usage: SOURCE_BROADCAST_ID=<past uuid> TARGET_BROADCAST_ID=<new uuid> pnpm tsx scripts/replay-to-http.ts",
  );
  process.exit(1);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postEntry(
  sourceName: string,
  data: unknown,
): Promise<void> {
  // Don't forward the source entry's original timestamp — Kairos's
  // context assembler uses feed_entry.timestamp for wall-clock
  // recency, and entries from yesterday's live broadcast get dropped
  // as stale (found during 2026-04-22 Brighton-Chelsea replay).
  // Omit timestamp → Kairos stamps it now(), so successive pushes
  // land with realistic inter-entry spacing driven by the replay's
  // own pacing. The in-data `subjectTime` / `minute` / `phase` still
  // carry the original match-time, which is what the narrator sees.
  const res = await fetch(
    `${KAIROS_URL}/broadcasts/${TARGET_BROADCAST_ID}/entries`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: sourceName, data }),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`POST entries failed: ${res.status} ${body.slice(0, 200)}`);
  }
}

async function main() {
  console.log(`[replay-http] source broadcast: ${SOURCE_BROADCAST_ID}`);
  console.log(`[replay-http] target broadcast: ${TARGET_BROADCAST_ID}`);
  console.log(`[replay-http] speed: ${SPEED}x, cap: ${MAX_ENTRIES} entries`);

  // Pull source names from the source broadcast — we push by source
  // name (Kairos looks up the target's source row by name).
  const origSources = await db
    .select()
    .from(sourcesTable)
    .where(eq(sourcesTable.broadcastId, SOURCE_BROADCAST_ID!));
  if (origSources.length === 0) {
    console.error(`[replay-http] no sources found for ${SOURCE_BROADCAST_ID}`);
    process.exit(1);
  }

  const origRows = await db
    .select({ entry: feedEntries, source: sourcesTable })
    .from(feedEntries)
    .innerJoin(sourcesTable, eq(feedEntries.sourceId, sourcesTable.id))
    .where(eq(feedEntries.broadcastId, SOURCE_BROADCAST_ID!))
    .orderBy(asc(feedEntries.timestamp));

  // Ambient entries (voice + context) are seeded at activation by the
  // Blackout's kairos-bridge; skip them here so we don't duplicate.
  const liveAll = origRows.filter(
    (r) =>
      r.source.type !== "narrative_voice" &&
      r.source.type !== "narrative_context",
  );
  const live = liveAll.slice(START_INDEX, START_INDEX + MAX_ENTRIES);
  console.log(
    `[replay-http] ${liveAll.length} live entries available, replaying ${live.length} (offset ${START_INDEX})`,
  );

  if (live.length === 0) {
    console.error("[replay-http] nothing to replay");
    process.exit(1);
  }

  // Walk through entries, sleeping for the scaled-down gap between
  // each consecutive pair's timestamps.
  let firstTs: number | null = null;
  const startedAt = Date.now();
  let pushed = 0;

  for (let i = 0; i < live.length; i++) {
    const { entry, source } = live[i];
    const ts = new Date(entry.timestamp as unknown as string).getTime();
    if (firstTs == null) firstTs = ts;
    const elapsedSourceMs = ts - firstTs;
    const targetWallMs = startedAt + elapsedSourceMs / SPEED;
    const waitMs = Math.max(0, targetWallMs - Date.now());
    if (waitMs > 0) await sleep(waitMs);

    try {
      await postEntry(source.name, entry.data);
      pushed++;
      if (pushed % 20 === 0 || pushed === live.length) {
        const realElapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const sourceElapsedSec = Math.round(elapsedSourceMs / 1000);
        console.log(
          `[replay-http] pushed ${pushed}/${live.length} (source +${sourceElapsedSec}s, wall +${realElapsedSec}s)`,
        );
      }
    } catch (err) {
      console.error(`[replay-http] push failed at entry ${i}: ${(err as Error).message}`);
      process.exit(1);
    }
  }

  console.log(`[replay-http] done — ${pushed} entries pushed`);
  // Give Kairos a beat to flush final cycles before we exit.
  await sleep(5000);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[replay-http] FAILED: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
