/**
 * Content pool repository. Consumer-prepared items the imagery
 * selector can pick from at runtime instead of emitting a
 * fresh-generate decision.
 *
 * Domain-agnostic — Kairos stores a prompt, a tag set, and an opaque
 * consumer_metadata blob. No knowledge of what the pool "contains."
 */
import { desc, eq } from "drizzle-orm";
import { db } from "./client.js";
import { contentPoolItems } from "./schema.js";

export interface ContentPoolItem {
  id: string;
  broadcastId: string;
  prompt: string;
  tags: string[];
  consumerMetadata: Record<string, unknown> | null;
  createdAt: number;
}

type Row = typeof contentPoolItems.$inferSelect;

function fromRow(row: Row): ContentPoolItem {
  return {
    id: row.id,
    broadcastId: row.broadcastId,
    prompt: row.prompt,
    tags: row.tags ?? [],
    consumerMetadata: row.consumerMetadata ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

export async function insertPoolItem(input: {
  broadcastId: string;
  prompt: string;
  tags?: string[];
  consumerMetadata?: Record<string, unknown> | null;
}): Promise<ContentPoolItem> {
  const [row] = await db
    .insert(contentPoolItems)
    .values({
      broadcastId: input.broadcastId,
      prompt: input.prompt,
      tags: input.tags ?? [],
      consumerMetadata: input.consumerMetadata ?? null,
    })
    .returning();
  return fromRow(row);
}

export async function listPoolItems(
  broadcastId: string,
): Promise<ContentPoolItem[]> {
  const rows = await db
    .select()
    .from(contentPoolItems)
    .where(eq(contentPoolItems.broadcastId, broadcastId))
    .orderBy(desc(contentPoolItems.createdAt));
  return rows.map(fromRow);
}

export async function getPoolItem(
  id: string,
): Promise<ContentPoolItem | null> {
  const [row] = await db
    .select()
    .from(contentPoolItems)
    .where(eq(contentPoolItems.id, id))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function deletePoolItem(
  id: string,
): Promise<ContentPoolItem | null> {
  const [row] = await db
    .delete(contentPoolItems)
    .where(eq(contentPoolItems.id, id))
    .returning();
  return row ? fromRow(row) : null;
}

export async function updatePoolItem(
  id: string,
  updates: { tags?: string[]; consumerMetadata?: Record<string, unknown> | null },
): Promise<ContentPoolItem | null> {
  const row: Partial<typeof contentPoolItems.$inferInsert> = {};
  if (updates.tags !== undefined) row.tags = updates.tags;
  if (updates.consumerMetadata !== undefined)
    row.consumerMetadata = updates.consumerMetadata;
  if (Object.keys(row).length === 0) return getPoolItem(id);
  const [updated] = await db
    .update(contentPoolItems)
    .set(row)
    .where(eq(contentPoolItems.id, id))
    .returning();
  return updated ? fromRow(updated) : null;
}
