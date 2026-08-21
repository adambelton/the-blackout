import { captureInvariant } from "./telemetry.js";
import type { NarrativeCover } from "./narrative/types.js";

/**
 * Domain-agnostic runtime postconditions for Kairos generations.
 * Each check looks at the data we already produce during generation
 * and emits an invariant event when a known-bad pattern shows up.
 * These are production sentinels, not tests — they run on every
 * cycle in prod and surface to PostHog for post-match triage.
 *
 * Consumer-specific invariants (e.g. football events that should be
 * cited) live on the Blackout side, preserving the module boundary.
 */

export function checkGenerationInvariants(args: {
  broadcastId: string;
  narrativeId: string;
  covers: NarrativeCover[];
  includedEntryIds: string[];
  phantomCoverCount: number;
  toolCallFailed: boolean;
}): void {
  const {
    broadcastId,
    narrativeId,
    includedEntryIds,
    phantomCoverCount,
    toolCallFailed,
  } = args;

  // Invariant: phantom covers. The generator cited entry ids that
  // weren't in its context — either a hallucination or a stale
  // reference. filterPhantomCovers already drops them before they
  // leave Kairos; this surfaces the count so a spike is visible.
  if (phantomCoverCount > 0) {
    captureInvariant({
      name: "phantom_covers",
      severity: "warn",
      broadcastId,
      narrativeId,
      message: `generator cited ${phantomCoverCount} entry id(s) not in context`,
      details: {
        phantomCount: phantomCoverCount,
        contextSize: includedEntryIds.length,
      },
    });
  }

  // Invariant: tool-call failed. Generator returned text without
  // invoking `deliver_narrative`. The engine salvages the prose but
  // loses the covers contract for that cycle.
  if (toolCallFailed) {
    captureInvariant({
      name: "tool_call_failed",
      severity: "warn",
      broadcastId,
      narrativeId,
      message: "generator returned text without calling deliver_narrative",
    });
  }

  // `stale_context` retired 2026-04-24 alongside the assembly stage.
  // It was a signal specifically for the recency-cutoff trim that
  // assembly performed; in the corrected pipeline, delta-mode batching
  // means each cycle sees exactly the entries new since the prior
  // trigger, so there is no "dropped as stale" outcome to measure. A
  // replacement telemetry event (`curation_drop`) covers the new
  // shape of the signal — budget-driven eviction in curation — and
  // lives on the curator, not here.
}
