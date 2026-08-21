"use client";

import { useState } from "react";
import type {
  PipelineCycleDetail,
  PipelineGeneration,
  PipelineImageryDecision,
} from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";
import type { NarrativeMedia } from "./types";
import { Empty } from "./Empty";
import { Pill } from "./Pill";
import { ImageryBlock } from "./ImageryBlock";
import { IllustrationDialog } from "./IllustrationDialog";

export function OutputBody({
  detail,
  generation,
  media,
}: {
  detail: PipelineCycleDetail | null;
  generation: PipelineGeneration | null;
  media: NarrativeMedia | null;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  if (!detail) return <Empty>Select a cycle.</Empty>;
  if (!detail.generationId) {
    return <Empty>No generation produced for this cycle.</Empty>;
  }
  if (!generation) {
    return <Empty>Loading generation…</Empty>;
  }
  const covers = generation.covers ?? [];
  const usage = generation.tokenUsage ?? {};
  const curatedEntryCount =
    ((generation.contextPackage as { includedEntryIds?: string[] } | undefined)
      ?.includedEntryIds ?? []).length;
  const imagery =
    (generation.contextPackage as { imagery?: PipelineImageryDecision } | undefined)
      ?.imagery ?? null;
  const illustration = media?.illustration ?? null;
  return (
    <>
      <div
        style={{
          background: `${C.celadon}40`,
          border: `0.5px solid ${C.celadon}`,
          padding: "14px 16px",
          borderRadius: 8,
          lineHeight: 1.7,
          marginBottom: 14,
          fontSize: 14,
          fontWeight: 300,
          color: C.umber,
          letterSpacing: "-0.005em",
          whiteSpace: "pre-wrap",
        }}
      >
        {generation.output || ""}
      </div>
      <ImageryBlock
        imagery={imagery}
        illustration={illustration}
        onOpenDialog={() => setDialogOpen(true)}
      />
      <div style={{ fontSize: 12, color: C.stone, lineHeight: 1.6, marginTop: 14 }}>
        <span
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: "0.12em",
            textTransform: "uppercase",
            color: C.stone,
            marginRight: 8,
          }}
        >
          covers
        </span>
        {covers.length > 0
          ? covers.map((c) => (
              <Pill key={c.entryId}>
                {c.entryId.slice(0, 8)}
                {c.contentTime ? ` · ${c.contentTime}` : ""}
              </Pill>
            ))
          : <span style={{ color: C.driftwood }}>None reported.</span>}
      </div>
      <div
        style={{
          marginTop: 14,
          paddingTop: 10,
          borderTop: `0.5px solid ${C.celadon}`,
          fontSize: 11,
          color: C.stone,
          fontFamily: MONO,
          lineHeight: 1.6,
        }}
      >
        tokens: {usage.inputTokens ?? "?"}in / {usage.outputTokens ?? "?"}out
        <br />
        curated: {curatedEntryCount} {curatedEntryCount === 1 ? "entry" : "entries"}
      </div>
      {dialogOpen && illustration?.imageUrl ? (
        <IllustrationDialog
          imageUrl={illustration.imageUrl}
          prompt={illustration.prompt}
          model={illustration.model}
          generationMs={illustration.generationMs}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}
