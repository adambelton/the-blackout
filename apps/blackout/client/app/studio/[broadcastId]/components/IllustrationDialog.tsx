"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { brand as C } from "../../../lib/palette";
import type { StudioPoolItem } from "../types";
import { PlaceholderGlyph } from "./PlaceholderGlyph";
import { PoolTagEditor } from "./PoolTagEditor";

export type ViewerState =
  | { kind: "pool"; item: StudioPoolItem }
  | { kind: "preview"; prompt: string; imageUrl: string };

export function IllustrationDialog({
  viewer,
  onClose,
  onUpdatePoolTags,
}: {
  viewer: ViewerState;
  onClose: () => void;
  onUpdatePoolTags: (poolItemId: string, tags: string[]) => Promise<boolean>;
}) {
  const imageUrl =
    viewer.kind === "pool" ? viewer.item.imageUrl : viewer.imageUrl;
  const prompt = viewer.kind === "pool" ? viewer.item.prompt : viewer.prompt;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Illustration"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: `${C.umber}80`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        zIndex: 1000,
      }}
    >
      <div
        className="idle-hidden-scroll"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          width: "min(720px, 92vw)",
          maxHeight: "90vh",
          overflowY: "auto",
          overflowX: "hidden",
          background: C.ivory,
          border: `0.5px solid ${C.celadon}`,
          borderRadius: 12,
          boxShadow: "0 20px 60px rgba(31, 26, 20, 0.2)",
        }}
      >
        <header
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 20px",
            borderBottom: `0.5px solid ${C.celadon}`,
            position: "sticky",
            top: 0,
            background: C.ivory,
            zIndex: 1,
          }}
        >
          <h2
            style={{
              margin: 0,
              fontSize: 15,
              fontWeight: 300,
              letterSpacing: "-0.01em",
              color: C.umber,
            }}
          >
            Illustration
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "transparent",
              border: "none",
              color: C.stone,
              cursor: "pointer",
              padding: 4,
              fontFamily: "inherit",
              lineHeight: 1,
              transition: "color 160ms ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = C.umber;
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = C.stone;
            }}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
              <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
            </svg>
          </button>
        </header>

        <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: 16 }}>
          <div
            style={{
              position: "relative",
              aspectRatio: "4 / 3",
              background: C.celadon,
              borderRadius: 8,
              overflow: "hidden",
            }}
          >
            {imageUrl ? (
              <img
                src={imageUrl}
                alt=""
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
          </div>

          <div
            style={{
              fontSize: 13,
              lineHeight: 1.55,
              color: C.umber,
              whiteSpace: "pre-wrap",
            }}
          >
            {prompt}
          </div>

          {viewer.kind === "pool" ? (
            <PoolTagEditor
              poolItemId={viewer.item.poolItemId}
              initialTags={viewer.item.tags}
              onSave={onUpdatePoolTags}
            />
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
