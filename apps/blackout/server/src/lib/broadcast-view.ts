import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { broadcastNarrations } from "../db/schema.js";
import { SOURCE } from "@blackout/shared";
import { listBroadcastEntries, type KairosFeedEntry } from "./kairos.js";
import { getRoomConductor } from "../conductor/index.js";
import { getStorage } from "./storage/index.js";
import { toViewerEntry } from "../ws/matchroom.js";
import {
  computeGuardedEntryIds,
  inferPhaseFromStatus,
  parseMatchTime,
} from "./broadcast-view-logic.js";
import type {
  ArchiveNarration,
  Broadcast,
  BroadcastView,
  BroadcastViewArchive,
  BroadcastViewEvent,
  BroadcastViewNarrative,
  BroadcastPhase,
  Passage,
} from "@blackout/shared";

/**
 * Build the matchroom-shaped view of a broadcast. Single source of
 * truth for `GET /broadcasts/:id` — same response for every caller,
 * regardless of when they arrive at the broadcast.
 *
 * The reveal contract is honoured in the initial state: a
 * match_events entry is in `revealedEvents` only when it was
 * included in the batch of a narration that has finished playing.
 * Events staged by narrations still in progress stay hidden — the
 * late joiner sees exactly what long-connected listeners see.
 */
export async function buildBroadcastView(broadcast: Broadcast): Promise<BroadcastView> {
  const empty: BroadcastView = {
    ...broadcast,
    phase: inferPhaseFromStatus(broadcast),
    revealedEvents: [],
    score: { home: 0, away: 0 },
    currentContentMinute: null,
    currentNarrative: null,
    archive: null,
    revealedPassages: [],
  };

  // Scheduled / draft broadcasts have no runtime state to surface.
  if (
    broadcast.status === "draft" ||
    broadcast.status === "scheduled" ||
    !broadcast.kairosBroadcastId
  ) {
    return empty;
  }

  const kairosId = broadcast.kairosBroadcastId;

  // Phase — conductor knows for live broadcasts; complete takes the
  // terminal phase; everything else falls back to the status-inferred
  // default.
  const conductor = getRoomConductor(broadcast.id);
  const phase: BroadcastPhase =
    conductor?.getSubjectPhase() ??
    (broadcast.status === "complete" ? "complete" : inferPhaseFromStatus(broadcast));

  // All narrations persisted so far — ordered chronologically so the
  // last played one is easy to pick up.
  const narrationRows = await db
    .select()
    .from(broadcastNarrations)
    .where(eq(broadcastNarrations.broadcastId, broadcast.id))
    .orderBy(broadcastNarrations.synthesizedAt);

  const played = narrationRows.filter((n) => n.playbackStartedAt != null);
  const now = Date.now();

  // Current narrative: the most recently played one, regardless of
  // whether its audio is still playing. Stays current until the next
  // one arrives. The client derives play-state from
  // (playbackStartedAt + durationMs) vs its wall-clock now.
  const latest = played[played.length - 1];
  let currentNarrative: BroadcastViewNarrative | null = null;
  if (latest && latest.playbackStartedAt) {
    currentNarrative = {
      id: latest.id,
      narrativeId: latest.narrativeId,
      text: latest.text,
      wordCount: latest.wordCount,
      audioUrl: await getStorage()
        .getPublicUrl(latest.audioKey)
        .catch(() => null),
      durationMs: latest.durationMs,
      playbackStartedAt: latest.playbackStartedAt.toISOString(),
    };
  }

  // Guard set: entry ids the matchroom should HIDE right now —
  // those listed in `covers` of any narration currently mid-flight.
  // Everything else is visible. This is the inverse of the older
  // opt-in approach; see broadcast-view-logic.ts for the reasoning.
  const guardedEntryIds = computeGuardedEntryIds(played, now);

  // Fetch all match_events for live broadcasts — we need them
  // unfiltered so the matchroom can display canonical state on
  // load. Replay (status: complete) also needs the full list for
  // archive.events.
  const allMatchEvents = (await listBroadcastEntries(kairosId, {
    source: SOURCE.matchEvents,
  })) as unknown as KairosFeedEntry[];

  // Domain-aware dedup: collapse Kairos entries that share the same
  // Sportmonks raw id (`data.sourceId`). Kairos itself doesn't dedup
  // — and the runner's seenEventIds reseed (broadcast-runner.ts)
  // prevents future re-pushes — but pre-fix data already in Kairos
  // can have many duplicates (38 GOAL entries for a 2-goal match in
  // the 2026-05-02 Ipswich-QPR test). Keeping the FIRST occurrence
  // (chronological insertion order from Kairos) preserves the
  // original timestamp.
  const seenSourceIds = new Set<number | string>();
  const seenSyntheticTypes = new Set<string>();
  const dedupedEntries: KairosFeedEntry[] = [];
  for (const entry of allMatchEvents) {
    const data = (entry.data ?? {}) as Record<string, unknown>;
    const sourceId = data.sourceId;
    if (typeof sourceId === "number" || typeof sourceId === "string") {
      if (seenSourceIds.has(sourceId)) continue;
      seenSourceIds.add(sourceId);
      dedupedEntries.push(entry);
      continue;
    }
    // Synthetic entries (KICKOFF / HALFTIME / SECOND_HALF_KICKOFF /
    // FULL_TIME) have no sourceId. Each runner restart re-fires
    // onKickoff (and friends) because the Sportmonks adapter's
    // `_kickoffTime` is in-memory and resets, so the conductor pushes
    // duplicate synthetics. There's only ever one of each phase
    // transition per broadcast — dedup by eventType, keeping the
    // first occurrence (the original push).
    if (data.synthetic === true && typeof data.eventType === "string") {
      if (seenSyntheticTypes.has(data.eventType)) continue;
      seenSyntheticTypes.add(data.eventType);
      dedupedEntries.push(entry);
      continue;
    }
    // Anything else (no sourceId, not synthetic) — keep, can't dedup.
    dedupedEntries.push(entry);
  }

  const allViewerEvents: BroadcastViewEvent[] = [];
  for (const entry of dedupedEntries) {
    const event = toViewerEntry(entry);
    if (event) allViewerEvents.push(event);
  }
  // Sort by match-minute (parsed contentTime) ascending, with push
  // timestamp as the tiebreaker.
  allViewerEvents.sort((a, b) => {
    const am = parseMatchTime(a.contentTime);
    const bm = parseMatchTime(b.contentTime);
    if (am !== bm) return am - bm;
    return a.timestamp - b.timestamp;
  });

  // Visible-by-default: every event except those mid-narration.
  const revealedEvents = allViewerEvents.filter((e) => !guardedEntryIds.has(e.id));

  // Server-derived canonical state from revealed events. Matchroom
  // renders these directly — no client-side counting or sorting.
  // (See packages/blackout/shared/types/broadcast.ts for the contract.)
  const score = { home: 0, away: 0 };
  for (const e of revealedEvents) {
    if (!e.isGoal) continue;
    if (e.team === "home") score.home++;
    else if (e.team === "away") score.away++;
  }
  // Latest match minute label. Phase-transition synthetic entries
  // override the numeric label with the convention ("HT", "FT") when
  // the broadcast is in that phase — once FULL_TIME is revealed, the
  // matchroom shows "FT" regardless of any stoppage-time events that
  // outrank it on parsed contentTime ("90+3" parses higher than
  // "90"). HALFTIME only shows "HT" while we're still in the break
  // (no SECOND_HALF_KICKOFF revealed yet).
  let currentContentMinute: string | null = null;
  const hasFullTime = revealedEvents.some((e) => e.eventType === "FULL_TIME");
  const hasHalftime = revealedEvents.some((e) => e.eventType === "HALFTIME");
  const hasSecondHalfKickoff = revealedEvents.some((e) => e.eventType === "SECOND_HALF_KICKOFF");
  if (hasFullTime) {
    currentContentMinute = "FT";
  } else if (hasHalftime && !hasSecondHalfKickoff) {
    currentContentMinute = "HT";
  } else if (revealedEvents.length > 0) {
    const latestEvent = revealedEvents[revealedEvents.length - 1];
    currentContentMinute = formatMatchTimeLabel(latestEvent.contentTime, latestEvent.minute, latestEvent.extraMinute);
  }

  // Archive payload — populated only on complete broadcasts. Carries
  // the full narration sequence (in synthesis order, which is also
  // play order) with signed audio URLs, plus every event so the
  // replay client can reveal them in step with the chained playback.
  let archive: BroadcastViewArchive | null = null;
  let revealedPassages: Passage[] = [];
  if (broadcast.status === "complete") {
    const narrations: ArchiveNarration[] = await Promise.all(
      narrationRows.map(async (n) => ({
        id: n.id,
        narrativeId: n.narrativeId,
        text: n.text,
        wordCount: n.wordCount,
        audioUrl: await getStorage()
          .getPublicUrl(n.audioKey)
          .catch(() => null),
        durationMs: n.durationMs,
        batchEntryIds: n.batchEntryIds ?? [],
        covers: n.covers ?? [],
      })),
    );
    archive = { narrations, events: allViewerEvents };

    // Bundle-driven replay payload (Sub-piece 5a). Each row that
    // carries the canonical bundle becomes a Passage; rows
    // pre-dating the bundle contract (NULL columns) are skipped —
    // they replay via the legacy archive path until the Liverpool W
    // backfill populates them. New broadcasts always have bundles.
    //
    // illustration.imageUrl is re-resolved from imageKey at request
    // time — same pattern audio uses. The imageUrl persisted in the
    // bundle JSON is allowed to be stale (presigned URLs have TTLs);
    // imageKey is the durable reference. Without this refresh, every
    // replay's illustrations break after the URL TTL elapses.
    revealedPassages = (
      await Promise.all(
        narrationRows.map(async (n): Promise<Passage | null> => {
          if (!n.revealedCanonical || !n.revealingCanonical) return null;
          const audioUrl = await getStorage()
            .getPublicUrl(n.audioKey)
            .catch(() => null);
          let revealedCanonical = n.revealedCanonical;
          if (revealedCanonical.illustration?.imageKey) {
            const imageUrl = await getStorage()
              .getPublicUrl(revealedCanonical.illustration.imageKey)
              .catch(() => null);
            if (imageUrl) {
              revealedCanonical = {
                ...revealedCanonical,
                illustration: {
                  imageKey: revealedCanonical.illustration.imageKey,
                  imageUrl,
                },
              };
            }
          }
          return {
            narrativeId: n.narrativeId,
            narrationId: n.id,
            text: n.text,
            wordCount: n.wordCount,
            generatedAt: n.synthesizedAt.toISOString(),
            audio: audioUrl ? { url: audioUrl, durationMs: n.durationMs } : null,
            playback: null,
            revealedCanonical,
            revealingCanonical: n.revealingCanonical,
          };
        }),
      )
    ).filter((p): p is Passage => p !== null);
  }

  return {
    ...broadcast,
    phase,
    revealedEvents,
    score,
    currentContentMinute,
    currentNarrative,
    archive,
    revealedPassages,
  };
}

/**
 * Format a match-time string + minute/extraMinute into the
 * conventional match-minute display ("47'", "45+2'") with phase
 * labels left as raw text ("HT", "FT", "pre_match"). Mirrors the
 * matchroom's local `formatMinute` so server and client agree on the
 * displayed string. Direction-agnostic (the input is the match minute
 * either way) — see `docs/vocabulary.md` § Time.
 */
function formatMatchTimeLabel(
  matchTime: string | undefined,
  minute: number | null,
  extraMinute: number | null,
): string | null {
  if (matchTime && matchTime.length > 0) {
    // Phase labels pass through; numeric forms get a trailing apostrophe.
    if (/^\d/.test(matchTime)) return `${matchTime}'`;
    return matchTime;
  }
  if (minute == null) return null;
  return extraMinute ? `${minute}+${extraMinute}'` : `${minute}'`;
}

