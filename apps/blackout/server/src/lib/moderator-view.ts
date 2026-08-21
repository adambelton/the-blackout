import {
  listBroadcastEntries,
  listGenerations,
  type KairosFeedEntry,
} from "./kairos.js";
import { buildBroadcastView } from "./broadcast-view.js";
import { toFeedEntry } from "../ws/moderator-feed-shape.js";
import type {
  Broadcast,
  ModeratorFeedEntry,
  ModeratorNarrative,
  ModeratorView,
} from "@blackout/shared";

/**
 * Build the moderator-shaped view of a broadcast. Single source of
 * truth for `GET /broadcasts/:id/moderator-view` — restores the
 * console's working state on refresh / late join.
 *
 * Superset of `buildBroadcastView`. Adds:
 *  - `allFeedEntries` — every entry from every source the moderator's
 *    UI renders (transcription, moderator notes, system, events,
 *    pressure), reshaped via the same `toFeedEntry` mapper the live
 *    WS path uses so bootstrap and live entries are interchangeable.
 *  - `allNarratives` — every narrative generated for this broadcast,
 *    with covers — drives the ✓ indicator on covered feed entries.
 *
 * For draft / scheduled / unlinked broadcasts both extras come back
 * empty — there's no Kairos state to surface.
 */
export async function buildModeratorView(
  broadcast: Broadcast,
): Promise<ModeratorView> {
  const baseView = await buildBroadcastView(broadcast);

  if (
    broadcast.status === "draft" ||
    broadcast.status === "scheduled" ||
    !broadcast.kairosBroadcastId
  ) {
    return { ...baseView, allFeedEntries: [], allNarratives: [] };
  }

  const kairosId = broadcast.kairosBroadcastId;

  // Fetch in parallel — both round-trips hit Kairos and have no
  // ordering dependency.
  const [rawEntries, generations] = await Promise.all([
    listBroadcastEntries(kairosId).catch(() => [] as Array<Record<string, unknown>>),
    listGenerations(kairosId).catch(() => []),
  ]);

  const allFeedEntries: ModeratorFeedEntry[] = [];
  for (const raw of rawEntries) {
    const shaped = toFeedEntry(raw as unknown as KairosFeedEntry);
    if (shaped) allFeedEntries.push(shaped);
  }
  allFeedEntries.sort((a, b) => a.timestamp - b.timestamp);

  // Kairos returns generations newest-first; the moderator UI displays
  // them oldest-first (chronological narration order), so resort here
  // rather than asking every consumer to know.
  const allNarratives: ModeratorNarrative[] = generations
    .map((g) => ({
      id: g.id,
      text: g.output,
      wordCount: g.wordCount,
      generatedAt: g.triggeredAt,
      covers: g.covers,
    }))
    .sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt));

  return { ...baseView, allFeedEntries, allNarratives };
}
