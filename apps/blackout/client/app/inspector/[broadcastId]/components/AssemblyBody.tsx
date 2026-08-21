"use client";

import type { PipelineCycleDetail } from "@blackout/shared";
import { Empty } from "./Empty";
import { EntryCard } from "./EntryCard";

export function AssemblyBody({ detail }: { detail: PipelineCycleDetail | null }) {
  if (!detail) return <Empty>Select a cycle.</Empty>;
  const entries = detail.chunkEntries ?? [];
  if (entries.length === 0) {
    return <Empty>Empty buffer — empty-cycle pacing.</Empty>;
  }
  return (
    <>
      {entries.map((e) => <EntryCard key={e.id} entry={e} />)}
    </>
  );
}
