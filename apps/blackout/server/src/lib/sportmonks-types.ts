/**
 * In-memory cache of Sportmonks' `/v3/core/types` table.
 *
 * Per Sportmonks' best-practices guidance, the Types table rarely changes
 * and is safe to cache for ~a week. Caching locally means we can drop
 * `.type` nested includes on live-feed polls — the full `type` object
 * (~6 fields per row) gets resolved here instead of being embedded in
 * every event / timeline / statistic row downstream.
 *
 * Bootstrapping: call `loadSportmonksTypes()` at server start, before the
 * event source begins polling. Lookup helpers are synchronous thereafter.
 */

import type { SportmonksTypeRef } from "./sportmonks.js";

const TYPES_URL = "https://api.sportmonks.com/v3/core/types";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface TypeRow {
  id: number;
  name: string;
  code: string;
  developer_name: string;
  model_type: string;
  stat_group: string | null;
}

let byId: Map<number, TypeRow> | null = null;
let loadedAt = 0;

async function fetchAll(token: string): Promise<TypeRow[]> {
  const rows: TypeRow[] = [];
  let page = 1;
  while (true) {
    const url = `${TYPES_URL}?api_token=${token}&filters=populate&page=${page}`;
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Sportmonks /core/types ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as {
      data: TypeRow[];
      pagination?: { has_more?: boolean };
    };
    rows.push(...json.data);
    if (!json.pagination?.has_more) break;
    page++;
    if (page > 10) break; // safety — table is ~1300 rows so 2 pages at populate=1000
  }
  return rows;
}

/**
 * Fetch and cache the full types table. Safe to call multiple times —
 * reuses the cached copy unless it's older than the TTL.
 */
export async function loadSportmonksTypes(force = false): Promise<void> {
  if (!force && byId && Date.now() - loadedAt < CACHE_TTL_MS) return;

  const token = process.env.SPORTMONKS_API_TOKEN;
  if (!token) throw new Error("SPORTMONKS_API_TOKEN is not set");

  const rows = await fetchAll(token);
  const next = new Map<number, TypeRow>();
  for (const row of rows) next.set(row.id, row);
  byId = next;
  loadedAt = Date.now();
  console.log(`[sportmonks-types] cached ${rows.length} types`);
}

function ensureLoaded(): Map<number, TypeRow> {
  if (!byId) {
    throw new Error("Sportmonks types cache not loaded — call loadSportmonksTypes() first");
  }
  return byId;
}

export function getTypeById(id: number): TypeRow | null {
  return ensureLoaded().get(id) ?? null;
}

/**
 * Build the `SportmonksTypeRef` shape that live-feed rows used to receive
 * inline via the `.type` nested include. Returns null for unknown ids so
 * callers can log + skip.
 */
export function getTypeRef(id: number): SportmonksTypeRef | null {
  const row = getTypeById(id);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    developer_name: row.developer_name,
    model_type: row.model_type,
    stat_group: row.stat_group,
  };
}

export function findTypesByModel(modelType: string): TypeRow[] {
  return Array.from(ensureLoaded().values()).filter((t) => t.model_type === modelType);
}

/**
 * Return the set of statistic-model type_ids matching a predicate. Used to
 * build server-side filter lists (e.g. pass to `fixtureStatisticTypes:` to
 * restrict the xGFixture include to xG variants only).
 */
export function findStatisticTypeIds(predicate: (t: TypeRow) => boolean): number[] {
  return findTypesByModel("statistic")
    .filter(predicate)
    .map((t) => t.id);
}
