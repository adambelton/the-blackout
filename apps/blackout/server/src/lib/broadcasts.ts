import type { Broadcast, CreateBroadcastInput } from "@blackout/shared";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { broadcasts } from "../db/schema.js";
import { getDefaultTtsVoice } from "./tts-voices.js";

type BroadcastRow = typeof broadcasts.$inferSelect;

function fromRow(row: BroadcastRow): Broadcast {
  return {
    id: row.id,
    homeTeam: row.homeTeam,
    awayTeam: row.awayTeam,
    competition: row.competition,
    matchDate: row.matchDate.toISOString(),
    status: row.status,
    fixtureId: row.fixtureId ?? undefined,
    radioSourceId: row.radioSourceId ?? undefined,
    ttsVoiceId: row.ttsVoiceId ?? undefined,
    ttsEnabled: row.ttsEnabled ?? undefined,
    moderatorId: row.moderatorId ?? undefined,
    kairosBroadcastId: row.kairosBroadcastId ?? undefined,
    matchBrief: row.matchBrief ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toUpdateRow(
  updates: Partial<Omit<Broadcast, "id" | "createdAt" | "updatedAt">>,
): Partial<typeof broadcasts.$inferInsert> {
  const row: Partial<typeof broadcasts.$inferInsert> = {};
  if (updates.homeTeam !== undefined) row.homeTeam = updates.homeTeam;
  if (updates.awayTeam !== undefined) row.awayTeam = updates.awayTeam;
  if (updates.competition !== undefined) row.competition = updates.competition;
  if (updates.matchDate !== undefined) row.matchDate = new Date(updates.matchDate);
  if (updates.status !== undefined) row.status = updates.status;
  if (updates.fixtureId !== undefined) row.fixtureId = updates.fixtureId;
  if (updates.radioSourceId !== undefined) row.radioSourceId = updates.radioSourceId;
  if (updates.ttsVoiceId !== undefined) row.ttsVoiceId = updates.ttsVoiceId;
  if (updates.ttsEnabled !== undefined) row.ttsEnabled = updates.ttsEnabled;
  if (updates.moderatorId !== undefined) row.moderatorId = updates.moderatorId;
  if (updates.kairosBroadcastId !== undefined) row.kairosBroadcastId = updates.kairosBroadcastId;
  if (updates.matchBrief !== undefined) row.matchBrief = updates.matchBrief;
  return row;
}

export async function listBroadcasts(): Promise<Broadcast[]> {
  const rows = await db
    .select()
    .from(broadcasts)
    .orderBy(desc(broadcasts.matchDate));
  return rows.map(fromRow);
}

export async function getBroadcast(id: string): Promise<Broadcast | null> {
  const [row] = await db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.id, id))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function createBroadcast(input: CreateBroadcastInput): Promise<Broadcast> {
  const [row] = await db
    .insert(broadcasts)
    .values({
      homeTeam: input.homeTeam,
      awayTeam: input.awayTeam,
      competition: input.competition,
      matchDate: new Date(input.matchDate),
      status: "draft",
      fixtureId: input.fixtureId ?? null,
      radioSourceId: input.radioSourceId ?? null,
      matchBrief: input.matchBrief ?? null,
      ttsVoiceId: (await getDefaultTtsVoice())?.id ?? null,
    })
    .returning();
  return fromRow(row);
}

export async function updateBroadcast(
  id: string,
  updates: Partial<Omit<Broadcast, "id" | "createdAt" | "updatedAt">>,
): Promise<Broadcast | null> {
  const row = toUpdateRow(updates);
  if (Object.keys(row).length === 0) return getBroadcast(id);

  // No DB trigger updates `updated_at` — we set it explicitly on every
  // write so the row reflects the last application-level mutation.
  row.updatedAt = new Date();

  const [updated] = await db
    .update(broadcasts)
    .set(row)
    .where(eq(broadcasts.id, id))
    .returning();

  return updated ? fromRow(updated) : null;
}

/** Delete a broadcast row. FKs in the schema cascade — illustrations,
 * narrations, and any other dependent rows go with it. Used by the
 * create endpoint to roll back a Blackout row when Kairos linking
 * fails, so we never leave a broadcast that has no Kairos counterpart. */
export async function deleteBroadcast(id: string): Promise<boolean> {
  const deleted = await db
    .delete(broadcasts)
    .where(eq(broadcasts.id, id))
    .returning({ id: broadcasts.id });
  return deleted.length > 0;
}
