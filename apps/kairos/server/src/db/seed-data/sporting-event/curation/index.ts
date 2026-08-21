// K6.3 prompts-as-content — v1.0.0 active spec content for the
// `sporting_event` profile's curation services. Mirrors the
// enrichment seed-data shape — `.md` per service, exported as
// CurationSpecContent for the seed to upsert.

import { readFileSync } from "node:fs";
import type { CurationSpecContent } from "../../../../curation/spec-types.js";

const readMd = (filename: string): string =>
  readFileSync(new URL(filename, import.meta.url), "utf8").trimEnd();

export const sportingEventNarrativeArcV1: CurationSpecContent = {
  serviceInstructions: readMd("./narrative-arc.md"),
};

export const sportingEventPriorityV1: CurationSpecContent = {
  serviceInstructions: readMd("./priority.md"),
};

export const sportingEventNarrativeGapV1: CurationSpecContent = {
  serviceInstructions: readMd("./narrative-gap.md"),
};

export const sportingEventBroadcastSummaryV1: CurationSpecContent = {
  serviceInstructions: readMd("./broadcast-summary.md"),
};

export const sportingEventSaturationResolverV1: CurationSpecContent = {
  serviceInstructions: readMd("./saturation-resolver.md"),
};

export const sportingEventContextCuratorV1: CurationSpecContent = {
  serviceInstructions: readMd("./context-curator.md"),
};

export const sportingEventConflictResolverV1: CurationSpecContent = {
  serviceInstructions: readMd("./conflict-resolver.md"),
};
