import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CyclePipeline, type PipelineRegistry } from "../src/pipeline/pipeline.js";
import type { FeedEntry } from "../src/types.js";

function fakeRegistry(): PipelineRegistry {
  return {
    getEnrichmentServices: () => [],
    persistEnrichmentStates: async () => {},
    getSnapshots: () => [],
  };
}

function entry(id: string): FeedEntry {
  return {
    id,
    broadcastId: "b1",
    sourceId: "s1",
    sourceName: "match_events",
    sourceType: "event",
    timestamp: Date.now(),
    data: { content: `entry ${id}` },
    enrichmentTags: [],
  };
}

describe("CyclePipeline empty-cycle counter", () => {
  it("fires accumulation cycles whether the buffer is empty or full", async () => {
    const triggers: string[] = [];
    const curator = {
      curate: async (_enriched: unknown, reason: string) => {
        triggers.push(reason);
        return { curated: null, handlerResult: null };
      },
    };

    const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, { maxConsecutiveEmptyCycles: 2, persistCycle: async () => null });

    pipeline.onEntry(entry("1"));
    await pipeline.flush();

    assert.deepEqual(triggers, ["accumulation"]);
  });

  it("fires accumulation cycles on empty buffers up to max depth, then stops", async () => {
    const triggers: string[] = [];
    const curator = {
      curate: async (_enriched: unknown, reason: string) => {
        triggers.push(reason);
        return { curated: null, handlerResult: null };
      },
    };

    const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, { maxConsecutiveEmptyCycles: 2, persistCycle: async () => null });

    await pipeline.flush(); // empty cycle 1 → accumulation
    await pipeline.flush(); // empty cycle 2 → accumulation
    await pipeline.flush(); // skipped — depth exhausted
    await pipeline.flush(); // skipped

    assert.deepEqual(triggers, ["accumulation", "accumulation"]);
  });

  it("resets the empty-cycle counter when real entries arrive", async () => {
    const triggers: string[] = [];
    const curator = {
      curate: async (_enriched: unknown, reason: string) => {
        triggers.push(reason);
        return { curated: null, handlerResult: null };
      },
    };

    const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, { maxConsecutiveEmptyCycles: 2, persistCycle: async () => null });

    await pipeline.flush(); // empty 1
    await pipeline.flush(); // empty 2

    pipeline.onEntry(entry("1"));
    await pipeline.flush(); // accumulation — resets counter

    await pipeline.flush(); // empty 1 (fresh)
    await pipeline.flush(); // empty 2 (fresh)
    await pipeline.flush(); // skipped

    // All cycles emit "accumulation" — the cap on consecutive empty
    // cycles lives in `consecutiveEmptyCycles`, not in trigger_reason.
    assert.deepEqual(triggers, [
      "accumulation",
      "accumulation",
      "accumulation",
      "accumulation",
      "accumulation",
    ]);
  });

  it("an external cycle bypasses the empty-cycle cap and emits the external trigger", async () => {
    const triggers: string[] = [];
    const prompts: Array<string | undefined> = [];
    const curator = {
      curate: async (_enriched: unknown, reason: string, consumerPrompt?: string) => {
        triggers.push(reason);
        prompts.push(consumerPrompt);
        return { curated: null, handlerResult: null };
      },
    };

    const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, { maxConsecutiveEmptyCycles: 2, persistCycle: async () => null });

    await pipeline.flush(); // empty 1
    await pipeline.flush(); // empty 2
    await pipeline.flush(); // skipped — cap

    // Consumer asks for a cycle anyway — bypasses the cap and emits
    // the external trigger with the supplied opaque preamble.
    await pipeline.flush({ consumerPrompt: "## Closing passage\n\nfoo" });

    assert.deepEqual(triggers, ["accumulation", "accumulation", "external"]);
    assert.equal(prompts[2], "## Closing passage\n\nfoo");
  });

  it("buffers multiple entries into a single accumulation cycle", async () => {
    const triggers: string[] = [];
    const entryCounts: number[] = [];
    const curator = {
      curate: async (enriched: { entries: FeedEntry[] }, reason: string) => {
        triggers.push(reason);
        entryCounts.push(enriched.entries.length);
        return { curated: null, handlerResult: null };
      },
    };

    const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, { maxConsecutiveEmptyCycles: 2, persistCycle: async () => null });

    pipeline.onEntry(entry("1"));
    pipeline.onEntry(entry("2"));
    pipeline.onEntry(entry("3"));
    await pipeline.flush();

    assert.deepEqual(triggers, ["accumulation"]);
    assert.deepEqual(entryCounts, [3]);
  });

  it("drops narrative_voice entries without enqueuing them", async () => {
    const triggers: string[] = [];
    const entryCounts: number[] = [];
    const curator = {
      curate: async (enriched: { entries: FeedEntry[] }, reason: string) => {
        triggers.push(reason);
        entryCounts.push(enriched.entries.length);
        return { curated: null, handlerResult: null };
      },
    };

    const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, { maxConsecutiveEmptyCycles: 2, persistCycle: async () => null });

    pipeline.onEntry({ ...entry("v"), sourceType: "narrative_voice" });
    await pipeline.flush();

    // Buffer is empty (voice entry filtered out) — accumulation cycle
    // with zero entries.
    assert.deepEqual(triggers, ["accumulation"]);
    assert.deepEqual(entryCounts, [0]);
  });

  it("drops narrative_context entries without enqueuing them", async () => {
    // Root-cause fix for the 2026-04-22 Burnley-City annotation spike:
    // the writer's brief came in via narrative_context and the
    // enrichment services treated it as a source event, firing a full
    // extraction pass over every name/team/theme it mentioned (40
    // annotations from 1 entry). The brief is REFERENCE material —
    // services see it via getNarrativeContext() — not a subject of
    // enrichment. Same handling as narrative_voice.
    const triggers: string[] = [];
    const entryCounts: number[] = [];
    const curator = {
      curate: async (enriched: { entries: FeedEntry[] }, reason: string) => {
        triggers.push(reason);
        entryCounts.push(enriched.entries.length);
        return { curated: null, handlerResult: null };
      },
    };

    const pipeline = new CyclePipeline("b1", fakeRegistry(), curator as never, { maxConsecutiveEmptyCycles: 2, persistCycle: async () => null });

    pipeline.onEntry({ ...entry("c"), sourceType: "narrative_context" });
    await pipeline.flush();

    assert.deepEqual(triggers, ["accumulation"]);
    assert.deepEqual(entryCounts, [0]);
  });
});

// Regression set for the 2026-04-22 Burnley-City annotation spike:
// one cycle surfaced 40 annotations from a single entry, overwhelming
// the curator's prompt. The pipeline caps each service at 5 and logs
// the drop.
describe("CyclePipeline — per-service annotation cap", () => {
  function annotation(suffix: string) {
    return {
      serviceName: "test",
      subjectId: `subj-${suffix}`,
      subjectLabel: suffix,
      meaning: { expressed: null, unexpressed: null, acknowledged: null, basis: "test" },
      informedBy: [],
    };
  }

  function registryWith(services: Array<{ name: string; count: number }>) {
    return {
      getEnrichmentServices: () =>
        services.map((s) => ({
          name: s.name,
          process: async () =>
            Array.from({ length: s.count }, (_, i) => ({ ...annotation(`${s.name}-${i}`), serviceName: s.name })),
        })) as never,
      persistEnrichmentStates: async () => {},
      getSnapshots: () => [],
    };
  }

  it("keeps all annotations when a service emits under the cap", async () => {
    let seen = 0;
    const curator = {
      curate: async (enriched: { annotations: unknown[] }) => {
        seen = enriched.annotations.length;
        return { curated: null, handlerResult: null };
      },
    };
    const pipeline = new CyclePipeline(
      "b1",
      registryWith([{ name: "a", count: 3 }]),
      curator as never,
      { persistCycle: async () => null },
    );
    pipeline.onEntry(entry("1"));
    await pipeline.flush();
    assert.equal(seen, 3);
  });

  it("truncates a service that overshoots to 5 annotations", async () => {
    let seen = 0;
    const curator = {
      curate: async (enriched: { annotations: unknown[] }) => {
        seen = enriched.annotations.length;
        return { curated: null, handlerResult: null };
      },
    };
    const pipeline = new CyclePipeline(
      "b1",
      registryWith([{ name: "a", count: 40 }]),
      curator as never,
      { persistCycle: async () => null },
    );
    pipeline.onEntry(entry("1"));
    await pipeline.flush();
    assert.equal(seen, 5, "one service emitting 40 should be capped to 5");
  });

  it("caps each service independently — 5 per service, summed across services", async () => {
    let seen = 0;
    const perService: Record<string, number> = {};
    const curator = {
      curate: async (enriched: { annotations: Array<{ serviceName: string }> }) => {
        seen = enriched.annotations.length;
        for (const a of enriched.annotations) {
          perService[a.serviceName] = (perService[a.serviceName] ?? 0) + 1;
        }
        return { curated: null, handlerResult: null };
      },
    };
    const pipeline = new CyclePipeline(
      "b1",
      registryWith([
        { name: "themes", count: 12 },
        { name: "arcs", count: 2 },
        { name: "momentum", count: 8 },
      ]),
      curator as never,
      { persistCycle: async () => null },
    );
    pipeline.onEntry(entry("1"));
    await pipeline.flush();
    // themes capped to 5, arcs stays at 2, momentum capped to 5 → 12 total.
    assert.equal(seen, 12);
    assert.deepEqual(perService, { themes: 5, arcs: 2, momentum: 5 });
  });
});

// Regression set for the 2026-04-22 flush-skipping bug: prior to the
// fix, a slow flush (LLM chain > flushIntervalMs) caused every
// subsequent tick to be dropped until the in-flight flush completed.
// Effective cadence became 2 × flushIntervalMs. Now the tick is
// queued and dispatched as soon as the in-flight flush completes,
// making cadence track max(interval, flushDuration).
describe("CyclePipeline — pendingFlushQueued cadence fix", () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  it("runs a queued flush immediately after the in-flight one completes", async () => {
    const starts: number[] = [];
    const flushBarriers: Array<() => void> = [];
    const curator = {
      curate: async () => {
        starts.push(Date.now());
        await new Promise<void>((resolve) => {
          flushBarriers.push(resolve);
        });
        return { curated: null, handlerResult: null };
      },
    };
    const pipeline = new CyclePipeline(
      "b1",
      fakeRegistry(),
      curator as never,
      { flushIntervalMs: 30, persistCycle: async () => null },
    );
    pipeline.onEntry(entry("1"));
    pipeline.onEntry(entry("2"));
    pipeline.start();

    // Wait until the first flush has started.
    await sleep(40);
    assert.equal(starts.length, 1, "first flush should have started");

    // More ticks fire during the in-flight flush. They should collapse
    // into a single queued tick.
    await sleep(100);
    assert.equal(
      starts.length,
      1,
      "no second flush should have started while first is in-flight",
    );

    // Release the first flush. The queued tick should dispatch
    // immediately afterwards.
    flushBarriers[0]();
    await sleep(40);
    assert.equal(starts.length, 2, "queued flush should have dispatched");

    // Release the second so we can shut cleanly.
    flushBarriers[1]();
    await sleep(10);
    pipeline.stop();
  });

  it("collapses multiple ticks during one long flush to a single queued dispatch", async () => {
    const starts: number[] = [];
    const flushBarriers: Array<() => void> = [];
    const curator = {
      curate: async () => {
        starts.push(Date.now());
        await new Promise<void>((resolve) => {
          flushBarriers.push(resolve);
        });
        return { curated: null, handlerResult: null };
      },
    };
    const pipeline = new CyclePipeline(
      "b1",
      fakeRegistry(),
      curator as never,
      { flushIntervalMs: 20, persistCycle: async () => null },
    );
    pipeline.onEntry(entry("1"));
    pipeline.start();

    // Wait long enough for ~5 ticks to fire while the flush is blocked.
    await sleep(110);
    assert.equal(starts.length, 1, "still only one flush in flight");

    flushBarriers[0]();
    await sleep(30);
    assert.equal(
      starts.length,
      2,
      "many backed-up ticks collapse to exactly one queued flush",
    );

    // Clean up.
    if (flushBarriers[1]) flushBarriers[1]();
    pipeline.stop();
  });
});
