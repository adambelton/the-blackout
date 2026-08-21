import { and, eq, inArray } from "drizzle-orm";
import { db } from "./client.js";
import { broadcasts, sources, serviceSpecs, eventProfiles } from "./schema.js";
import type { InferSelectModel, InferInsertModel } from "drizzle-orm";
import type * as schema from "./schema.js";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import type { SpecStatus, ServiceType } from "./enums.js";

type Tx = PgTransaction<PostgresJsQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>;
type DbOrTx = typeof db | Tx;

export type BroadcastRow = InferSelectModel<typeof broadcasts>;
export type SourceRow = InferSelectModel<typeof sources>;
export type SourceInsert = Omit<InferInsertModel<typeof sources>, "id" | "broadcastId">;

export interface ResolvedSpec {
  serviceName: string;
  serviceType: ServiceType;
  version: string;
  status: SpecStatus;
  spec: Record<string, unknown>;
}

export interface BroadcastWithConfig {
  broadcast: BroadcastRow;
  sources: SourceRow[];
  resolvedSpecs: ResolvedSpec[];
}

export async function createBroadcastRow(input: {
  eventProfileName: string;
  specOverrides?: Record<string, { version: string }>;
  config?: Record<string, unknown>;
  sources?: SourceInsert[];
}): Promise<BroadcastWithConfig> {
  const profile = await db.query.eventProfiles.findFirst({
    where: eq(eventProfiles.name, input.eventProfileName),
  });
  if (!profile) {
    throw new Error(`Event profile "${input.eventProfileName}" not found`);
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(broadcasts)
      .values({
        eventProfileName: input.eventProfileName,
        specOverrides: input.specOverrides ?? null,
        config: input.config ?? null,
      })
      .returning();

    const sourceRows = input.sources?.length
      ? await tx
          .insert(sources)
          .values(input.sources.map((s) => ({ ...s, broadcastId: row.id })))
          .returning()
      : [];

    const resolvedSpecs = await resolveSpecsForProfile(
      tx,
      input.eventProfileName,
      input.specOverrides ?? {},
    );

    return { broadcast: row, sources: sourceRows, resolvedSpecs };
  });
}

export async function getBroadcastWithConfig(
  broadcastId: string,
): Promise<BroadcastWithConfig | null> {
  const broadcast = await db.query.broadcasts.findFirst({
    where: eq(broadcasts.id, broadcastId),
  });
  if (!broadcast) return null;

  const [sourceRows, resolvedSpecs] = await Promise.all([
    db.select().from(sources).where(eq(sources.broadcastId, broadcastId)),
    resolveSpecsForProfile(
      db,
      broadcast.eventProfileName,
      (broadcast.specOverrides ?? {}) as Record<string, { version: string }>,
    ),
  ]);

  return { broadcast, sources: sourceRows, resolvedSpecs };
}

export async function listBroadcasts(): Promise<BroadcastRow[]> {
  return db.select().from(broadcasts);
}

export async function updateBroadcast(
  broadcastId: string,
  patch: {
    status?: BroadcastRow["status"];
    config?: Record<string, unknown>;
    specOverrides?: Record<string, { version: string }>;
    briefThreadInventory?: BroadcastRow["briefThreadInventory"];
  },
): Promise<BroadcastRow | null> {
  const [row] = await db
    .update(broadcasts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(broadcasts.id, broadcastId))
    .returning();
  return row ?? null;
}

export async function deleteBroadcast(broadcastId: string): Promise<boolean> {
  const result = await db
    .delete(broadcasts)
    .where(eq(broadcasts.id, broadcastId))
    .returning({ id: broadcasts.id });
  return result.length > 0;
}

async function resolveSpecsForProfile(
  exec: DbOrTx,
  profileName: string,
  overrides: Record<string, { version: string }>,
): Promise<ResolvedSpec[]> {
  const profile = await exec.query.eventProfiles.findFirst({
    where: eq(eventProfiles.name, profileName),
  });
  if (!profile) {
    throw new Error(`Event profile "${profileName}" not found`);
  }

  const serviceNames = [
    ...(profile.enrichmentServices as string[]),
    ...((profile.curationServiceTiers as string[][]) ?? []).flat(),
  ];

  const rows = await exec
    .select()
    .from(serviceSpecs)
    .where(
      and(
        eq(serviceSpecs.eventProfileName, profileName),
        inArray(serviceSpecs.serviceName, serviceNames),
      ),
    );

  const resolved: ResolvedSpec[] = [];
  for (const serviceName of serviceNames) {
    const override = overrides[serviceName];
    const candidates = rows.filter((r) => r.serviceName === serviceName);
    let chosen = override
      ? candidates.find((r) => r.version === override.version)
      : candidates.find((r) => r.status === "active") ??
        candidates.find((r) => r.status === "experimental");

    if (!chosen) continue;
    resolved.push({
      serviceName: chosen.serviceName,
      serviceType: chosen.serviceType,
      version: chosen.version,
      status: chosen.status,
      spec: chosen.spec as Record<string, unknown>,
    });
  }

  return resolved;
}
