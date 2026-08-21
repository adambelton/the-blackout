/**
 * A pluggable data source for the Kairos engine.
 * Sources emit timestamped entries into the unified feed.
 */
export interface Source {
  readonly name: string;
  start(emit: (entry: SourceEntry) => void): Promise<void> | void;
  stop(): void;
}

export type { SourceType } from "./db/enums.js";
import type { SourceType } from "./db/enums.js";

/**
 * What a source emits. The `data` payload is domain-agnostic — consumers
 * define its shape (e.g. `{ content, minute }` for football commentary).
 */
export interface SourceEntry {
  data: Record<string, unknown>;
  timestamp?: number;
}

/**
 * A feed entry as stored in the database and held in the runtime cache.
 */
export interface FeedEntry {
  id: string;
  broadcastId: string;
  sourceId: string;
  sourceName: string;
  sourceType: SourceType;
  /**
   * Mirrors the source's `canonical` flag. Canonical entries are the
   * ground-truth, state-changing facts of the broadcast (goals, cards,
   * subs, gameplay-state transitions). Curation auto-emphasises every
   * canonical entry, never evicts them under budget pressure, and pulls
   * the cycle to `action_led` mode when any are present. The engine's
   * canonicalEvents filter (running summary state block) keys off this.
   * Cadence is unaffected — priority is a curation signal, not a timing
   * signal.
   */
  sourceCanonical: boolean;
  timestamp: number;
  data: Record<string, unknown>;
  enrichmentTags: string[];
}
