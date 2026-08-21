"use client";

import type { PipelineImageryDecision } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import type { NarrativeMedia } from "./types";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { CardMeta } from "./CardMeta";
import { SourceLabel } from "./SourceLabel";
import { DecisionPill } from "./DecisionPill";
import { ImageryRow } from "./ImageryRow";
import { Pill } from "./Pill";

/** Imagery decision panel — the engine-side audit signal. Renders
 * the requirement Haiku articulated, the decision (pool / generate
 * / hold), the supporting evidence (matched pool item or
 * fresh-generate prompt), and Haiku's rationale. The rendered image
 * is shown below as ground truth — useful for auditing how well
 * pool tags / generation prompts translate to actual visuals. */
export function ImageryBlock({
  imagery,
  illustration,
  onOpenDialog,
}: {
  imagery: PipelineImageryDecision | null;
  illustration: NarrativeMedia["illustration"];
  onOpenDialog: () => void;
}) {
  // Legacy generations (pre-image_requirement) won't have anything
  // here — surface that explicitly rather than rendering a blank
  // section that looks like a bug.
  if (!imagery) {
    return (
      <Card>
        <CardHeader>
          <SourceLabel>Imagery</SourceLabel>
        </CardHeader>
        <CardMeta>
          <span style={{ fontStyle: "italic" }}>
            No imagery decision recorded (legacy generation).
          </span>
        </CardMeta>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <SourceLabel>Imagery</SourceLabel>
        <DecisionPill decision={imagery.decision} />
      </CardHeader>
      {imagery.requirement ? (
        <ImageryRow label="requirement">{imagery.requirement}</ImageryRow>
      ) : null}
      {imagery.decision === "pool" && imagery.matchedPoolItem ? (
        <ImageryRow label="matched">
          {imagery.matchedPoolItem.prompt}
          {imagery.matchedPoolItem.tags.length > 0 ? (
            <div style={{ marginTop: 4 }}>
              {imagery.matchedPoolItem.tags.map((t) => (
                <Pill key={t}>{t}</Pill>
              ))}
            </div>
          ) : null}
        </ImageryRow>
      ) : null}
      {imagery.decision === "generate" && imagery.prompt ? (
        <ImageryRow label="prompt">{imagery.prompt}</ImageryRow>
      ) : null}
      {imagery.rationale ? (
        <ImageryRow label="rationale">{imagery.rationale}</ImageryRow>
      ) : null}
      {illustration?.imageUrl ? (
        <div style={{ marginTop: 10 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 500,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              color: C.stone,
              display: "block",
              marginBottom: 4,
            }}
          >
            as rendered
          </span>
          <button
            type="button"
            onClick={onOpenDialog}
            title={illustration.prompt}
            style={{
              display: "block",
              width: "100%",
              padding: 0,
              border: `0.5px solid ${C.celadon}`,
              borderRadius: 6,
              background: C.ivory,
              cursor: "zoom-in",
              overflow: "hidden",
              lineHeight: 0,
            }}
          >
            <img
              src={illustration.imageUrl}
              alt=""
              style={{
                width: "100%",
                aspectRatio: "4 / 3",
                objectFit: "cover",
                display: "block",
              }}
            />
          </button>
        </div>
      ) : null}
    </Card>
  );
}
