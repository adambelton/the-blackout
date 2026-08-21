"use client";

import type { PipelineCycleDetail } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { CardBody } from "./CardBody";
import { CardMeta } from "./CardMeta";
import { CardPre } from "./CardPre";
import { SourceLabel } from "./SourceLabel";
import { TypeLabel } from "./TypeLabel";
import { TimeLabel } from "./TimeLabel";
import { formatSubjectMoment } from "./utils";

export function EntryCard({ entry }: { entry: PipelineCycleDetail["chunkEntries"][number] }) {
  const data = entry.data ?? {};
  const content = typeof data.content === "string" ? data.content : "";
  // Precise content time prefers phase + phaseSecond (down to the
  // second) since that's what Kairos's content-time batching keys on.
  // Falls back to legacy minute / subjectTime string when the entry
  // pre-dates phase stamping (older replays, harness fixtures).
  const subjectTime = formatSubjectMoment(data) ?? "—";
  const kvEntries = Object.entries(data).filter(
    ([k]) => !["content", "subjectTime", "minute", "extraMinute", "phase", "phaseSecond"].includes(k),
  );
  const sourceTypeLabel = entry.sourceType && entry.sourceType !== entry.sourceName
    ? entry.sourceType
    : null;

  return (
    <Card>
      <CardHeader>
        <SourceLabel>{entry.sourceName ?? "?"}</SourceLabel>
        {sourceTypeLabel ? <TypeLabel>{sourceTypeLabel}</TypeLabel> : null}
        <TimeLabel>{subjectTime}</TimeLabel>
      </CardHeader>
      {content ? <CardBody>{content}</CardBody> : null}
      {kvEntries.length > 0 ? (
        <CardMeta>
          <details>
            <summary style={{ cursor: "pointer" }}>
              {kvEntries.length} more field{kvEntries.length === 1 ? "" : "s"}
            </summary>
            <CardPre>{JSON.stringify(Object.fromEntries(kvEntries), null, 2)}</CardPre>
          </details>
        </CardMeta>
      ) : null}
    </Card>
  );
}
