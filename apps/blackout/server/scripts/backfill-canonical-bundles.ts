/**
 * Backfill canonical bundles on `broadcast_narrations` for a given
 * broadcast.
 *
 * Walks each narration in synthesis order, recomposes the matchroom
 * bundle (revealedCanonical + revealingCanonical) from existing
 * persisted data (covers + batchEntryIds + Kairos entries +
 * broadcast_illustrations), and writes the result to the row's
 * jsonb columns. Idempotent — rows that already carry a bundle are
 * skipped unless `--force` is passed.
 *
 * Use:
 *
 *   pnpm dlx tsx apps/blackout/server/scripts/backfill-canonical-bundles.ts \
 *     <broadcastId> [--force]
 *
 * Why a script and not part of the migration: this composes from
 * existing persisted data using the conductor's runtime helpers
 * (composePassageBundle), which requires Kairos round-trips and
 * storage signed-URL calls. Cleaner as an explicit one-shot than
 * baked into a SQL migration. Run once per broadcast that needs the
 * bundle path; subsequent broadcasts get bundles at synthesis time.
 */

import { eq } from "drizzle-orm";
import { db } from "../src/db/client.js";
import {
  broadcastNarrations,
  broadcastIllustrations,
  broadcasts,
} from "../src/db/schema.js";
import * as kairos from "../src/lib/kairos.js";
import { getStorage } from "../src/lib/storage/index.js";
import {
  applyRevealingCanonical,
  emptyCanonicalState,
  type BroadcastPhase,
  type CanonicalState,
} from "@blackout/shared";
import { composePassageBundle } from "../src/conductor/canonical-compose.js";
import type { KairosFeedEntry } from "../src/lib/kairos.js";
import { PHASE_FOR_TRANSITION_EVENT } from "../src/conductor/phase-logic.js";
import type { GameplayTransitionEventType } from "@blackout/shared";

async function main() {
  const broadcastId = process.argv[2];
  if (!broadcastId) {
    console.error(
      "Usage: tsx scripts/backfill-canonical-bundles.ts <broadcastId> [--force]",
    );
    process.exit(1);
  }
  const force = process.argv.includes("--force");

  const [broadcast] = await db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.id, broadcastId))
    .limit(1);
  if (!broadcast) {
    console.error(`Broadcast ${broadcastId} not found.`);
    process.exit(1);
  }
  if (!broadcast.kairosBroadcastId) {
    console.error(`Broadcast ${broadcastId} has no kairosBroadcastId — can't fetch entries.`);
    process.exit(1);
  }

  console.log(
    `Backfilling bundles for ${broadcast.homeTeam} vs ${broadcast.awayTeam}`,
  );
  console.log(`  broadcastId: ${broadcastId}`);
  console.log(`  status:      ${broadcast.status}`);
  console.log(`  force:       ${force}`);

  const narrationRows = await db
    .select()
    .from(broadcastNarrations)
    .where(eq(broadcastNarrations.broadcastId, broadcastId))
    .orderBy(broadcastNarrations.synthesizedAt);

  if (narrationRows.length === 0) {
    console.log("No narrations to backfill — nothing to do.");
    return;
  }

  console.log(`  narrations:  ${narrationRows.length}`);

  // Pull every Kairos feed entry so composePassageBundle can resolve
  // covers + batchEntryIds against canonical events.
  const allEntries = (await kairos.listBroadcastEntries(
    broadcast.kairosBroadcastId,
    {},
  )) as unknown as KairosFeedEntry[];
  const entryCache = new Map<string, KairosFeedEntry>();
  for (const e of allEntries) entryCache.set(e.id, e);
  console.log(`  kairos entries: ${allEntries.length}`);

  // Build the FSM-phase observation timeline from synthetic phase
  // entries. For each narration's compose time, the active phase is
  // whichever transition was observed before that synthesizedAt.
  const phaseObservations: Array<{ ts: number; phase: BroadcastPhase }> = [];
  for (const e of allEntries) {
    const data = e.data as Record<string, unknown> | null;
    if (data?.synthetic !== true || typeof data.eventType !== "string") continue;
    const phase =
      PHASE_FOR_TRANSITION_EVENT[data.eventType as GameplayTransitionEventType];
    if (!phase) continue;
    const ts = parseEntryTimestampMs(e);
    if (Number.isFinite(ts)) phaseObservations.push({ ts, phase });
  }
  phaseObservations.sort((a, b) => a.ts - b.ts);

  // Map narrativeId → { imageKey, imageUrl }. imageKey is the
  // durable reference (persisted in revealedCanonical.illustration);
  // imageUrl is freshly resolved at request time, so the value
  // baked here is allowed to be stale and gets replaced by
  // buildBroadcastView at every read.
  const illustrationsByNarrative = new Map<
    string,
    { imageKey: string; imageUrl: string }
  >();
  const illustrationRows = await db
    .select()
    .from(broadcastIllustrations)
    .where(eq(broadcastIllustrations.broadcastId, broadcastId));
  for (const row of illustrationRows) {
    if (!row.imageKey || !row.narrativeId) continue;
    const imageUrl = await getStorage()
      .getPublicUrl(row.imageKey)
      .catch(() => null);
    if (imageUrl) {
      illustrationsByNarrative.set(row.narrativeId, {
        imageKey: row.imageKey,
        imageUrl,
      });
    }
  }
  console.log(`  illustrations: ${illustrationsByNarrative.size}`);

  let runningCanonical: CanonicalState = emptyCanonicalState("warming");
  let updated = 0;
  let skipped = 0;

  for (const row of narrationRows) {
    if (row.revealedCanonical && row.revealingCanonical && !force) {
      skipped++;
      // Still need to advance running state from the persisted
      // bundle so subsequent narrations compose correctly.
      runningCanonical = applyRevealingCanonical(
        runningCanonical,
        row.revealingCanonical,
      );
      if (row.revealedCanonical.illustration) {
        runningCanonical = {
          ...runningCanonical,
          illustration: row.revealedCanonical.illustration,
        };
      }
      continue;
    }

    // Update running.illustration with this narrative's image (if
    // generated). Mirrors the live runtime: image arrival updates
    // running, next compose carries it.
    const illustration = illustrationsByNarrative.get(row.narrativeId);
    if (illustration) {
      runningCanonical = {
        ...runningCanonical,
        illustration,
      };
    }

    // Active FSM phase as of this narration's compose time.
    const synthTs = row.synthesizedAt.getTime();
    let fsmPhase: BroadcastPhase = "warming";
    for (const obs of phaseObservations) {
      if (obs.ts <= synthTs) fsmPhase = obs.phase;
      else break;
    }

    const { revealedCanonical, revealingCanonical } = composePassageBundle({
      runningCanonical,
      phase: fsmPhase,
      covers: row.covers ?? [],
      batchEntryIds: row.batchEntryIds ?? [],
      entryCache,
    });

    await db
      .update(broadcastNarrations)
      .set({ revealedCanonical, revealingCanonical })
      .where(eq(broadcastNarrations.id, row.id));

    runningCanonical = applyRevealingCanonical(
      runningCanonical,
      revealingCanonical,
    );
    updated++;

    if (updated % 5 === 0 || updated === 1) {
      console.log(
        `  passage ${updated}  narrativeId=${row.narrativeId}  phase=${revealedCanonical.phase}  events=${revealedCanonical.events.length}  contentMinute=${revealedCanonical.contentMinute ?? "—"}`,
      );
    }
  }

  console.log(
    `\nDone. Updated: ${updated}, Skipped (already had bundle): ${skipped}.`,
  );
  console.log(
    `Final running canonical state: phase=${runningCanonical.phase}, score=${runningCanonical.score.home}-${runningCanonical.score.away}, events=${runningCanonical.events.length}`,
  );
  process.exit(0);
}

function parseEntryTimestampMs(entry: KairosFeedEntry): number {
  // KairosFeedEntry.timestamp is a string per the type. Defensive
  // against numeric forms too — older payloads varied.
  const ts = entry.timestamp as unknown;
  if (typeof ts === "number") return ts;
  if (typeof ts === "string") {
    const asInt = parseInt(ts, 10);
    if (Number.isFinite(asInt)) return asInt;
    const asDate = Date.parse(ts);
    if (Number.isFinite(asDate)) return asDate;
  }
  return Date.parse((entry as unknown as { created_at?: string }).created_at ?? "") || 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
