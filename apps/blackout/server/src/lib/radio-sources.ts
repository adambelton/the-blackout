import { eq, sql as dsql } from "drizzle-orm";
import type { RadioSource } from "@blackout/shared";
import { db } from "../db/client.js";
import { radioSources } from "../db/schema.js";

export type { RadioSource };

export interface CreateRadioSourceInput {
  name: string;
  streamUrl: string;
  urlPattern: string;
  defaultOffsetSeconds: number;
  transcode?: boolean;
}

export type UpdateRadioSourceInput = Partial<CreateRadioSourceInput>;

type RadioSourceRow = typeof radioSources.$inferSelect;

function fromRow(row: RadioSourceRow): RadioSource {
  return {
    id: row.id,
    name: row.name,
    streamUrl: row.streamUrl,
    urlPattern: row.urlPattern,
    defaultOffsetSeconds: row.defaultOffsetSeconds,
    transcode: row.transcode,
    lastObservedOffsetSeconds: row.lastObservedOffsetSeconds,
    lastObservedAt: row.lastObservedAt ? row.lastObservedAt.toISOString() : null,
    observationCount: row.observationCount,
  };
}

function toUpdateRow(
  updates: UpdateRadioSourceInput,
): Partial<typeof radioSources.$inferInsert> {
  const row: Partial<typeof radioSources.$inferInsert> = {};
  if (updates.name !== undefined) row.name = updates.name;
  if (updates.streamUrl !== undefined) row.streamUrl = updates.streamUrl;
  if (updates.urlPattern !== undefined) row.urlPattern = updates.urlPattern;
  if (updates.defaultOffsetSeconds !== undefined) {
    row.defaultOffsetSeconds = updates.defaultOffsetSeconds;
  }
  if (updates.transcode !== undefined) row.transcode = updates.transcode;
  return row;
}

export async function listSources(): Promise<RadioSource[]> {
  const rows = await db.select().from(radioSources).orderBy(radioSources.name);
  return rows.map(fromRow);
}

export async function getSourceById(id: string): Promise<RadioSource | null> {
  const [row] = await db
    .select()
    .from(radioSources)
    .where(eq(radioSources.id, id))
    .limit(1);
  return row ? fromRow(row) : null;
}

export async function createSource(input: CreateRadioSourceInput): Promise<RadioSource> {
  const [row] = await db.insert(radioSources).values(input).returning();
  return fromRow(row);
}

export async function updateSource(
  id: string,
  updates: UpdateRadioSourceInput,
): Promise<RadioSource | null> {
  const row = toUpdateRow(updates);
  if (Object.keys(row).length === 0) {
    const [existing] = await db
      .select()
      .from(radioSources)
      .where(eq(radioSources.id, id))
      .limit(1);
    return existing ? fromRow(existing) : null;
  }
  row.updatedAt = new Date();

  const [updated] = await db
    .update(radioSources)
    .set(row)
    .where(eq(radioSources.id, id))
    .returning();
  return updated ? fromRow(updated) : null;
}

export async function deleteSource(id: string): Promise<void> {
  await db.delete(radioSources).where(eq(radioSources.id, id));
}

/**
 * Resolve the catalogued source for an incoming stream URL. Exact
 * `stream_url` match wins first (the dropdown path); failing that, a
 * substring match on `url_pattern` covers free-text / legacy URLs. The
 * most specific (longest) pattern wins when multiple rows match.
 */
export async function findSourceForUrl(url: string): Promise<RadioSource | null> {
  if (!url) return null;

  const [exact] = await db
    .select()
    .from(radioSources)
    .where(eq(radioSources.streamUrl, url))
    .limit(1);
  if (exact) return fromRow(exact);

  const rows = await db.select().from(radioSources);
  const matching = rows
    .filter((r) => url.toLowerCase().includes(r.urlPattern.toLowerCase()))
    .sort((a, b) => b.urlPattern.length - a.urlPattern.length);
  return matching[0] ? fromRow(matching[0]) : null;
}

/**
 * Persist a single latency observation against a source. Overwrites the
 * last-observed offset, stamps the observation time, and bumps the count
 * atomically via a SQL expression.
 */
export async function recordObservation(
  sourceId: string,
  observedOffsetSeconds: number,
): Promise<void> {
  await db
    .update(radioSources)
    .set({
      lastObservedOffsetSeconds: observedOffsetSeconds,
      lastObservedAt: new Date(),
      observationCount: dsql`${radioSources.observationCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(radioSources.id, sourceId));
}
