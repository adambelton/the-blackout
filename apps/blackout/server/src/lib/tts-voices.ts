import { and, eq, ne } from "drizzle-orm";
import { db } from "../db/client.js";
import { ttsVoices } from "../db/schema.js";
import type { TtsVoiceRecord, BroadcastTtsProvider } from "@blackout/shared";

type VoiceRow = typeof ttsVoices.$inferSelect;

function fromRow(row: VoiceRow): TtsVoiceRecord {
  return {
    id: row.id,
    provider: row.provider as BroadcastTtsProvider,
    providerVoiceId: row.providerVoiceId,
    name: row.name,
    description: row.description ?? undefined,
    speed: row.speed ?? undefined,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listTtsVoices(): Promise<TtsVoiceRecord[]> {
  const rows = await db.select().from(ttsVoices).orderBy(ttsVoices.name);
  return rows.map(fromRow);
}

export async function getTtsVoice(id: string): Promise<TtsVoiceRecord | null> {
  const [row] = await db.select().from(ttsVoices).where(eq(ttsVoices.id, id)).limit(1);
  return row ? fromRow(row) : null;
}

export async function getTtsVoiceByProvider(
  provider: string,
  providerVoiceId: string,
): Promise<TtsVoiceRecord | null> {
  const [row] = await db
    .select()
    .from(ttsVoices)
    .where(and(eq(ttsVoices.provider, provider), eq(ttsVoices.providerVoiceId, providerVoiceId)))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function getDefaultTtsVoice(): Promise<TtsVoiceRecord | null> {
  const [row] = await db
    .select()
    .from(ttsVoices)
    .where(eq(ttsVoices.isDefault, true))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function createTtsVoice(input: {
  provider: string;
  providerVoiceId: string;
  name: string;
  description?: string;
  speed?: number;
  isDefault: boolean;
}): Promise<TtsVoiceRecord> {
  if (input.isDefault) {
    await db.update(ttsVoices).set({ isDefault: false, updatedAt: new Date() });
  }
  const [row] = await db
    .insert(ttsVoices)
    .values({
      provider: input.provider,
      providerVoiceId: input.providerVoiceId,
      name: input.name,
      description: input.description ?? null,
      speed: input.speed ?? null,
      isDefault: input.isDefault,
    })
    .returning();
  return fromRow(row);
}

export async function updateTtsVoice(
  id: string,
  updates: Partial<{
    name: string;
    description: string | null;
    speed: number | null;
    isDefault: boolean;
  }>,
): Promise<TtsVoiceRecord | null> {
  if (updates.isDefault) {
    await db
      .update(ttsVoices)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(ne(ttsVoices.id, id));
  }
  const [row] = await db
    .update(ttsVoices)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(ttsVoices.id, id))
    .returning();
  return row ? fromRow(row) : null;
}

export async function deleteTtsVoice(id: string): Promise<boolean> {
  const deleted = await db
    .delete(ttsVoices)
    .where(eq(ttsVoices.id, id))
    .returning({ id: ttsVoices.id });
  return deleted.length > 0;
}
