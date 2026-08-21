import { readFileSync } from "node:fs";
import type { FeedEntry } from "../types.js";
import type { LLMClient } from "../llm/types.js";
import { UTILITY_ANTHROPIC_MODEL, UTILITY_MAX_TOKENS } from "../llm/defaults.js";
import {
  assembleSectionedPrompt,
  type SummarySpecContent,
} from "./spec-types.js";

/**
 * The running summary is the narrator's compact memory between cycles.
 * It carries two kinds of material with very different reliability
 * needs, so we structure it as two glued blocks:
 *
 *   - **Canonical state** — code-templated from the broadcast's
 *     canonical feed entries. Score-bearing events, cards, subs,
 *     gamestate transitions. Regenerated from scratch every cycle from
 *     the live canonical events list, so it can never drift; any
 *     prior cycle's mistake is wiped.
 *
 *   - **Narrative arc** — Haiku-produced. Carries arc direction,
 *     motifs, tonal carry, character threads. Constrained by prompt
 *     to NEVER touch state language (score, scorers, event lists) —
 *     state lives in the templated block above and is no longer
 *     Haiku's responsibility.
 *
 * Architectural rule behind the split: LLMs interpret, never preserve
 * fact. Putting deterministic events through Haiku compression was
 * what dropped the Haaland goal on 2026-04-22; the templated state
 * block makes that class of bug structurally impossible.
 */

const STATE_HEADER = "Canonical state:";
const NARRATIVE_HEADER = "Narrative arc:";

/**
 * Render the canonical state block from the broadcast's priority
 * events. Domain-agnostic — uses the same `[subjectTime'] content`
 * shape the generator's preamble uses, just under a different
 * heading. Returns an empty string when there are no events yet
 * (opening cycles, pre-kickoff windows).
 */
export function formatStateBlock(events: FeedEntry[]): string {
  if (events.length === 0) return "";
  const lines = events
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(renderEventLine);
  return `${STATE_HEADER}\n${lines.join("\n")}`;
}

function renderEventLine(e: FeedEntry): string {
  const d = e.data as Record<string, unknown>;
  const subjectTime = typeof d.subjectTime === "string" ? d.subjectTime : null;
  const content = typeof d.content === "string" ? d.content : JSON.stringify(d);
  const timePrefix = subjectTime ? `[${subjectTime}'] ` : "";
  return `- ${timePrefix}${content}`;
}

/**
 * Glue the two blocks into the stored summary string. Skips empty
 * blocks gracefully — opening cycles have no canonical state; later
 * cycles always have it.
 */
export function assembleRunningSummary(
  stateBlock: string,
  narrativeBlock: string,
): string {
  const parts: string[] = [];
  const trimmedState = stateBlock.trim();
  const trimmedNarrative = narrativeBlock.trim();
  if (trimmedState) parts.push(trimmedState);
  if (trimmedNarrative) parts.push(`${NARRATIVE_HEADER}\n${trimmedNarrative}`);
  return parts.join("\n\n");
}

/**
 * Pull the narrative-arc text out of a previously-assembled running
 * summary. Used by the next cycle's update call so Haiku sees only
 * the narrative carry-over, not the templated state (which it has no
 * authority over and shouldn't be guided by).
 *
 * Returns an empty string when the summary has no narrative section
 * (first cycle, or the previous update returned empty).
 */
export function extractNarrativeBlock(summary: string): string {
  const idx = summary.indexOf(NARRATIVE_HEADER);
  if (idx < 0) return "";
  return summary.slice(idx + NARRATIVE_HEADER.length).trim();
}

/**
 * Profile-agnostic baseline for the narrative-arc summariser. The
 * structural rules — what the note covers, what it does not touch
 * (the templated state block has authority for state), the no-
 * invention rule, the output contract — live here. Per-consumer-
 * category elaborations (sport-flavoured worked examples for what
 * counts as state vs arc, the specific kinds of thread that surface
 * in this domain) live in the `summary` service-spec's
 * `summaryInstructions` and are interleaved by matching `## Section`
 * headers at assembly time. See `docs/prompts-as-content-design.md`.
 */
export const NARRATIVE_INSTRUCTIONS_BASELINE = readFileSync(
  new URL("./summary.baseline.md", import.meta.url),
  "utf8",
).trimEnd();

/** Compose the summary updater's system prompt from the in-code
 * baseline and the resolved profile content. Exported so the merge
 * contract can be unit-tested without invoking the LLM. */
export function buildSummarySystemPrompt(
  summarySpec?: SummarySpecContent | null,
): string {
  return assembleSectionedPrompt(
    NARRATIVE_INSTRUCTIONS_BASELINE,
    summarySpec?.summaryInstructions,
  );
}

export interface UpdateNarrativeBlockOptions {
  client: LLMClient;
  /** The narrative-arc text from the previous cycle's summary —
   * extracted via `extractNarrativeBlock`. Empty on the first cycle. */
  previousNarrative: string;
  /** The narrative passage just delivered. */
  justNarrated: string;
  /** New source entries from the latest flush — the delta, not the full feed. */
  newEntries: FeedEntry[];
  /** Resolved `summary` service spec for the broadcast's event
   * profile. When present, its profile content interleaves with the
   * baseline at `## Section` boundaries. Null / undefined =
   * baseline-only assembly. */
  summarySpec?: SummarySpecContent | null;
}

/**
 * Update the narrative-arc block of the running summary using a
 * small, cheap LLM call. State-bearing material (score, events) is
 * not Haiku's concern here — that's templated separately. Failure
 * here degrades gracefully (caller carries the previous narrative
 * block forward).
 */
export async function updateNarrativeBlock(
  opts: UpdateNarrativeBlockOptions,
): Promise<string> {
  const { client, previousNarrative, justNarrated, newEntries, summarySpec } = opts;

  const systemPrompt = buildSummarySystemPrompt(summarySpec);

  const userMessage = [
    previousNarrative.trim()
      ? `Previous narrative-arc note:\n${previousNarrative.trim()}`
      : "Previous narrative-arc note: (none — this is the opening cycle)",
    "",
    `Just narrated:\n${justNarrated.trim()}`,
    "",
    newEntries.length > 0
      ? `New source entries since last update:\n${summariseEntriesForContext(newEntries)}`
      : "New source entries since last update: (none)",
    "",
    "Return the updated narrative-arc note:",
  ].join("\n");

  const response = await client.generate({
    model: UTILITY_ANTHROPIC_MODEL,
    maxTokens: UTILITY_MAX_TOKENS,
    system: [{ text: systemPrompt, cache: true }],
    messages: [{ role: "user", content: userMessage }],
  });

  return response.text.trim();
}

function summariseEntriesForContext(entries: FeedEntry[]): string {
  return entries
    .map((e) => {
      const d = e.data as { content?: unknown; subjectTime?: unknown };
      const content = typeof d.content === "string" ? d.content : JSON.stringify(e.data);
      const time = typeof d.subjectTime === "string" ? ` @${d.subjectTime}` : "";
      return `- [${e.sourceName}${time}] ${content}`;
    })
    .join("\n");
}
