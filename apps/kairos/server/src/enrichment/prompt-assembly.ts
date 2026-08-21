import type { EnrichmentServiceConfig } from "./base-service.js";
import { REPORT_READINGS_TOOL } from "./llm-enrichment.js";

/**
 * Profile-agnostic framing prose for the brief section. Same on every
 * cycle; cached as part of the system prompt. Pairs with each service's
 * own `briefExtractionGuidance` (concept-aligned, service-specific).
 */
const BRIEF_LENS_NOT_GATE_REMINDER =
  "The brief informs how you interpret live evidence. It does not override what live evidence shows. If the brief names something the new entries don't substantively touch, do not surface it — wait for evidence to call it forward. Brief-informed readings are subject to the same materiality discipline as any other.";

/** Profile-agnostic per-cycle task instructions — identical across every
 * enrichment service. Sits at the bottom of the cached system prompt. */
const PER_CYCLE_TASK_INSTRUCTIONS = [
  "Each cycle you receive three snapshots per subject you're tracking:",
  "  • expressed    — what the audience has been told about this subject",
  "  • acknowledged — a reading briefly surfaced but not fully expressed",
  "  • unexpressed  — your running truth, carrying forward from prior cycles",
  "",
  "You also receive new feed entries since the last cycle.",
  "",
  "Update the unexpressed reading for each subject you see in the new entries. When a subject from the known list reappears, reuse its id exactly. When a genuinely new subject appears, mint a new short id (e.g. `subj-<something-descriptive>`) with a clear human-readable label. Subjects not mentioned in the new entries should not appear in your response — their state holds.",
  "",
  "Report a subject if either:",
  "  • it is new this cycle (first appearance) — always emit with an initial reading grounded in the evidence",
  "  • its reading has materially shifted from its prior state (unexpressed, or expressed if no unexpressed exists yet)",
  "Omit subjects whose reading is unchanged from their prior state and where no new evidence has accumulated. If nothing is new or shifted, return an empty list.",
  "",
  "Some subjects' `expressed` and `acknowledged` snapshots may have been set by a curator adjudication, not by your own prior emission — this is the curator overruling a previous reading you produced (because two services contradicted, or because the subject saturated the broadcast and was locked). Treat these adjudications as the baseline. Only revisit them when the new evidence materially overrides the correction. Continued accumulation of similar evidence does not override; only a qualitative change in what the evidence shows does. If in doubt, leave the corrected baseline alone.",
  "",
  "For each subject you report, `basis` should be one short sentence — what in the new entries moved the reading — and `informedBy` must list the specific entry ids that justified the update (from the new feed entries shown to you).",
  "",
  "Always call the `" + REPORT_READINGS_TOOL + "` tool.",
].join("\n");

/** Brief-init task instructions — for the one-shot pre-broadcast call
 * where the brief is the only material. */
const BRIEF_INIT_TASK_INSTRUCTIONS =
  "Identify the subjects this brief commits the broadcast to track in your domain. For each, mint a stable id (`subj-<descriptive>`), a clear human label, and an initial `reading` grounded in what the brief says. `basis` is one short sentence — what the brief says about this subject — and `informedBy` is a single-element list with a stable identifier you choose for the brief itself (e.g. `\"brief\"`). Subjects whose reading the brief doesn't substantiate should not appear.\n\nAlways call the `" +
  REPORT_READINGS_TOOL +
  "` tool.";

const BRIEF_INIT_PRIORS_REMINDER =
  "The brief is the only material you have for this call. Live evidence has not yet arrived. Treat the priors you lift here as a starting point that future cycles will validate or move; do not over-commit. If the brief offers little for your domain, return few subjects (or none). Don't invent subjects the brief doesn't support.";

const DEFAULT_BRIEF_EXTRACTION_GUIDANCE =
  "The writer has prepared this brief for the broadcast. When new feed entries resonate with material here, let that inform your reading of the entries. The brief defines the meaning palette this engine can compose from when live evidence arrives.";

/**
 * Build the per-cycle system prompt for an enrichment service from its
 * config. Always cached; the runtime brief content is emitted as a
 * separate uncached system segment by `runEnrichmentLLM`.
 *
 * When `hasBrief` is true the prompt includes the brief-extraction
 * guidance + lens-not-gate reminder section; the actual brief content
 * lands in a subsequent uncached system segment. When false, the brief
 * section is omitted entirely — the model sees no instructions about a
 * brief it isn't receiving.
 */
export function assemblePerCycleSystemPrompt(
  cfg: EnrichmentServiceConfig,
  hasBrief: boolean,
): string {
  const sections: string[] = [
    "# Concept",
    cfg.concept.trim(),
    "",
    "# What counts as a subject",
    cfg.subjectGuidance.trim(),
    "",
    "# Reading shape",
    cfg.readingGuidance.trim(),
  ];

  if (hasBrief) {
    sections.push(
      "",
      "# Brief — extraction guidance",
      "",
      cfg.briefExtractionGuidance?.trim() || DEFAULT_BRIEF_EXTRACTION_GUIDANCE,
      "",
      BRIEF_LENS_NOT_GATE_REMINDER,
    );
  }

  sections.push("", "# Your task", PER_CYCLE_TASK_INSTRUCTIONS);
  return sections.join("\n");
}

/**
 * Build the brief-initialisation system prompt — same shape as the
 * per-cycle prompt but with brief-init-specific framing + task. The
 * brief itself lands in a subsequent uncached system segment.
 */
export function assembleBriefInitializationSystemPrompt(config: {
  concept: string;
  subjectGuidance: string;
  readingGuidance: string;
  initializationGuidance: string;
}): string {
  return [
    "# Concept",
    config.concept.trim(),
    "",
    "# What counts as a subject",
    config.subjectGuidance.trim(),
    "",
    "# Reading shape",
    config.readingGuidance.trim(),
    "",
    "# Brief — initialisation guidance",
    "",
    config.initializationGuidance.trim(),
    "",
    BRIEF_INIT_PRIORS_REMINDER,
    "",
    "# Your task",
    "",
    BRIEF_INIT_TASK_INSTRUCTIONS,
  ].join("\n");
}
