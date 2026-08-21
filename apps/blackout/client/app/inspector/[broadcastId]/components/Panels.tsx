"use client";

import type {
  PipelineCycleDetail,
  PipelineGeneration,
} from "@blackout/shared";
import type { NarrativeMedia } from "./types";
import { InspectorPanel } from "./InspectorPanel";
import { AssemblyBody } from "./AssemblyBody";
import { EnrichmentBody } from "./EnrichmentBody";
import { CurationBody } from "./CurationBody";
import { OutputBody } from "./OutputBody";

export function Panels({
  detail,
  generation,
  media,
}: {
  detail: PipelineCycleDetail | null;
  generation: PipelineGeneration | null;
  media: NarrativeMedia | null;
}) {
  return (
    <main
      style={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "1fr 1fr 1fr 1fr",
        gap: 20,
        padding: 20,
        minHeight: 0,
      }}
    >
      <InspectorPanel title="Assembly"><AssemblyBody detail={detail} /></InspectorPanel>
      <InspectorPanel title="Enrichment"><EnrichmentBody detail={detail} /></InspectorPanel>
      <InspectorPanel title="Curation"><CurationBody detail={detail} /></InspectorPanel>
      <InspectorPanel title="Output">
        <OutputBody detail={detail} generation={generation} media={media} />
      </InspectorPanel>
    </main>
  );
}
