// K6.3 prompts-as-content — v1.0.0 active spec content for the
// `sporting_event` profile's enrichment services. Each service's
// .md file in this directory carries the per-domain elaboration on
// top of the service's in-code baseline; the registry passes the
// content to the service at activation time, the service merges
// it into its baseline section-by-section, the generator prompt
// reflects both halves.
//
// One export per migrated enrichment service; the seed.ts upserts
// these as the active rows alongside the placeholder experimental
// rows for services that haven't migrated yet.

import { readFileSync } from "node:fs";
import type { EnrichmentSpecContent } from "../../../../enrichment/spec-types.js";

const readMd = (filename: string): string =>
  readFileSync(new URL(filename, import.meta.url), "utf8").trimEnd();

export const sportingEventMomentumV1: EnrichmentSpecContent = {
  serviceInstructions: readMd("./momentum.md"),
};

export const sportingEventTensionConflictV1: EnrichmentSpecContent = {
  serviceInstructions: readMd("./tension-conflict.md"),
};

export const sportingEventThemesV1: EnrichmentSpecContent = {
  serviceInstructions: readMd("./themes.md"),
};

export const sportingEventCharacterArcsV1: EnrichmentSpecContent = {
  serviceInstructions: readMd("./character-arcs.md"),
};

export const sportingEventCharacterRelationshipsV1: EnrichmentSpecContent = {
  serviceInstructions: readMd("./character-relationships.md"),
};

export const sportingEventPatternsEchoesV1: EnrichmentSpecContent = {
  serviceInstructions: readMd("./patterns-echoes.md"),
};
