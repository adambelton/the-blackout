import type { EnrichmentAnnotation } from "../enrichment/types.js";

/**
 * What SaturationResolver and ContextCurator need from cycle history:
 * which annotations fired, which prose landed. Persistence already
 * records the full cycle row in `pipeline_cycles`; this in-memory
 * buffer is the fast lookup the curator reads at the top of each
 * cycle without going back to the DB.
 */
export interface RecentCycleSnapshot {
  cycleId: string | null;
  triggeredAt: number;
  annotations: EnrichmentAnnotation[];
  /** Generated prose for the cycle, or null if no generation landed. */
  prose: string | null;
}

// 30 cycles ≈ 22 minutes at the default 45s flush interval. Sized for
// ContextCurator's long-distance stale-echo window; SaturationResolver
// slices the last 5 internally.
const DEFAULT_CAPACITY = 30;

/**
 * Bounded ring of recent cycle snapshots. Append-only; oldest entries
 * drop off when capacity is exceeded. Used by curation services that
 * judge across cycles (saturation, context resonance) without paying
 * a DB round-trip per cycle.
 */
export class RecentCyclesBuffer {
  private cycles: RecentCycleSnapshot[] = [];

  constructor(private capacity: number = DEFAULT_CAPACITY) {}

  add(snapshot: RecentCycleSnapshot): void {
    this.cycles.push(snapshot);
    while (this.cycles.length > this.capacity) {
      this.cycles.shift();
    }
  }

  list(): RecentCycleSnapshot[] {
    return this.cycles.slice();
  }

  size(): number {
    return this.cycles.length;
  }

  clear(): void {
    this.cycles = [];
  }
}
