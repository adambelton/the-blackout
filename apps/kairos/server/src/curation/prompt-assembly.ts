/**
 * Profile-agnostic framing prose for the curation services' brief
 * section. Same on every cycle; lives in the cached system prompt.
 */
const BRIEF_LENS_NOT_GATE_REMINDER =
  "The brief informs how you interpret the cycle's evidence. It does not override what the evidence shows. Use it as a lens for what counts as significant or worth surfacing — not as a source of claims to make in the absence of supporting evidence.";

const DEFAULT_BRIEF_EXTRACTION_GUIDANCE =
  "The writer has prepared this brief for the broadcast. Let it inform what counts as significant in the cycle's signals.";

/**
 * Build the per-cycle system prompt for a curation service. Always
 * cached; the runtime brief content is emitted as a separate uncached
 * system segment by `runCurationLLM`.
 *
 * When `hasBrief` is true the prompt includes the brief-extraction
 * guidance + lens-not-gate reminder; the actual brief content lands
 * in a subsequent uncached system segment. When false, the brief
 * section is omitted entirely.
 */
export function assembleCurationSystemPrompt(args: {
  concept: string;
  taskGuidance: string;
  hasBrief: boolean;
  briefExtractionGuidance?: string;
}): string {
  const sections: string[] = ["# Concept", args.concept.trim()];

  if (args.hasBrief) {
    sections.push(
      "",
      "# Brief — extraction guidance",
      "",
      args.briefExtractionGuidance?.trim() || DEFAULT_BRIEF_EXTRACTION_GUIDANCE,
      "",
      BRIEF_LENS_NOT_GATE_REMINDER,
    );
  }

  sections.push("", "# Your task", args.taskGuidance.trim());
  return sections.join("\n");
}
