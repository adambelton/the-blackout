"use client";

import type { PipelineCycleDetail } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { MONO } from "./types";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { CardBody } from "./CardBody";
import { SourceLabel } from "./SourceLabel";
import { SkippedPill } from "./SkippedPill";
import { Pill } from "./Pill";
import { Empty } from "./Empty";

export function CurationBody({ detail }: { detail: PipelineCycleDetail | null }) {
  if (!detail) return <Empty>Select a cycle.</Empty>;
  const curation = detail.curation ?? {};
  const parts: React.ReactNode[] = [];

  if (curation.skipped) {
    parts.push(
      <Card key="skipped">
        <CardHeader>
          <SkippedPill>skipped</SkippedPill>
          <span style={{ fontSize: 12, color: C.stone }}>
            curator decided not to generate
          </span>
        </CardHeader>
      </Card>,
    );
  }

  if (curation.summary) {
    parts.push(
      <Card key="summary">
        <CardHeader><SourceLabel>Summary</SourceLabel></CardHeader>
        <CardBody>{curation.summary}</CardBody>
      </Card>,
    );
  }

  if (curation.pacing) {
    parts.push(
      <Card key="pacing">
        <CardHeader><SourceLabel>Pacing</SourceLabel></CardHeader>
        <CardBody>
          {curation.pacing.recommendedWordCount ?? "?"}w / {curation.pacing.cadenceMs ?? "?"}ms
        </CardBody>
      </Card>,
    );
  }

  const decisionKeys = Object.keys(curation.decisions ?? {});
  if (decisionKeys.length > 0) {
    parts.push(
      <Card key="decisions">
        <CardHeader><SourceLabel>Decisions</SourceLabel></CardHeader>
        <div style={{ marginTop: 6 }}>
          {decisionKeys.map((k) => {
            const d = curation.decisions![k];
            return (
              <div
                key={k}
                style={{
                  fontSize: 12,
                  color: C.umber,
                  marginTop: 4,
                  lineHeight: 1.55,
                }}
              >
                <strong style={{ fontWeight: 500 }}>{k}:</strong>{" "}
                <span style={{ color: C.driftwood }}>{d.action || "no decision"}</span>
                {d.entriesRemoved?.length ? (
                  <span style={{ color: C.stone }}>
                    {" "}· removed {d.entriesRemoved.length}
                  </span>
                ) : null}
                {d.entriesEmphasized?.length ? (
                  <span style={{ color: C.forest }}>
                    {" "}· emphasised {d.entriesEmphasized.length}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>,
    );
  }

  if (curation.conflicts && curation.conflicts.length > 0) {
    parts.push(
      <Card key="conflicts">
        <CardHeader><SourceLabel>Conflicts</SourceLabel></CardHeader>
        <div style={{ marginTop: 6 }}>
          {curation.conflicts.map((c, i) => {
            const winner = c.winner ? `${c.winner.serviceName}:${c.winner.subjectId}` : "?";
            const loser = c.loser ? `${c.loser.serviceName}:${c.loser.subjectId}` : "?";
            return (
              <div
                key={i}
                style={{
                  fontSize: 12,
                  color: C.umber,
                  marginTop: 4,
                  lineHeight: 1.55,
                }}
              >
                <span style={{ color: C.forest, fontFamily: MONO }}>{winner}</span>
                <span style={{ color: C.stone }}> &gt; </span>
                <span style={{ color: C.crimson, fontFamily: MONO }}>{loser}</span>
                {c.reason ? (
                  <div style={{ color: C.driftwood, fontSize: 11, marginTop: 2 }}>{c.reason}</div>
                ) : null}
              </div>
            );
          })}
        </div>
      </Card>,
    );
  }

  if (curation.selectedEntryIds && curation.selectedEntryIds.length > 0) {
    parts.push(
      <Card key="selected">
        <CardHeader>
          <SourceLabel>Selected · {curation.selectedEntryIds.length}</SourceLabel>
        </CardHeader>
        <div style={{ marginTop: 6 }}>
          {curation.selectedEntryIds.map((id) => <Pill key={id}>{id.slice(0, 8)}</Pill>)}
        </div>
      </Card>,
    );
  }

  return parts.length > 0 ? <>{parts}</> : <Empty>No curation data recorded.</Empty>;
}
