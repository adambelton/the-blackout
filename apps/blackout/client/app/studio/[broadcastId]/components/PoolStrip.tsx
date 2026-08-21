"use client";

import { brand as C } from "../../../lib/palette";
import type { StudioPoolItem } from "../types";
import { PoolThumbnail } from "./PoolThumbnail";

export function PoolStrip({
  pool,
  poolError,
  onRemove,
  onOpen,
}: {
  pool: StudioPoolItem[];
  poolError: string | null;
  onRemove: (poolItemId: string) => void;
  onOpen: (item: StudioPoolItem) => void;
}) {
  if (poolError) {
    return (
      <div style={{ fontSize: 12, color: C.crimson }}>
        Pool error: {poolError}
      </div>
    );
  }
  if (pool.length === 0) {
    return (
      <div
        style={{
          fontSize: 12,
          color: C.stone,
          padding: "14px 16px",
          border: `0.5px dashed ${C.celadon}`,
          borderRadius: 8,
        }}
      >
        No accepted images yet. Work through suggestions below or add a custom prompt.
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 12,
        paddingBottom: 8,
      }}
    >
      {pool.map((item) => (
        <PoolThumbnail
          key={item.poolItemId}
          item={item}
          onRemove={onRemove}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
