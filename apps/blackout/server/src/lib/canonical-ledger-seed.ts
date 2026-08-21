import {
  isEventClass,
  surnameKey,
  teamKey,
  type CanonicalEventEntry,
  type EventClass,
} from "./event-correlation.js";

/**
 * Pure transform: turn an array of Kairos `match_events` entries into
 * the canonical-event ledger entries the broadcast runner's
 * correlation pipeline expects.
 *
 * Lives separately from the runner so the seed contract is testable
 * without dragging the full BroadcastRunner constructor + its 9
 * collaborators into a test. The runner consumes the result via
 * `seedCanonicalLedgerFromExistingEntries` on startup.
 *
 * Each entry's `realWallClockMs` is reconstructed from the entry's
 * stored `timestamp` (when Kairos persisted it) rather than the
 * Sportmonks adapter's wall-clock-for-minute helper, because the
 * adapter's anchor (`_kickoffTime`) hasn't been re-established yet
 * when this runs. The persisted timestamp is good enough — what
 * matters for correlation is the relative gap between commentary
 * claim and canonical event, not the absolute wall-clock value.
 *
 * Entries without an `eventType` mapping to an EventClass are
 * skipped silently (timeline rows, pressure updates, atmosphere
 * texts — none of these are correlatable canonical events).
 */
export function buildCanonicalLedgerSeed(
  entries: Array<Record<string, unknown>>,
  broadcastId: string,
): CanonicalEventEntry[] {
  const seeded: CanonicalEventEntry[] = [];
  for (const entry of entries) {
    const data = (entry?.data ?? null) as Record<string, unknown> | null;
    if (!data) continue;

    const rawType = typeof data.eventType === "string" ? data.eventType : null;
    if (!rawType || !isEventClass(rawType)) continue;
    const eventClass: EventClass = rawType;

    const timestamp = typeof entry.timestamp === "number" ? entry.timestamp : null;
    const realWallClockMs = timestamp ?? Date.now();

    const player = typeof data.player === "string" ? data.player : null;
    const team = typeof data.teamName === "string" ? data.teamName : null;
    const subjectTime =
      typeof data.subjectTime === "string"
        ? data.subjectTime
        : typeof data.minute === "number"
          ? String(data.minute)
          : "";
    const eventId =
      typeof data.sourceId === "number"
        ? String(data.sourceId)
        : typeof data.sourceId === "string"
          ? data.sourceId
          : data.synthetic === true
            ? `phase:${eventClass.toLowerCase()}:${broadcastId}`
            : `evt:${eventClass}:${subjectTime}`;

    seeded.push({
      eventId,
      eventClass,
      playerLastName: surnameKey(player),
      teamKey: teamKey(team),
      subjectTime,
      realWallClockMs,
      addedAt: realWallClockMs,
    });
  }
  return seeded;
}
