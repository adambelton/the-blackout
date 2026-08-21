import { readFileSync } from "node:fs";
import type { CurationSpecContent } from "./spec-types.js";
import { isEvalHeader } from "../eval/spec-eval.js";

/**
 * Parse a `## Section` sectioned markdown blob into a header→body map.
 * Local to curation for now (enrichment has its own copy); worth
 * lifting to a shared util when a third surface needs the same parse.
 */
function parseSections(blob: string): Record<string, string> {
  const out: Record<string, string> = {};
  let currentHeader: string | null = null;
  let currentBody: string[] = [];
  for (const line of blob.split("\n")) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      if (currentHeader !== null) {
        out[currentHeader] = currentBody.join("\n").trim();
      }
      currentHeader = match[1];
      currentBody = [];
      continue;
    }
    currentBody.push(line);
  }
  if (currentHeader !== null) {
    out[currentHeader] = currentBody.join("\n").trim();
  }
  return out;
}

/**
 * Section headers a curation service's baseline.md carries. Curation
 * has a simpler shape than enrichment — no subject vocabulary, no
 * reading-shape section. Just concept + task + an optional brief
 * extraction lens.
 */
export interface CurationBaselineSections {
  concept: string;
  taskGuidance: string;
  /** Optional — services that don't read the brief (e.g. narrative_gap,
   * conflict_resolver) omit this section. */
  briefExtractionGuidance?: string;
}

const SECTION_HEADERS = {
  concept: "Concept",
  taskGuidance: "Task",
  briefExtractionGuidance: "Brief — extraction guidance",
} as const;

/** Load a curation service's baseline.md, parse sections, return
 * typed fields. Throws if a required section is missing. */
export function loadBaselineSections(
  baselineFileUrl: URL,
): CurationBaselineSections {
  const blob = readFileSync(baselineFileUrl, "utf8");
  const parsed = parseSections(blob);

  for (const required of ["concept", "taskGuidance"] as const) {
    if (!parsed[SECTION_HEADERS[required]]) {
      throw new Error(
        `baseline ${baselineFileUrl.pathname} is missing required section "## ${SECTION_HEADERS[required]}"`,
      );
    }
  }

  const out: CurationBaselineSections = {
    concept: parsed[SECTION_HEADERS.concept],
    taskGuidance: parsed[SECTION_HEADERS.taskGuidance],
  };

  const extractionGuidance = parsed[SECTION_HEADERS.briefExtractionGuidance];
  if (extractionGuidance) out.briefExtractionGuidance = extractionGuidance;

  return out;
}

/** Resolve the per-service spec content from the typed jsonb payload.
 * Today the placeholder rows carry `{ placeholder: true }`; once
 * content lands the row carries `{ serviceInstructions: "..." }`.
 * Returns null when no usable spec content is present. */
export function readCurationSpec(
  specContent: Record<string, unknown> | null | undefined,
): CurationSpecContent | null {
  if (!specContent) return null;
  const raw = specContent as { serviceInstructions?: unknown };
  if (typeof raw.serviceInstructions !== "string" || raw.serviceInstructions.trim().length === 0) {
    return null;
  }
  return { serviceInstructions: raw.serviceInstructions };
}

/** Interleave the loaded baseline with the resolved spec content,
 * section-by-section, by matching `## Section` headers. Same
 * discipline as `enrichment/baseline-loader.ts::mergeBaselineWithSpec`. */
export function mergeBaselineWithSpec(
  baseline: CurationBaselineSections,
  spec: CurationSpecContent | null,
): CurationBaselineSections {
  if (!spec) return baseline;

  const specSections = parseSections(spec.serviceInstructions);
  const baselineHeaders = new Set<string>(Object.values(SECTION_HEADERS));
  for (const header of Object.keys(specSections)) {
    // Eval sections are the spec's contract, read by the eval runner via
    // `extractEvalCriteria` — not prompt content, so skip (never merged below).
    if (isEvalHeader(header)) continue;
    if (!baselineHeaders.has(header)) {
      throw new Error(
        `Spec content section "${header}" has no matching baseline section. ` +
          `Header drift between baseline and spec is a content bug.`,
      );
    }
  }

  const merge = (baseBody: string | undefined, header: string): string | undefined => {
    if (baseBody === undefined) return undefined;
    const specBody = specSections[header];
    if (!specBody) return baseBody;
    return `${baseBody.trim()}\n\n${specBody.trim()}`;
  };

  return {
    concept: merge(baseline.concept, SECTION_HEADERS.concept) ?? baseline.concept,
    taskGuidance: merge(baseline.taskGuidance, SECTION_HEADERS.taskGuidance) ?? baseline.taskGuidance,
    briefExtractionGuidance: merge(
      baseline.briefExtractionGuidance,
      SECTION_HEADERS.briefExtractionGuidance,
    ),
  };
}
