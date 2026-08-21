import type { EnrichedPayload, EnrichmentAnnotation, EnrichmentReading, ServiceSpec } from "../../enrichment/types.js";
import type { LLMClient } from "../../llm/types.js";
import type { CurationService, CurationContext, ConflictResolution, NarrativeThread, RelevantThread } from "../types.js";
import type { FeedEntry } from "../../types.js";
import { runCurationLLM, withDecision } from "../llm-curation.js";
import { assembleCurationSystemPrompt } from "../prompt-assembly.js";
import {
  loadBaselineSections,
  mergeBaselineWithSpec,
  readCurationSpec,
  type CurationBaselineSections,
} from "../baseline-loader.js";
import { UTILITY_ANTHROPIC_MODEL, ENRICHMENT_MAX_TOKENS } from "../../llm/defaults.js";

const BASELINE = loadBaselineSections(
  new URL("./context-curator.baseline.md", import.meta.url),
);

const PATTERNS_ECHOES = "patterns_echoes";

/** Threads not used for this many ms count as "fresh" — surfacing is
 * allowed to re-rank them. ~5 cycles at the standard 30s cadence.
 * Heuristic, not load-bearing — the LLM ranker still applies judgment
 * on the freshened pool. */
const RECENCY_FRESHNESS_MS = 3 * 60 * 1000;

/** Cap on how many threads we ask the LLM to rank per cycle. The brief
 * usually yields ~6-12 threads and we want a tight ranking output. */
const MAX_RANKED_THREADS = 5;

/**
 * Single source of truth for narrative_context (brief) usage across a
 * broadcast. Two responsibilities sharing one recency model:
 *
 *   1. Suppression — when patterns_echoes (an enrichment service) claims
 *      a pattern echoes a brief fragment already echoed in the recent
 *      window, kill the redundant echo. Pure logic, no LLM call.
 *
 *   2. Surfacing — at activation, extract a thread inventory from the
 *      brief (one-shot Haiku call). Per cycle, filter threads by
 *      recency (heuristic) then ask Haiku which of the freshened pool
 *      are most relevant to the current moment. Output flows on
 *      `relevantThreads`; the generator uses it when mode is
 *      `context_led`.
 *
 * Recency feedback comes from the cycle outcome: when mode lands on
 * `context_led` and the curator marks threads as surfaced, this
 * service's tracker stamps `lastUsedAt`. Threads emitted on a cycle
 * that ends up action_led / enrichment_led keep their old timestamps —
 * they were not narrated, so they remain fresh.
 */
export class ContextCurator implements CurationService {
  readonly name = "context_curator";

  /** In-instance, lifetime-of-broadcast. Hydrated by `hydrateThreadInventory`
   * from the persisted `broadcasts.briefThreadInventory` column when the
   * conductor (re)starts; populated fresh by `initializeFromBrief` at
   * activation when no persistence exists. */
  private threadInventory: NarrativeThread[] | null = null;
  private threadRecency = new Map<string, number>();
  /** Tracks whether a cycle's extraction LLM call has already been
   * attempted and failed. We don't loop the call — the broadcast
   * proceeds with surfacing disabled until reset. */
  private extractionFailed = false;

  private readonly merged: CurationBaselineSections;

  constructor(readonly spec: ServiceSpec, private llm: LLMClient) {
    this.merged = mergeBaselineWithSpec(BASELINE, readCurationSpec(spec.spec));
  }

  async curate(payload: EnrichedPayload, prior: CurationContext): Promise<CurationContext> {
    // (1) Suppression block — same shape as the retired stand-alone
    //     context_resonance_resolver. Operates on patterns_echoes
    //     annotations regardless of mode.
    let context = this.suppressStaleEchoes(prior);

    // (2) Surfacing block — produce relevantThreads for the cycle.
    //     Always emit (when an inventory is available); the generator
    //     decides whether to act on it based on mode.
    context = await this.surfaceRelevantThreads(payload, context);

    return context;
  }

  /**
   * Mark threads as "used" — called by the curator after `decideMode`
   * if the cycle landed on `context_led` and we surfaced threads. Only
   * actually-narrated threads should update recency, so the call site
   * is gated on mode + the surfaced list.
   *
   * For now we mark all surfaced threads; a tighter loop would parse
   * the played prose for anchor snippets. Worth tightening later if
   * the recency window starts misbehaving.
   */
  markThreadsUsed(threadIds: Iterable<string>): void {
    const now = Date.now();
    for (const id of threadIds) {
      this.threadRecency.set(id, now);
    }
  }

  /**
   * Activation-time extraction. The brief comes from the broadcast's
   * narrative_context entries, joined as a single text block. Returns
   * the inventory so the caller can persist it; caller then either
   * passes it to `hydrateThreadInventory` here (for the same lifetime)
   * or relies on `hydrateThreadInventory` being called on next
   * conductor start with the persisted value.
   *
   * Idempotent: returns the existing inventory when one is already
   * loaded. Returns an empty array when the brief is empty.
   */
  async initializeFromBrief(brief: string): Promise<NarrativeThread[]> {
    if (this.threadInventory !== null) return this.threadInventory;
    if (!brief.trim()) {
      this.threadInventory = [];
      return [];
    }
    const threads = await this.extractThreadsFromBriefText(brief);
    this.threadInventory = threads;
    console.log(
      `[context-curator] brief-init: extracted ${threads.length} thread(s)${threads.length > 0 ? ` — ${threads.map((t) => t.threadId).join(", ")}` : ""}`,
    );
    return threads;
  }

  /** Used by the registry on conductor start when the broadcast row
   * already carries a `briefThreadInventory` from a prior activation —
   * skips the Haiku call entirely. */
  hydrateThreadInventory(threads: NarrativeThread[]): void {
    this.threadInventory = threads;
    this.extractionFailed = false;
  }

  isReady(): boolean { return true; }

  reset(): void {
    this.threadInventory = null;
    this.threadRecency.clear();
    this.extractionFailed = false;
  }

  // ---- Suppression ----

  private suppressStaleEchoes(prior: CurationContext): CurationContext {
    const candidates = prior.selectedAnnotations.filter(
      (a) => a.serviceName === PATTERNS_ECHOES,
    );

    if (candidates.length === 0 || prior.recentCycles.length === 0) {
      return withDecision(prior, this.name, "no patterns_echoes candidates or no history");
    }

    const recentlyEchoed = collectEchoedFragmentIds(prior.recentCycles);
    if (recentlyEchoed.size === 0) {
      return withDecision(prior, this.name, "no recent echoes in window");
    }

    const newConflicts: ConflictResolution[] = [];
    const suppressed: Array<{ subjectId: string; fragments: string[] }> = [];

    for (const ann of candidates) {
      const reading = ann.meaning?.unexpressed as Record<string, unknown> | undefined;
      const echoes = readEchoes(reading);
      if (echoes.length === 0) continue;

      const stale = echoes.filter((id) => recentlyEchoed.has(id));
      if (stale.length === 0) continue;

      const fresh = echoes.filter((id) => !recentlyEchoed.has(id));
      const replacement: EnrichmentReading = {
        ...(reading ?? {}),
        echoesContextEntryIds: fresh,
      };

      newConflicts.push({
        winner: { serviceName: this.name, subjectId: ann.subjectId },
        loser: { serviceName: PATTERNS_ECHOES, subjectId: ann.subjectId },
        reason: `[context-curator/echo] brief fragment(s) ${stale.join(", ")} already echoed within the recent window`,
        replacementReading: replacement,
      });
      suppressed.push({ subjectId: ann.subjectId, fragments: stale });
    }

    if (newConflicts.length === 0) {
      return withDecision(prior, this.name, "no stale echoes");
    }

    return {
      ...prior,
      conflicts: [...prior.conflicts, ...newConflicts],
      decisions: {
        ...prior.decisions,
        [this.name]: {
          serviceName: this.name,
          action: `${newConflicts.length} stale echo(s) suppressed`,
          entriesRemoved: [],
          entriesEmphasized: [],
          meta: {
            suppressed,
            windowSize: prior.recentCycles.length,
            recentlyEchoedCount: recentlyEchoed.size,
          },
        },
      },
    };
  }

  // ---- Surfacing ----

  private async surfaceRelevantThreads(
    payload: EnrichedPayload,
    prior: CurationContext,
  ): Promise<CurationContext> {
    if (this.extractionFailed) return prior;
    if (this.threadInventory === null) {
      // Activation-time initialisation didn't run (or failed). Surfacing
      // is disabled until a new initialisation call lands. The
      // suppression block above still works — it only depends on the
      // `selectedAnnotations` and `recentCycles` provided by the curator.
      return prior;
    }
    if (this.threadInventory.length === 0) return prior;

    // Heuristic recency floor: threads narrated within the freshness
    // window drop out of the candidate pool. Stops the LLM lifting the
    // same thread on consecutive cycles regardless of how much it
    // resonates.
    const now = Date.now();
    const fresh = this.threadInventory.filter((t) => {
      const lastUsed = this.threadRecency.get(t.threadId);
      return lastUsed === undefined || now - lastUsed > RECENCY_FRESHNESS_MS;
    });
    if (fresh.length === 0) {
      return withDecision(prior, this.name, "no fresh threads in window");
    }

    // Threads anchored on brief fragments already cited by surviving
    // patterns_echoes annotations should not be re-surfaced — that's
    // the £262m problem, where the same fragment surfaces twice in one
    // passage via different paths.
    const echoesAlreadyClaimed = collectEchoedFragmentIdsThisCycle(prior.selectedAnnotations);
    const freshNotClaimed = fresh.filter(
      (t) => !t.anchors.some((a) => echoesAlreadyClaimed.has(a)),
    );
    if (freshNotClaimed.length === 0) {
      return withDecision(prior, this.name, "all fresh threads already claimed by enrichment");
    }

    let ranked: RelevantThread[];
    try {
      ranked = await this.rankThreadsForCycle(freshNotClaimed, payload, prior);
    } catch (err) {
      console.error(`[context-curator] thread ranking failed:`, (err as Error).message);
      return prior;
    }

    if (ranked.length === 0) {
      return withDecision(prior, this.name, "ranker returned no threads");
    }

    const existingDecision = prior.decisions[this.name];
    return {
      ...prior,
      relevantThreads: ranked,
      decisions: {
        ...prior.decisions,
        [this.name]: {
          serviceName: this.name,
          action: existingDecision
            ? `${existingDecision.action}; surfaced ${ranked.length} thread(s)`
            : `surfaced ${ranked.length} thread(s)`,
          entriesRemoved: existingDecision?.entriesRemoved ?? [],
          entriesEmphasized: existingDecision?.entriesEmphasized ?? [],
          meta: {
            ...(existingDecision?.meta ?? {}),
            surfacedThreadIds: ranked.map((t) => t.threadId),
            poolSize: this.threadInventory.length,
            freshAfterRecency: fresh.length,
            freshAfterEnrichmentExclusion: freshNotClaimed.length,
          },
        },
      },
    };
  }

  /** One-shot extraction at activation. Reads the full brief text and
   * asks Haiku to identify the distinct narrative threads — recurring
   * storylines, character arcs, conditional meanings — each anchored
   * by short text snippets. Stable for the broadcast's lifetime. */
  private async extractThreadsFromBriefText(briefText: string): Promise<NarrativeThread[]> {
    if (!briefText.trim()) return [];

    const TOOL_NAME = "report_threads";
    const SCHEMA = {
      type: "object",
      properties: {
        threads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              threadId: {
                type: "string",
                description: "A short slug identifying this thread (lowercase, hyphenated). Stable for the broadcast.",
              },
              label: {
                type: "string",
                description: "Human-readable label, ~3-7 words.",
              },
              anchors: {
                type: "array",
                description:
                  "Short text snippets from the brief that anchor this thread. 1-3 snippets, each a phrase or short sentence quoted from the brief.",
                items: { type: "string" },
                minItems: 1,
                maxItems: 5,
              },
              briefRationale: {
                type: "string",
                description: "One-line explanation of why this is a coherent thread.",
              },
            },
            required: ["threadId", "label", "anchors", "briefRationale"],
            additionalProperties: false,
          },
        },
      },
      required: ["threads"],
      additionalProperties: false,
    };

    const userMessage = [
      "## Brief",
      "",
      briefText,
      "",
      "## Task",
      "Identify the distinct narrative threads in this brief — recurring storylines, character arcs, conditional meanings, ideas the writer keeps returning to. Each thread should be anchored by short text snippets quoted from the brief itself. Aim for between 4 and 10 threads. Avoid over-fragmenting (don't list every character separately) and don't merge distinct threads (the £262m thread and Rosenior's return are different stories even if they touch).",
    ].join("\n");

    const response = await this.llm.generate({
      system: [
        {
          text: [
            "# Concept",
            "",
            "A broadcast narrative is a small set of intertwined threads. Identifying them up-front lets later cycles surface threads when the live action gives the narrator little to chew on, without inventing material. A thread is a coherent storyline: a character arc, a tactical question, a conditional meaning the writer has prepared for ('if X happens, Y'), or a recurring frame ('this match is special because...').",
            "",
            "# Your task",
            "",
            "Read the brief. Output the threads. Each thread carries a short stable id, a human label, anchor snippets quoted from the brief, and a one-line rationale.",
          ].join("\n"),
          cache: true,
        },
      ],
      messages: [{ role: "user", content: userMessage }],
      tools: [
        {
          name: TOOL_NAME,
          description: "Report the threads identified in the brief.",
          inputSchema: SCHEMA,
        },
      ],
      toolChoice: { type: "tool", name: TOOL_NAME },
      cacheTools: true,
      model: UTILITY_ANTHROPIC_MODEL,
      maxTokens: ENRICHMENT_MAX_TOKENS,
    });

    const toolCall = response.toolCalls?.[0];
    if (!toolCall || toolCall.name !== TOOL_NAME) return [];
    const input = toolCall.input as { threads?: unknown };
    if (!Array.isArray(input.threads)) return [];

    const threads: NarrativeThread[] = [];
    const seenIds = new Set<string>();
    for (const raw of input.threads) {
      if (!raw || typeof raw !== "object") continue;
      const t = raw as Record<string, unknown>;
      if (typeof t.threadId !== "string" || typeof t.label !== "string") continue;
      if (typeof t.briefRationale !== "string") continue;
      if (!Array.isArray(t.anchors)) continue;
      const anchors = t.anchors.filter((a): a is string => typeof a === "string" && a.length > 0);
      if (anchors.length === 0) continue;
      // Dedup by id — the LLM occasionally repeats.
      if (seenIds.has(t.threadId)) continue;
      seenIds.add(t.threadId);
      threads.push({
        threadId: t.threadId,
        label: t.label,
        anchors,
        briefRationale: t.briefRationale,
      });
    }
    return threads;
  }

  /** Per-cycle relevance ranking. Reads the freshened thread pool +
   * cycle context and asks Haiku which threads are alive right now. */
  private async rankThreadsForCycle(
    pool: NarrativeThread[],
    payload: EnrichedPayload,
    prior: CurationContext,
  ): Promise<RelevantThread[]> {
    const TOOL_NAME = "report_relevant_threads";
    const SCHEMA = {
      type: "object",
      properties: {
        threads: {
          type: "array",
          items: {
            type: "object",
            properties: {
              threadId: {
                type: "string",
                description: "Must match an id from the candidate pool.",
              },
              whyNow: {
                type: "string",
                description: "One-line justification grounded in the current cycle's evidence or the broadcast's state so far.",
              },
            },
            required: ["threadId", "whyNow"],
            additionalProperties: false,
          },
          maxItems: MAX_RANKED_THREADS,
        },
      },
      required: ["threads"],
      additionalProperties: false,
    };

    const poolBlock = pool
      .map(
        (t) =>
          `- ${t.threadId} (${t.label}) — anchors: ${t.anchors.map((a) => `"${a.slice(0, 80)}"`).join(" | ")}\n    rationale: ${t.briefRationale}`,
      )
      .join("\n");

    const annotationsBlock = prior.selectedAnnotations.length === 0
      ? "(none)"
      : prior.selectedAnnotations
          .map((a) => `- ${a.serviceName}/${a.subjectId} (${a.subjectLabel}): ${a.meaning?.basis ?? ""}`)
          .join("\n");

    const entriesBlock = payload.entries.length === 0
      ? "(none)"
      : payload.entries
          .slice(-10) // tail of the cycle is what's freshest
          .map((e) => {
            const content = typeof e.data?.content === "string" ? (e.data.content as string) : "";
            return `- ${e.sourceName ?? "?"}: ${content.slice(0, 140)}`;
          })
          .join("\n");

    const userMessage = [
      "## Broadcast state so far",
      prior.summary?.trim() || "(no summary committed yet)",
      "",
      `## Arc phase: ${prior.arcPhase ?? "(not yet identified)"}`,
      "",
      "## Cycle entries (recent tail)",
      entriesBlock,
      "",
      "## Cycle annotations",
      annotationsBlock,
      "",
      "## Candidate threads",
      poolBlock,
      "",
      "## Task",
      `Pick the top ${MAX_RANKED_THREADS} threads from the candidate pool that are most alive *right now* given the broadcast state, the arc phase, and the cycle's evidence. A thread is alive when the unfolding match has activated its meaning — a Rosenior-return thread is alive when his job is genuinely on the line, not just because Rosenior exists. If fewer than ${MAX_RANKED_THREADS} are genuinely alive, return fewer; do not pad. Each pick gets a one-line "why now" grounded in something concrete from the state above.`,
    ].join("\n");

    const result = await runCurationLLM<{ threads: RelevantThread[] }>({
      client: this.llm,
      systemPrompt: assembleCurationSystemPrompt({
        concept: this.merged.concept,
        taskGuidance: this.merged.taskGuidance,
        hasBrief: false,
      }),
      toolName: TOOL_NAME,
      readingSchema: SCHEMA,
      userMessage,
      parseInput: (input) => {
        if (!input || typeof input !== "object") return null;
        const r = input as { threads?: unknown };
        if (!Array.isArray(r.threads)) return null;
        const poolById = new Map(pool.map((t) => [t.threadId, t]));
        const out: RelevantThread[] = [];
        for (const raw of r.threads) {
          if (!raw || typeof raw !== "object") continue;
          const o = raw as Record<string, unknown>;
          if (typeof o.threadId !== "string" || typeof o.whyNow !== "string") continue;
          const fromPool = poolById.get(o.threadId);
          if (!fromPool) continue; // hallucinated id — drop
          out.push({
            threadId: fromPool.threadId,
            label: fromPool.label,
            anchors: fromPool.anchors,
            whyNow: o.whyNow,
          });
        }
        return { threads: out };
      },
    });

    return result?.threads ?? [];
  }
}

function readEchoes(reading: Record<string, unknown> | undefined): string[] {
  if (!reading) return [];
  const raw = reading.echoesContextEntryIds;
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

function collectEchoedFragmentIds(
  recentCycles: CurationContext["recentCycles"],
): Set<string> {
  const ids = new Set<string>();
  for (const cycle of recentCycles) {
    for (const ann of cycle.annotations) {
      if (ann.serviceName !== PATTERNS_ECHOES) continue;
      const reading = ann.meaning?.unexpressed as Record<string, unknown> | undefined;
      for (const id of readEchoes(reading)) {
        ids.add(id);
      }
    }
  }
  return ids;
}

function collectEchoedFragmentIdsThisCycle(
  annotations: EnrichmentAnnotation[],
): Set<string> {
  const ids = new Set<string>();
  for (const ann of annotations) {
    if (ann.serviceName !== PATTERNS_ECHOES) continue;
    const reading = ann.meaning?.unexpressed as Record<string, unknown> | undefined;
    for (const id of readEchoes(reading)) {
      ids.add(id);
    }
  }
  return ids;
}