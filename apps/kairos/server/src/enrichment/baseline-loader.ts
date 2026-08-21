import { readFileSync } from "node:fs";
import type { EnrichmentSpecContent } from "./spec-types.js";
import { isEvalHeader } from "../eval/spec-eval.js";

/**
 * Parse a `## Section` sectioned markdown blob into a header→body map.
 * Used to load enrichment-service baselines from `<service>.baseline.md`
 * — each header gets exposed as a typed config field on the service.
 *
 * Same shape as `assembleSectionedPrompt`'s internal parser, kept local
 * to enrichment for now. Worth promoting to a shared module if any
 * other surface needs the same parse (curation will when its baselines
 * lift in the next round).
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
 * Section headers a service's baseline.md must carry. Compile-time
 * shape; runtime check below catches a baseline that drops or
 * mis-names one.
 */
export interface EnrichmentBaselineSections {
  concept: string;
  subjectGuidance: string;
  readingGuidance: string;
  briefExtractionGuidance: string;
  /** Optional — only services that lift priors from the brief carry
   * an initialisation section (e.g. patterns_echoes does not). */
  briefInitializationGuidance?: string;
}

const SECTION_HEADERS = {
  concept: "Concept",
  subjectGuidance: "What counts as a subject",
  readingGuidance: "Reading shape",
  briefExtractionGuidance: "Brief — extraction guidance",
  briefInitializationGuidance: "Brief — initialisation guidance",
} as const;

/**
 * Load a service's baseline.md from disk, parse its sections, and
 * return them as a typed object. Throws if a required section is
 * missing — the baseline must carry all four mandatory headers
 * (`## Concept`, `## What counts as a subject`, `## Reading shape`,
 * `## Brief — extraction guidance`); the optional `## Brief —
 * initialisation guidance` is included when present.
 *
 * Profile-content interleaving against the resolved spec happens at
 * prompt-assembly time, not here — this just gets the baseline into
 * memory. See `prompt-assembly.ts`.
 */
export function loadBaselineSections(
  baselineFileUrl: URL,
): EnrichmentBaselineSections {
  const blob = readFileSync(baselineFileUrl, "utf8");
  const parsed = parseSections(blob);

  const required: Array<keyof EnrichmentBaselineSections> = [
    "concept",
    "subjectGuidance",
    "readingGuidance",
    "briefExtractionGuidance",
  ];
  for (const key of required) {
    if (!parsed[SECTION_HEADERS[key]]) {
      throw new Error(
        `baseline ${baselineFileUrl.pathname} is missing required section "## ${SECTION_HEADERS[key]}"`,
      );
    }
  }

  const out: EnrichmentBaselineSections = {
    concept: parsed[SECTION_HEADERS.concept],
    subjectGuidance: parsed[SECTION_HEADERS.subjectGuidance],
    readingGuidance: parsed[SECTION_HEADERS.readingGuidance],
    briefExtractionGuidance: parsed[SECTION_HEADERS.briefExtractionGuidance],
  };

  const initGuidance = parsed[SECTION_HEADERS.briefInitializationGuidance];
  if (initGuidance) out.briefInitializationGuidance = initGuidance;

  return out;
}

/**
 * Resolve the per-service spec content from the typed jsonb payload.
 * Today the placeholder rows carry `{ placeholder: true }`; once
 * content lands the row carries `{ serviceInstructions: "..." }`.
 * Returns `null` when no usable spec content is present — the
 * assembler then renders the baseline alone.
 */
export function readEnrichmentSpec(
  specContent: Record<string, unknown> | null | undefined,
): EnrichmentSpecContent | null {
  if (!specContent) return null;
  const raw = specContent as { serviceInstructions?: unknown };
  if (typeof raw.serviceInstructions !== "string" || raw.serviceInstructions.trim().length === 0) {
    return null;
  }
  return { serviceInstructions: raw.serviceInstructions };
}

/**
 * Interleave the loaded baseline with the resolved spec content,
 * section-by-section, by matching `## Section` headers. Each
 * baseline field gets its profile elaboration appended; sections
 * present in the spec but absent from the baseline are an editorial
 * drift and throw (same discipline as
 * `narrative/spec-types.ts::assembleSectionedPrompt`).
 */
export function mergeBaselineWithSpec(
  baseline: EnrichmentBaselineSections,
  spec: EnrichmentSpecContent | null,
): EnrichmentBaselineSections {
  if (!spec) return baseline;

  const specSections = parseSections(spec.serviceInstructions);
  const baselineHeaders = new Set<string>(Object.values(SECTION_HEADERS));
  for (const header of Object.keys(specSections)) {
    // Eval sections (`## Eval — …`) are the spec's contract, not prompt
    // content — the eval runner reads them via `extractEvalCriteria`; the
    // prompt merge skips them (they never populate a prompt field below).
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
    subjectGuidance:
      merge(baseline.subjectGuidance, SECTION_HEADERS.subjectGuidance) ?? baseline.subjectGuidance,
    readingGuidance:
      merge(baseline.readingGuidance, SECTION_HEADERS.readingGuidance) ?? baseline.readingGuidance,
    briefExtractionGuidance:
      merge(baseline.briefExtractionGuidance, SECTION_HEADERS.briefExtractionGuidance) ??
      baseline.briefExtractionGuidance,
    briefInitializationGuidance: merge(
      baseline.briefInitializationGuidance,
      SECTION_HEADERS.briefInitializationGuidance,
    ),
  };
}
