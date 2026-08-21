import { readFileSync } from "node:fs";
import type { LLMClient, LLMResponse, SystemSegment, ToolCall } from "../llm/types.js";
import type { FeedEntry } from "../types.js";
import type { AssembledEntry, GenerationContext } from "./types.js";
import type { CurationMode } from "../curation/types.js";
import { extractAnchors } from "./anchors.js";
import { subjectOrdinal } from "../pipeline/subject-time.js";
import {
  assembleSectionedPrompt,
  type GenerationSpecContent,
} from "./spec-types.js";

/** Per-broadcast tense directive — `BroadcastConfig.generator.tense`. */
export type GeneratorTense = "past" | "present" | "dynamic";

/**
 * Profile-agnostic baseline for the prose generator's task instructions.
 * Edited as content in `generator.baseline.md` — read once at module
 * load. Per-consumer-category elaborations live in the `generation`
 * service spec's `taskInstructions` and interleave by matching
 * `## Section` headers at assembly time. See
 * `docs/prompts-as-content-design.md`.
 *
 * Exported so the eval runner can read its `## Eval` section (the
 * baseline machine invariants) alongside the spec's profile invariants.
 */
export const TASK_INSTRUCTIONS_BASELINE = readFileSync(
  new URL("./generator.baseline.md", import.meta.url),
  "utf8",
).trimEnd();

/** Tense directive composed from `BroadcastConfig.generator.tense`,
 * appended after the assembled task instructions. Plain text — not
 * a template language in spec content. */
function formatTenseDirective(tense: GeneratorTense | undefined): string {
  if (!tense) return "";
  switch (tense) {
    case "past":
      return "## Tense\n\nWrite in the past tense throughout. The narrator is recounting what has just unfolded.";
    case "present":
      return "## Tense\n\nWrite in the present tense throughout. The narrator is alongside the listener in the moment.";
    case "dynamic":
      return "## Tense\n\nSelect tense passage-by-passage to match the moment — present when the action is unfolding, past when the moment has settled into something already-finished.";
  }
}

export const DELIVER_NARRATIVE_TOOL_NAME = "deliver_narrative";

const DELIVER_NARRATIVE_TOOL = {
  name: DELIVER_NARRATIVE_TOOL_NAME,
  description: "Deliver a narrative passage with a list of feed entries it covers.",
  inputSchema: {
    type: "object",
    properties: {
      prose: {
        type: "string",
        description:
          "The narrative passage. Place a `{{ref:<entryId>}}` anchor inline at the first material reference to each covered entry — the consumer strips them before playback but uses their position to time event-card / scoreline / illustration reveals.",
      },
      covers: {
        type: "array",
        description: "Feed entries this passage materially covers. Each entry's id must appear in the provided context AND be anchored in the prose.",
        items: {
          type: "object",
          properties: {
            entryId: {
              type: "string",
              description: "The id of a feed entry shown in the context.",
            },
            subjectTime: {
              type: "string",
              description: "A human-readable content-time marker for the entry (e.g. \"67+2\"), if one was shown. Omit if not present.",
            },
          },
          required: ["entryId"],
          additionalProperties: false,
        },
      },
    },
    required: ["prose", "covers"],
    additionalProperties: false,
  },
} as const;

export interface RawCover {
  entryId: string;
  subjectTime?: string;
  /** Character offset in the stripped prose where the entry is
   * anchored. Derived from the `{{ref:...}}` marker the generator
   * placed inline. Absent when the LLM listed a cover but didn't
   * anchor it — consumer falls back to audio-end reveal for that
   * entry. */
  charOffset?: number;
}

export interface GenerationResult {
  text: string;
  covers: RawCover[];
  usage?: LLMResponse["usage"];
  toolCallFailed: boolean;
}

/** Extract narrative_voice content from a feed slice, timestamp-ordered. */
export function collectVoiceText(entries: FeedEntry[]): string {
  return collectAmbient(entries, "narrative_voice");
}

/** Extract narrative_context content from a feed slice, timestamp-ordered. */
export function collectContextText(entries: FeedEntry[]): string {
  return collectAmbient(entries, "narrative_context");
}

/** Extract every moderator-typed directive from a feed slice, in
 * timestamp order. These are the writer's live editorial steering —
 * surfaced at the top of the user message on every cycle so the
 * generator sees them as cumulative directives, not as ordinary chunk
 * entries that curation may evict. The list is the full broadcast's
 * moderator history; ordering preserves later-overrides-earlier
 * semantics implicitly via the model's reading of the list. */
export function collectModeratorDirectives(entries: FeedEntry[]): string[] {
  return entries
    .filter((e) => e.sourceType === "moderator")
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => (typeof e.data.content === "string" ? e.data.content.trim() : ""))
    .filter((s) => s.length > 0);
}

function collectAmbient(entries: FeedEntry[], sourceType: FeedEntry["sourceType"]): string {
  return entries
    .filter((e) => e.sourceType === sourceType)
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => (typeof e.data.content === "string" ? e.data.content : JSON.stringify(e.data)))
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
}

export interface BuildSystemPromptOptions {
  /** Resolved `generation` service spec for this broadcast's event
   * profile. Null = baseline-only assembly (no profile elaboration). */
  generationSpec?: GenerationSpecContent | null;
  /** Per-broadcast tense directive from `BroadcastConfig.generator.tense`. */
  tense?: GeneratorTense;
}

export function buildSystemPrompt(
  voice: string,
  context: string,
  opts: BuildSystemPromptOptions = {},
): string {
  // Activation enforces both are present and non-empty. If we ever
  // reach this function without them, something has bypassed the gate
  // and we want to fail loudly rather than silently narrate nothing.
  if (!voice.trim()) {
    throw new Error("narrative_voice is empty — activation gate should have prevented this");
  }
  if (!context.trim()) {
    throw new Error("narrative_context is empty — activation gate should have prevented this");
  }
  const taskInstructions = assembleSectionedPrompt(
    TASK_INSTRUCTIONS_BASELINE,
    opts.generationSpec?.taskInstructions,
  );
  const tenseDirective = formatTenseDirective(opts.tense);
  const segments = [
    "# Voice", voice.trim(),
    "# Context", context.trim(),
    "# Task", taskInstructions,
  ];
  if (tenseDirective) segments.push(tenseDirective);
  return segments.join("\n\n");
}

/**
 * Variant of `buildSystemPrompt` that returns a cacheable segment
 * array. Voice + context + task + tense are stable for the whole
 * broadcast, so the single segment is marked `cache: true` —
 * Anthropic stores it ephemerally and serves subsequent cycles at
 * ~10% of the uncached rate. Dominant cost lever for long broadcasts.
 */
export function buildSystemSegments(
  voice: string,
  context: string,
  opts: BuildSystemPromptOptions = {},
): SystemSegment[] {
  // Re-use the string builder to keep validation + formatting in one place.
  return [{ text: buildSystemPrompt(voice, context, opts), cache: true }];
}

function formatPhaseSecond(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function formatFeedContext(ctx: GenerationContext): string {
  const parts: string[] = [];
  if (ctx.currentSubjectPhase) {
    const suffix = ctx.currentSubjectPhaseSecond != null ? ` (${formatPhaseSecond(ctx.currentSubjectPhaseSecond)} in)` : "";
    parts.push(`Current phase: ${ctx.currentSubjectPhase}${suffix}`);
  }
  if (ctx.currentSubjectMinute != null) {
    parts.push(`Current match minute: ${ctx.currentSubjectMinute}`);
  }
  // Unified chronological timeline. Each entry carries its source
  // inline so the narrator can distinguish "radio heard" from "event
  // officially recorded" when the two views of the same moment arrive
  // moments apart.
  //
  // Sort by content ordinal so the listing reads in match-time order
  // — phaseSecond=0 boundaries (HALFTIME, FULL_TIME synthetic markers)
  // land last in their phase, post-whistle texture lands after them
  // in the next phase. Without this, an arrival-order listing puts a
  // late-arriving pre-whistle event AFTER the whistle marker, and the
  // generator opens its closing prose on the whistle then circles back
  // (Finding 5 in the 2026-05-03 live test debrief). Stable sort
  // preserves arrival order for ties; null-ordinal entries (ambient,
  // unphased) sort first since they have no content-time anchor.
  //
  // Parent grouping: entries that carry a `parentSourceId` referencing
  // another entry's `canonicalSourceId` in this same context are
  // rendered indented immediately after their parent. Used by
  // `match_action` event_texture entries linking to canonical events —
  // gives the narrator a structured moment ("the goal + its build-up
  // + its reactions") instead of a flat list. Children whose parent
  // isn't in this cycle's context fall back to a flat render with the
  // parent linkage tagged inline.
  const sortedEntries = [...ctx.entries].sort((a, b) => {
    const oa = subjectOrdinal(a.phase, a.phaseSecond) ?? -Infinity;
    const ob = subjectOrdinal(b.phase, b.phaseSecond) ?? -Infinity;
    return oa - ob;
  });
  const byCanonicalId = new Map<string, AssembledEntry>();
  for (const entry of sortedEntries) {
    if (entry.canonicalSourceId) byCanonicalId.set(entry.canonicalSourceId, entry);
  }
  const childrenByParentId = new Map<string, AssembledEntry[]>();
  const rendered = new Set<string>();
  for (const entry of sortedEntries) {
    if (entry.parentSourceId && byCanonicalId.has(entry.parentSourceId)) {
      const list = childrenByParentId.get(entry.parentSourceId) ?? [];
      list.push(entry);
      childrenByParentId.set(entry.parentSourceId, list);
    }
  }

  for (const entry of sortedEntries) {
    if (rendered.has(entry.entryId)) continue;
    parts.push(renderEntryLine(entry, ""));
    rendered.add(entry.entryId);
    const children = entry.canonicalSourceId
      ? childrenByParentId.get(entry.canonicalSourceId)
      : undefined;
    if (!children || children.length === 0) continue;
    children.sort((a, b) => a.timestamp - b.timestamp);
    for (const child of children) {
      if (rendered.has(child.entryId)) continue;
      parts.push(renderEntryLine(child, "    "));
      rendered.add(child.entryId);
    }
  }

  return parts.join("\n");
}

function renderEntryLine(entry: AssembledEntry, indent: string): string {
  const phaseSuffix = entry.phaseSecond != null ? ` · ${formatPhaseSecond(entry.phaseSecond)}` : "";
  const phaseTag = entry.phase ? ` · ${entry.phase}` : "";
  const subjectTimeTag = entry.subjectTime ? ` · ${entry.subjectTime}` : "";
  // Orphan-parent fallback: child whose declared parent isn't in this
  // cycle's window still benefits from the linkage being visible.
  const parentTag = entry.parentSourceId ? ` · parent:${entry.parentSourceId}` : "";
  return `${indent}[id:${entry.entryId} · ${entry.source}${phaseTag}${phaseSuffix}${subjectTimeTag}${parentTag}] ${entry.content}`;
}

function formatPreviousPassage(previousPassage: string | undefined): string {
  const trimmed = previousPassage?.trim();
  if (!trimmed) return "";
  return `Previous passage — continue in its voice and tempo:\n"${trimmed}"\n\n`;
}

function formatSummary(summary: string | undefined): string {
  const trimmed = summary?.trim();
  if (!trimmed) return "";
  // Compact carry of what's been established so far — motifs, arc,
  // through-lines, sometimes a templated state restatement. Canonical
  // events are listed in a separate preamble above and are the
  // authoritative source of truth; this slot is editorial carry,
  // not fresh state. Earlier framing ("state is templated and
  // authoritative") leaked model trust onto curator-produced
  // through-lines and led to brief-meta references in prose
  // ("as the brief suggested he might be"). Honest framing now: this
  // is interpretive memory; the state list above is the ground.
  return `Broadcast memory so far (compact editorial carry — motifs, arc, through-lines from earlier cycles. Canonical events are listed separately above; treat those as ground. Do not re-narrate listed events):\n${trimmed}\n\n`;
}

function formatRefrainHint(refrainStatus: string | undefined): string {
  const trimmed = refrainStatus?.trim();
  if (!trimmed) return "";
  return `${trimmed}\n\n`;
}

function formatConsumerPrompt(consumerPrompt: string | undefined): string {
  // Opaque preamble channel. The consumer writes the actual text —
  // Kairos just splices it in. Keeps Kairos's prompt-shaping logic
  // domain-agnostic; new consumer phase moments don't require a
  // Kairos change.
  const trimmed = consumerPrompt?.trim();
  if (!trimmed) return "";
  return `${trimmed}\n\n`;
}

function formatModeratorDirectives(directives: string[] | undefined): string {
  if (!directives || directives.length === 0) return "";
  // Top-of-prompt steering — the writer's directives apply to every
  // passage going forward, not just the cycle where they were typed.
  // Listed in chronological order so later directives can override
  // earlier ones implicitly through the model's reading. Surfaced
  // separately from the chunk entries so curation can't evict them.
  const lines = directives.map((d) => `- ${d}`).join("\n");
  return `Live editorial steering — directives from the writer that apply to every passage from now on. Honour them above any contrary instinct in the rest of this prompt:\n${lines}\n\n`;
}

function formatTargetWords(targetWords: number | undefined, cycleDurationSeconds: number | undefined): string {
  if (!targetWords || targetWords <= 0) return "";
  const windowClause = cycleDurationSeconds
    ? ` The TTS playback must fit within a ${cycleDurationSeconds}-second cycle.`
    : "";
  return `Aim for roughly ${targetWords} words.${windowClause} Undershoot if there is little to say; do not overshoot.\n\n`;
}

/**
 * Render the canonical events list — the full history of canonical
 * entries, never compressed, never summarised. Antidote to running-
 * summary drift. Emits nothing when the list is empty so pre-kickoff
 * cycles don't carry a useless heading.
 */
export function formatCanonicalEvents(entries: FeedEntry[] | undefined): string {
  if (!entries || entries.length === 0) return "";
  const lines = entries
    .slice()
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((e) => {
      const d = e.data as Record<string, unknown>;
      const subjectTime = typeof d.subjectTime === "string" ? d.subjectTime : null;
      const content = typeof d.content === "string" ? d.content : JSON.stringify(d);
      const timePrefix = subjectTime ? `[${subjectTime}'] ` : "";
      return `- ${timePrefix}${content}`;
    });
  return `Canonical events (ground truth — the authoritative record, never contradict):\n${lines.join("\n")}\n\n`;
}

/** Baseline mode preamble — profile-agnostic minimal cue. The `generation`
 * spec's `modeBlurbs.{action_led,enrichment_led,context_led}` carries
 * the per-consumer-category elaboration that goes after this line in
 * the user-message preamble. Spec-less callers (tests, profiles
 * without a generation spec) get just the baseline; the LLM still
 * knows which point on the pendulum it's at. */
function formatMode(
  mode: CurationMode,
  modeBlurbs?: GenerationSpecContent["modeBlurbs"],
): string {
  const baseline = `Mode: ${mode}.`;
  const profileBlurb = modeBlurbs?.[mode]?.trim();
  if (profileBlurb) return `${baseline} ${profileBlurb}\n\n`;
  return `${baseline}\n\n`;
}

/** Render context_curator's `relevantThreads` for inclusion in the
 * user message when mode is `context_led`. The threads tell the
 * generator which strands of the brief have been judged most alive
 * for this cycle; the generator picks one (or weaves a couple) and
 * writes from there. The list is a recommendation, not a constraint —
 * the generator still has the full brief in cached system context. */
export function formatRelevantThreads(
  threads: Array<{ threadId: string; label: string; anchors: string[]; whyNow: string }> | undefined,
  mode: CurationMode,
): string {
  if (mode !== "context_led" || !threads || threads.length === 0) return "";
  const lines = threads.map(
    (t) =>
      `- ${t.label} — ${t.whyNow}\n    anchors: ${t.anchors.map((a) => `"${a.slice(0, 100)}"`).join(" | ")}`,
  );
  return `Relevant threads (curator-ranked, freshest first — draw from one of these unless the brief gives you a stronger pull):\n${lines.join("\n")}\n\n`;
}

function parseToolCall(toolCall: ToolCall | undefined): { prose: string; covers: RawCover[] } | null {
  if (!toolCall || toolCall.name !== DELIVER_NARRATIVE_TOOL_NAME) return null;
  const input = toolCall.input as { prose?: unknown; covers?: unknown };
  if (typeof input.prose !== "string") return null;

  // Strip the inline `{{ref:...}}` anchors before the prose leaves
  // the generator — they must never reach TTS or the listener. The
  // anchor positions travel on the covers list as `charOffset`,
  // which the consumer uses to time per-entry reveals against the
  // audio's duration.
  const { stripped, anchors } = extractAnchors(input.prose);

  // First-anchor-wins when the LLM places the same entryId more
  // than once (it's told not to, but guard anyway).
  const anchorOffsets = new Map<string, number>();
  for (const a of anchors) {
    if (!anchorOffsets.has(a.entryId)) anchorOffsets.set(a.entryId, a.charOffset);
  }

  const covers: RawCover[] = [];
  if (Array.isArray(input.covers)) {
    for (const c of input.covers) {
      if (c && typeof c === "object" && typeof (c as { entryId?: unknown }).entryId === "string") {
        const entryId = (c as { entryId: string }).entryId;
        const cover: RawCover = { entryId };
        const ct = (c as { subjectTime?: unknown }).subjectTime;
        if (typeof ct === "string" && ct.length > 0) cover.subjectTime = ct;
        const offset = anchorOffsets.get(entryId);
        if (offset != null) cover.charOffset = offset;
        covers.push(cover);
      }
    }
  }

  // Warn on anchors for ids not in covers — the LLM got the prose
  // right but forgot to list the entry. Not fatal (cover drops out)
  // but useful signal for prompt tuning.
  const declared = new Set(covers.map((c) => c.entryId));
  for (const a of anchors) {
    if (!declared.has(a.entryId)) {
      console.warn(
        `[narrative] anchor ${a.entryId} present in prose but not declared in covers`,
      );
    }
  }

  return { prose: stripped, covers };
}

export async function generate(
  client: LLMClient,
  ctx: GenerationContext,
  options: {
    voice: string;
    context: string;
    /** Which pole of the pendulum this cycle lives at. Drives the
     * generator's treatment of the material — see TASK_INSTRUCTIONS.
     * Optional for test/manual paths; production callers always supply. */
    mode?: CurationMode;
    /** Raw canonical feed entries — the ground truth the summary cannot
     * compress away. Rendered in the prompt as a dedicated section so
     * the narrator has an authoritative state reference regardless of
     * how the summary drifted. */
    canonicalEvents?: FeedEntry[];
    summary?: string;
    previousPassage?: string;
    targetWords?: number;
    cycleDurationSeconds?: number;
    /** When true, `ctx` is the delta since the last passage, not a rolling window. */
    deltaMode?: boolean;
    /** Running refrain-usage status, already formatted for the prompt. */
    refrainStatus?: string;
    /** Threads ContextCurator has surfaced for this cycle. Only used
     * when mode is context_led; ignored otherwise. */
    relevantThreads?: Array<{ threadId: string; label: string; anchors: string[]; whyNow: string }>;
    /** Opaque preamble text supplied by the consumer for an off-
     * schedule cycle. Spliced verbatim into the user message ahead of
     * the feed context. Empty / undefined for normal accumulation
     * cycles. The consumer (Blackout, etc.) owns the wording — Kairos
     * is domain-agnostic about what the preamble says. */
    consumerPrompt?: string;
    /** Moderator-typed directives, in chronological order. Surfaced at
     * the very top of the user message as live editorial steering;
     * each directive applies to every passage from when it was typed
     * onward. Separate from the chunk feed so curation can't evict
     * them. Domain-agnostic: Kairos doesn't interpret content, just
     * passes it through as steering text. */
    moderatorDirectives?: string[];
    /** Resolved `generation` service spec for the broadcast's event
     * profile. When present, its profile content interleaves with the
     * baseline at `## Section` boundaries; its `modeBlurbs` drive the
     * per-cycle mode preamble. Null / undefined = baseline-only
     * assembly. */
    generationSpec?: GenerationSpecContent | null;
    /** Per-broadcast tense directive — `BroadcastConfig.generator.tense`. */
    tense?: GeneratorTense;
  },
): Promise<GenerationResult> {
  const system = buildSystemSegments(options.voice, options.context, {
    generationSpec: options.generationSpec,
    tense: options.tense,
  });
  const moderatorDirectivesPreamble = formatModeratorDirectives(options.moderatorDirectives);
  const summaryPreamble = formatSummary(options.summary);
  const previousPassagePreamble = formatPreviousPassage(options.previousPassage);
  const refrainPreamble = formatRefrainHint(options.refrainStatus);
  const targetWordsPreamble = formatTargetWords(options.targetWords, options.cycleDurationSeconds);
  const mode = options.mode ?? "enrichment_led";
  const modePreamble = formatMode(mode, options.generationSpec?.modeBlurbs);
  const relevantThreadsPreamble = formatRelevantThreads(options.relevantThreads, mode);
  const canonicalEventsPreamble = formatCanonicalEvents(options.canonicalEvents);
  const consumerPromptPreamble = formatConsumerPrompt(options.consumerPrompt);

  const feedHeader = options.deltaMode
    ? "Here are the new source entries since the previous passage. Produce the next narrative passage — cover only what's genuinely new, let the running summary carry what came before."
    : "Here is the latest context from the live feed. Produce the next narrative passage.";

  // Moderator directives lead — they're steering, not state. The model
  // should honour them above contrary instincts elsewhere in the prompt.
  const userMessage =
    `${moderatorDirectivesPreamble}${canonicalEventsPreamble}${summaryPreamble}${previousPassagePreamble}${refrainPreamble}${modePreamble}${relevantThreadsPreamble}${targetWordsPreamble}${consumerPromptPreamble}${feedHeader}\n\n${formatFeedContext(ctx)}`;

  const response = await client.generate({
    system,
    messages: [{ role: "user", content: userMessage }],
    tools: [DELIVER_NARRATIVE_TOOL],
    toolChoice: { type: "tool", name: DELIVER_NARRATIVE_TOOL_NAME },
    cacheTools: true,
  });

  const parsed = parseToolCall(response.toolCalls?.[0]);
  if (parsed) {
    return { text: parsed.prose, covers: parsed.covers, usage: response.usage, toolCallFailed: false };
  }

  // Fallback: the model returned plain text instead of using the tool.
  // Rare with forced tool_choice but not impossible — keep the passage
  // intact so the consumer still gets prose, log the failure, and emit
  // an empty covers list.
  console.warn(
    `[narrative] deliver_narrative tool was not invoked — falling back to raw text (toolCalls: ${response.toolCalls?.length ?? 0})`,
  );
  return { text: response.text, covers: [], usage: response.usage, toolCallFailed: true };
}
