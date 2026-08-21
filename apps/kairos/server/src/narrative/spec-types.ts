/**
 * Per-event-profile spec shapes for the three narrative-path service types
 * (`generation`, `imagery`, `summary`) lifted into `service_specs` by K6.2.
 *
 * The engine carries profile-agnostic *baseline* prompts in code. The DB
 * carries per-profile *profile content* — sport-flavoured elaborations,
 * worked examples, the way each baseline rule applies to a particular
 * consumer's category. Assembly interleaves them by matching `## Section`
 * headers so each rule reads as `## Header\n{baseline}\n\n{profile?}`.
 *
 * See `docs/prompts-as-content-design.md` and `docs/vocabulary.md` § Time.
 */

import { isEvalHeader } from "../eval/spec-eval.js";

/**
 * `generation` spec content — the prose generator's profile-tuned
 * elaborations on top of the baseline `TASK_INSTRUCTIONS`.
 */
export interface GenerationSpecContent {
  /**
   * Sport-flavoured (or whatever consumer-category-flavoured) elaborations
   * on the baseline task instructions. Section headers (`## Foo`) MUST
   * match the baseline's section headers so the assembly walks them
   * in lockstep.
   */
  taskInstructions: string;
  /**
   * Per-cycle-mode blurbs injected in the user message preamble. The
   * baseline carries the structural concept of three modes (action /
   * enrichment / context); the spec carries the specific guidance for
   * each mode in this consumer category.
   */
  modeBlurbs: {
    action_led: string;
    enrichment_led: string;
    context_led: string;
  };
}

/**
 * `imagery` spec content — the imagery selector's profile-tuned
 * elaborations on top of the baseline `IMAGERY_INSTRUCTIONS`.
 */
export interface ImagerySpecContent {
  /**
   * Section-by-section elaborations on the baseline imagery instructions,
   * with matching `## Header` structure.
   */
  imageryInstructions: string;
}

/**
 * `summary` spec content — the narrative-arc summariser's profile-tuned
 * elaborations on top of the baseline `NARRATIVE_INSTRUCTIONS`.
 */
export interface SummarySpecContent {
  /** Section-by-section elaborations on the baseline summary instructions. */
  summaryInstructions: string;
}

/**
 * Assemble a baseline + an optional profile-content blob by interleaving
 * their `## Section` headers. Both blobs use the same header set; profile
 * content appends to each section's baseline body. Unknown headers in the
 * profile content (no matching baseline section) are surfaced as a thrown
 * Error — header drift between the two is a content bug we want to catch
 * loudly rather than silently drop.
 *
 * The output is a single concatenated string ready to splice into a
 * system prompt or user-message preamble.
 */
export function assembleSectionedPrompt(
  baseline: string,
  profileContent: string | undefined,
): string {
  const baseSections = parseSections(baseline);
  // Eval sections (`## Eval — …`) are the contract, not prompt text — the
  // eval runner reads them via `extractEvalCriteria`; they never enter the
  // assembled prompt. Filter them before assembly on both sides.
  const promptSections = baseSections.filter((s) => !isEvalHeader(s.header));

  if (!profileContent || profileContent.trim().length === 0) {
    return renderSections(promptSections);
  }

  const profileSections = parseSections(profileContent);
  const baseHeaders = new Set(promptSections.map((s) => s.header));
  for (const p of profileSections) {
    if (isEvalHeader(p.header)) continue;
    if (!baseHeaders.has(p.header)) {
      throw new Error(
        `Profile content section "${p.header}" has no matching baseline section. ` +
          `Header drift between baseline and spec is a content bug.`,
      );
    }
  }

  const profileByHeader = new Map(profileSections.map((s) => [s.header, s.body]));

  const out: string[] = [];
  for (const section of promptSections) {
    const profileBody = profileByHeader.get(section.header);
    if (profileBody && profileBody.trim().length > 0) {
      out.push(`## ${section.header}\n\n${section.body.trim()}\n\n${profileBody.trim()}`);
    } else {
      out.push(`## ${section.header}\n\n${section.body.trim()}`);
    }
  }
  return out.join("\n\n");
}

interface Section {
  header: string;
  body: string;
}

function parseSections(blob: string): Section[] {
  // Headers are markdown level-2 (`## Header`). Anything before the
  // first header is treated as a preamble section with empty header
  // (matched only against an empty-header preamble in the other blob,
  // which is the natural pairing).
  const sections: Section[] = [];
  const lines = blob.split("\n");
  let currentHeader: string | null = null;
  let currentBody: string[] = [];
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (currentHeader !== null || currentBody.length > 0) {
        sections.push({ header: currentHeader ?? "", body: currentBody.join("\n").trim() });
      }
      currentHeader = match[1];
      currentBody = [];
      continue;
    }
    currentBody.push(line);
  }
  if (currentHeader !== null || currentBody.length > 0) {
    sections.push({ header: currentHeader ?? "", body: currentBody.join("\n").trim() });
  }
  return sections.filter((s) => s.header !== "" || s.body.length > 0);
}

function renderSections(sections: Section[]): string {
  return sections
    .map((s) => (s.header ? `## ${s.header}\n\n${s.body.trim()}` : s.body.trim()))
    .join("\n\n");
}
