import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "./db/client.js";
import { feedEntries, sources as sourcesTable } from "./db/schema.js";
import type { FeedEntry, SourceType } from "./types.js";
import type { SourceRow } from "./db/broadcasts.js";

function rowToEntry(
  row: typeof feedEntries.$inferSelect,
  source: { name: string; type: SourceType; canonical: boolean },
): FeedEntry {
  return {
    id: row.id,
    broadcastId: row.broadcastId,
    sourceId: row.sourceId,
    sourceName: source.name,
    sourceType: source.type,
    sourceCanonical: source.canonical,
    timestamp: row.timestamp.getTime(),
    data: row.data,
    enrichmentTags: (row.enrichmentTags ?? []) as string[],
  };
}

/**
 * The unified event feed. Entries are persisted to Postgres and cached
 * in memory for the runtime's lifetime; subscribers fire in-process.
 */
export class Feed {
  private cache: FeedEntry[] = [];
  private listener: ((entry: FeedEntry) => void) | null = null;

  constructor(private broadcastId: string) {}

  subscribe(onEntry: (entry: FeedEntry) => void): void {
    this.listener = onEntry;
  }

  async hydrate(): Promise<void> {
    const rows = await db
      .select({ entry: feedEntries, source: sourcesTable })
      .from(feedEntries)
      .innerJoin(sourcesTable, eq(feedEntries.sourceId, sourcesTable.id))
      .where(eq(feedEntries.broadcastId, this.broadcastId))
      .orderBy(asc(feedEntries.timestamp));

    this.cache = rows.map((r) => rowToEntry(r.entry, r.source));
    console.log(`[feed] hydrated ${this.cache.length} entries for ${this.broadcastId}`);
  }

  async push(source: SourceRow, data: Record<string, unknown>, timestamp?: number): Promise<FeedEntry> {
    // Defense-in-depth dedup. The convention across consumers: when a
    // source's rows have a stable external identity, they put it in
    // `data.sourceId`. Kairos doesn't interpret what it means — only
    // checks for collisions within the same (broadcast, source) pair.
    // On collision, return the existing row instead of inserting,
    // skip the cache append (it's already there), and skip the
    // listener (subscribers already received it on its first arrival).
    //
    // This makes `push` idempotent for any consumer that sets sourceId,
    // which is what the Blackout's broadcast-runner does for every
    // Sportmonks-backed event. Pre-existing duplicate rows from before
    // this dedup landed are unaffected — the cache + view layer dedup
    // on the Blackout side still collapses them.
    const externalId = data.sourceId;
    if (externalId !== undefined && externalId !== null) {
      const existing = await db
        .select()
        .from(feedEntries)
        .where(
          and(
            eq(feedEntries.broadcastId, this.broadcastId),
            eq(feedEntries.sourceId, source.id),
            sql`data->>'sourceId' = ${String(externalId)}`,
          ),
        )
        .limit(1);
      if (existing.length > 0) {
        console.log(
          `[feed] ${source.name.toUpperCase()}: deduped sourceId=${externalId} (returning existing entry ${existing[0].id})`,
        );
        return rowToEntry(existing[0], {
          name: source.name,
          type: source.type,
          canonical: source.canonical,
        });
      }
    }

    const [row] = await db
      .insert(feedEntries)
      .values({
        broadcastId: this.broadcastId,
        sourceId: source.id,
        data,
        enrichmentTags: (source.enrichmentTags ?? []) as string[],
        ...(timestamp ? { timestamp: new Date(timestamp) } : {}),
      })
      .returning();

    const entry = rowToEntry(row, {
      name: source.name,
      type: source.type,
      canonical: source.canonical,
    });
    this.cache.push(entry);
    this.listener?.(entry);

    const preview = typeof data.content === "string"
      ? (data.content as string).slice(0, 100)
      : JSON.stringify(data).slice(0, 100);
    console.log(`[feed] ${source.name.toUpperCase()}: ${preview}`);

    return entry;
  }

  getAll(): FeedEntry[] {
    return this.cache.slice();
  }

  /**
   * Query feed entries from the database with filters. Used by the entries
   * list endpoint — independent of the runtime cache.
   */
  async query(filters: {
    sourceName?: string;
    fromTimestamp?: number;
    toTimestamp?: number;
    tag?: string;
  }): Promise<FeedEntry[]> {
    const conditions = [eq(feedEntries.broadcastId, this.broadcastId)];

    if (filters.fromTimestamp) {
      conditions.push(gte(feedEntries.timestamp, new Date(filters.fromTimestamp)));
    }
    if (filters.toTimestamp) {
      conditions.push(lte(feedEntries.timestamp, new Date(filters.toTimestamp)));
    }
    if (filters.sourceName) {
      conditions.push(eq(sourcesTable.name, filters.sourceName));
    }

    const rows = await db
      .select({ entry: feedEntries, source: sourcesTable })
      .from(feedEntries)
      .innerJoin(sourcesTable, eq(feedEntries.sourceId, sourcesTable.id))
      .where(and(...conditions))
      .orderBy(asc(feedEntries.timestamp));

    let entries = rows.map((r) => rowToEntry(r.entry, r.source));

    if (filters.tag) {
      entries = entries.filter((e) => e.enrichmentTags.includes(filters.tag!));
    }

    return entries;
  }
}
