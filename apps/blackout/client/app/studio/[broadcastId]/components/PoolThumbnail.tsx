"use client";

import { brand as C } from "../../../lib/palette";
import type { StudioPoolItem } from "../types";
import { PlaceholderGlyph } from "./PlaceholderGlyph";

const POOL_THUMB_WIDTH = 135;

export function PoolThumbnail({
  item,
  onRemove,
  onOpen,
}: {
  item: StudioPoolItem;
  onRemove: (poolItemId: string) => void;
  onOpen: (item: StudioPoolItem) => void;
}) {
  return (
    <div
      style={{
        flex: "0 0 auto",
        width: POOL_THUMB_WIDTH,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(item)}
        aria-label="Open illustration"
        style={{
          position: "relative",
          aspectRatio: "4 / 3",
          background: C.celadon,
          borderRadius: 8,
          overflow: "hidden",
          padding: 0,
          border: "none",
          cursor: "zoom-in",
          fontFamily: "inherit",
        }}
      >
        {item.imageUrl ? (
          <img
            src={item.imageUrl}
            alt={item.prompt}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : (
          <PlaceholderGlyph label="Missing" />
        )}
        <span
          role="button"
          aria-label="Remove from pool"
          title="Remove from pool"
          onClick={(e) => {
            e.stopPropagation();
            onRemove(item.poolItemId);
          }}
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 22,
            height: 22,
            borderRadius: "50%",
            background: `${C.umber}CC`,
            color: C.ivory,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
            fontFamily: "inherit",
          }}
        >
          ×
        </span>
      </button>
      <div
        style={{
          fontSize: 10,
          color: C.driftwood,
          display: "flex",
          flexWrap: "wrap",
          gap: 4,
        }}
      >
        {item.tags.slice(0, 4).map((t) => (
          <span
            key={t}
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              background: `${C.celadon}80`,
              letterSpacing: "0.02em",
            }}
          >
            {t}
          </span>
        ))}
      </div>
    </div>
  );
}
