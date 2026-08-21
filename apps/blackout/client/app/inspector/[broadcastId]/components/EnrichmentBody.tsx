"use client";

import type { PipelineCycleDetail } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { Card } from "./Card";
import { CardHeader } from "./CardHeader";
import { CardBody } from "./CardBody";
import { CardMeta } from "./CardMeta";
import { CardPre } from "./CardPre";
import { SourceLabel } from "./SourceLabel";
import { SubjectLabel } from "./SubjectLabel";
import { Pill } from "./Pill";
import { Empty } from "./Empty";

export function EnrichmentBody({ detail }: { detail: PipelineCycleDetail | null }) {
  if (!detail) return <Empty>Select a cycle.</Empty>;
  const annotations = detail.annotations ?? [];
  if (annotations.length === 0) {
    return <Empty>No annotations produced this cycle.</Empty>;
  }
  return (
    <>
      {annotations.map((a, i) => (
        <Card key={`${a.serviceName}-${a.subjectId ?? i}`}>
          <CardHeader>
            <SourceLabel>{a.serviceName}</SourceLabel>
            {a.subjectLabel ? <SubjectLabel>{a.subjectLabel}</SubjectLabel> : null}
          </CardHeader>
          {a.basis ? <CardBody>{a.basis}</CardBody> : null}
          <CardMeta>
            <details>
              <summary style={{ cursor: "pointer" }}>
                meaning
                {a.informedBy?.length
                  ? ` · ${a.informedBy.length} entry ref${a.informedBy.length === 1 ? "" : "s"}`
                  : ""}
              </summary>
              <CardPre>{JSON.stringify(a.meaning, null, 2)}</CardPre>
              {a.informedBy && a.informedBy.length > 0 ? (
                <div style={{ marginTop: 8 }}>
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
                    refs
                  </span>
                  {a.informedBy.map((id) => <Pill key={id}>{id.slice(0, 8)}</Pill>)}
                </div>
              ) : null}
            </details>
          </CardMeta>
        </Card>
      ))}
    </>
  );
}
