import * as kairos from "./kairos.js";
import type { PacingSignal } from "./kairos.js";
import { getBroadcast, updateBroadcast } from "./broadcasts.js";
import { fetchLineupsBlock } from "./lineups.js";
import { ensureRoomConductor, stopRoomConductor } from "../conductor/index.js";
import { setRoster, clearRoster } from "./roster-registry.js";
import { captureEvent } from "./telemetry.js";
import { DEFAULT_NARRATIVE_VOICE } from "./defaults.js";
import {
  isBroadcastRunnerActive,
  startBroadcastRunner,
  stopBroadcastRunner,
} from "./broadcast-runner.js";
import { SOURCE, type Broadcast } from "@blackout/shared";

// Re-export so existing consumers can keep their `import { SOURCE }
// from "./kairos-bridge.js"` paths. Hoisted to @blackout/shared per
// the codebase audit (2026-05-10): magic-string source names are an
// audit failure, and the typed accessor needs to be reachable from
// any app, not buried in apps/blackout/server.
export { SOURCE };

/**
 * Create the Kairos-side broadcast for a Blackout broadcast, seed the
 * narrative_context and narrative_voice entries, and persist the Kairos
 * broadcast id onto our broadcasts row.
 *
 * Safe to call multiple times — if the Blackout broadcast already has a
 * kairosBroadcastId, the existing one is returned.
 */
export async function linkBroadcastToKairos(blackoutId: string): Promise<Broadcast> {
  const existing = await getBroadcast(blackoutId);
  if (!existing) throw new Error(`Broadcast ${blackoutId} not found`);
  if (existing.kairosBroadcastId) return existing;

  const kb = await kairos.createBroadcast({
    eventProfile: "sporting_event",
    sources: [
      { name: SOURCE.matchEvents, type: "event", canonical: true },
      { name: SOURCE.matchPressure, type: "event", canonical: false },
      { name: SOURCE.matchStats, type: "event", canonical: false },
      { name: SOURCE.matchAction, type: "event", canonical: false },
      { name: SOURCE.moderator, type: "moderator", canonical: false },
      { name: SOURCE.narrativeContext, type: "narrative_context" },
      { name: SOURCE.narrativeVoice, type: "narrative_voice" },
    ],
  });

  const updated = await updateBroadcast(blackoutId, { kairosBroadcastId: kb.id });
  if (!updated) throw new Error(`Failed to persist kairosBroadcastId on ${blackoutId}`);
  return updated;
}

/**
 * Activate both sides of the broadcast. Seeds narrative_context and
 * narrative_voice entries into the pending Kairos broadcast first — Kairos
 * rejects activation if either source has no entry with non-empty content,
 * because its runtime hydrates voice + world from them on startup. Then
 * flips Kairos to `active` and the Blackout to `live`.
 *
 * Voice is the product-wide default loaded from `content/voice.md`, not a
 * per-broadcast field. Writer-specific voices will land as a separate
 * override path once that interface exists; until then every broadcast
 * speaks in the same voice.
 */
export async function activateBroadcast(blackoutId: string): Promise<Broadcast> {
  const linked = await linkBroadcastToKairos(blackoutId);
  if (!linked.kairosBroadcastId) {
    throw new Error("linkBroadcastToKairos did not return a kairosBroadcastId");
  }

  const voice = DEFAULT_NARRATIVE_VOICE;

  // Fetch the canonical starting XIs if we have a Sportmonks fixture —
  // appending them to narrative_context gives the generator a name
  // registry to reconcile ASR garbles against. Failure is non-blocking
  // (lineups publish ~1hr before kickoff; pre-match activations may
  // predate that window).
  const baseBrief = buildMatchBrief(linked);
  let fullBrief = baseBrief;
  if (linked.fixtureId) {
    const lineups = await fetchLineupsBlock(linked.fixtureId);
    if (lineups) {
      fullBrief = `${baseBrief}\n\n${lineups.block}`;
      // Stash the roster for the transcript normaliser. Transcription
      // text goes through `normaliseTranscript(text, roster)` before
      // reaching Kairos so ASR garbles ("Fabon", "Aeling") get
      // rewritten to canonical spellings.
      setRoster(blackoutId, {
        roster: lineups.roster,
        homeRoster: lineups.homeRoster,
        awayRoster: lineups.awayRoster,
        homeTeamName: lineups.homeTeamName,
        awayTeamName: lineups.awayTeamName,
      });
      console.log(
        `[kairos-bridge] appended lineups to narrative_context for fixture ${linked.fixtureId} (${lineups.roster.length} names)`,
      );
    } else {
      console.log(`[kairos-bridge] no lineups available yet for fixture ${linked.fixtureId} — activating without roster`);
    }
  }

  // Both pushes are required for activation (Kairos rejects activation
  // when narrative_voice/narrative_context are empty). Log success
  // explicitly so we can confirm seeding actually happened during a
  // live test — silent absence in the moderator's combined feed has
  // historically pointed at activation paths that bypassed seeding.
  const ctxPushed = await kairos.pushEntry(linked.kairosBroadcastId, {
    source: SOURCE.narrativeContext,
    data: { content: fullBrief },
  });
  console.log(
    `[kairos-bridge:${blackoutId}] seeded narrative_context (entry ${ctxPushed.id}, ${fullBrief.length} chars)`,
  );
  const voicePushed = await kairos.pushEntry(linked.kairosBroadcastId, {
    source: SOURCE.narrativeVoice,
    data: { content: voice },
  });
  console.log(
    `[kairos-bridge:${blackoutId}] seeded narrative_voice (entry ${voicePushed.id}, ${voice.length} chars)`,
  );

  await kairos.activateBroadcast(linked.kairosBroadcastId);

  const updated = await updateBroadcast(blackoutId, { status: "live" });
  if (!updated) throw new Error(`Failed to flip broadcast ${blackoutId} to live`);

  // Spin up the room conductor — owns the Kairos feed subscription,
  // synthesis pipeline, playback scheduler, and WS fan-out for this
  // broadcast. Starts running immediately; matchroom and moderator WS
  // handlers attach clients as they connect.
  await ensureRoomConductor(blackoutId);

  // Activation implies "start broadcasting" — there's no meaningful
  // state between "live" and "no sources running." Start the
  // broadcast runner that pulls TalkSPORT/BBC through Deepgram and
  // polls Sportmonks for events. Soft-fail for broadcasts that don't
  // have a fixture or radio source (smoke tests, manual-only
  // broadcasts) — activation still succeeds, the moderator can push
  // entries by hand if desired. Confirmed as missing UX step during
  // the 2026-04-22 Burnley-City live test: the broadcast activated
  // but sat silent because the runner was a separate manual step.
  if (!isBroadcastRunnerActive(blackoutId)) {
    try {
      await startBroadcastRunner(blackoutId);
      console.log(`[kairos-bridge] broadcast runner started for ${blackoutId}`);
    } catch (err) {
      const msg = (err as Error).message;
      // Missing fixture or radio is an expected soft-fail (smoke
      // broadcasts, manual-only runs). Any other error is unexpected
      // and warrants a louder log — but activation still proceeds
      // since the conductor is up and entries can arrive via moderator.
      const isBenign = msg.includes("fixtureId") || msg.includes("radioSourceId");
      const level = isBenign ? "log" : "warn";
      console[level](
        `[kairos-bridge] broadcast runner not started for ${blackoutId}: ${msg}`,
      );
    }
  }

  captureEvent({
    name: "broadcast_activated",
    broadcastId: blackoutId,
    properties: {
      "kairos.broadcastId": linked.kairosBroadcastId,
      "broadcast.homeTeam": updated.homeTeam,
      "broadcast.awayTeam": updated.awayTeam,
      "broadcast.competition": updated.competition,
      "broadcast.fixtureId": updated.fixtureId ?? null,
      "broadcast.ttsEnabled": updated.ttsEnabled === true,
    },
  });

  return updated;
}

/**
 * Complete the broadcast on both sides. Kairos goes first so that if it
 * fails, Blackout stays `live` and the moderator can retry — otherwise
 * Kairos's runtime will rehydrate on the next URL hit while Blackout
 * thinks the broadcast is done.
 */
export async function completeBroadcast(blackoutId: string): Promise<Broadcast> {
  const broadcast = await getBroadcast(blackoutId);
  if (!broadcast) throw new Error(`Broadcast ${blackoutId} not found`);

  // Stop the broadcast runner first so no new entries arrive during
  // teardown. Mirrors the activation flow: activation starts the
  // runner; completion stops it. `completeBroadcast: false` here —
  // we're already in the completion path, so the runner's own
  // post-stop completeBroadcast call would recurse back into this
  // function.
  if (isBroadcastRunnerActive(blackoutId)) {
    await stopBroadcastRunner(blackoutId, { completeBroadcast: false }).catch((err) =>
      console.warn(`[kairos-bridge] broadcast runner stop failed for ${blackoutId}: ${(err as Error).message}`),
    );
  }

  if (broadcast.kairosBroadcastId) {
    await kairos.completeBroadcast(broadcast.kairosBroadcastId);
  }

  // Tear down the room conductor — stops synthesis, cancels any pending
  // playback timer, and closes all connected client WS. Conductors
  // intentionally outlive a `paused` broadcast so mid-match pauses
  // don't require re-linking; only `complete` retires them.
  stopRoomConductor(blackoutId);
  clearRoster(blackoutId);

  const updated = await updateBroadcast(blackoutId, { status: "complete" });
  if (!updated) throw new Error(`Failed to flip broadcast ${blackoutId} to complete`);

  captureEvent({
    name: "broadcast_completed",
    broadcastId: blackoutId,
    properties: {
      "kairos.broadcastId": broadcast.kairosBroadcastId ?? null,
      "broadcast.homeTeam": updated.homeTeam,
      "broadcast.awayTeam": updated.awayTeam,
    },
  });

  return updated;
}

function buildMatchBrief(b: Broadcast): string {
  if (b.matchBrief?.trim()) return b.matchBrief.trim();
  const date = new Date(b.matchDate).toISOString().split("T")[0];
  return `${b.homeTeam} vs ${b.awayTeam}. ${b.competition}. ${date}.`;
}

// Tuneable pacing thresholds for the consumer's TTS cadence. Hemingway-voiced
// narration at a natural narrator pace sits around 160-180 wpm.
const PACING_TARGET = { min: 140, max: 200 };

export function signalFor(wordsPerMinute: number): PacingSignal {
  if (wordsPerMinute > PACING_TARGET.max) return "slow_down";
  if (wordsPerMinute < PACING_TARGET.min) return "speed_up";
  return "on_track";
}

/**
 * Report TTS playback timing back to Kairos as a pacing signal.
 * Computes actual words-per-minute from the playback observation and maps
 * to slow_down | speed_up | on_track. No-ops if the broadcast has no
 * Kairos id yet (safe to call eagerly from the client).
 */
export async function reportPacing(
  blackoutId: string,
  wordCount: number,
  playbackSeconds: number,
): Promise<{ signal: PacingSignal; wordsPerMinute: number } | null> {
  if (wordCount <= 0 || playbackSeconds <= 0) return null;

  const broadcast = await getBroadcast(blackoutId);
  if (!broadcast?.kairosBroadcastId) return null;

  const wpm = (wordCount / playbackSeconds) * 60;
  const signal = signalFor(wpm);
  await kairos.sendFeedback(broadcast.kairosBroadcastId, signal, wpm);
  return { signal, wordsPerMinute: wpm };
}
