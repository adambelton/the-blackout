"use client";

import { brand as C } from "../../../lib/palette";
import type { Card } from "../types";
import { PlaceholderGlyph } from "./PlaceholderGlyph";
import { CardAction } from "./CardAction";

export function CardView({
  card,
  onDiscardPrompt,
  onStartEdit,
  onCancelEdit,
  onSetEditBuffer,
  onCommitEdit,
  onGenerate,
  onAccept,
  onRegenerate,
  onDiscardPreview,
  onOpenCardViewer,
}: {
  card: Card;
  onDiscardPrompt: () => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSetEditBuffer: (buf: string) => void;
  onCommitEdit: () => void;
  onGenerate: () => void;
  onAccept: () => void;
  onRegenerate: () => void;
  onDiscardPreview: () => void;
  onOpenCardViewer: (prompt: string, imageUrl: string) => void;
}) {
  const imageUrl = card.illustration?.imageUrl ?? null;
  const showImage = imageUrl && (card.mode === "preview" || card.mode === "busy");
  const zoomable = card.mode === "preview" && !!imageUrl;

  return (
    <article
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
        padding: 14,
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        background: C.ivory,
      }}
    >
      <div
        onClick={zoomable ? () => onOpenCardViewer(card.prompt, imageUrl!) : undefined}
        style={{
          position: "relative",
          aspectRatio: "4 / 3",
          borderRadius: 6,
          overflow: "hidden",
          background: C.celadon,
          cursor: zoomable ? "zoom-in" : "default",
        }}
      >
        {showImage ? (
          <img
            src={imageUrl!}
            alt={card.prompt}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: "block",
            }}
          />
        ) : card.mode === "editing" ? (
          <textarea
            value={card.editBuffer ?? ""}
            onChange={(e) => onSetEditBuffer(e.target.value)}
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              padding: 14,
              boxSizing: "border-box",
              resize: "none",
              border: "none",
              outline: "none",
              background: `${C.celadon}55`,
              fontFamily: "inherit",
              fontSize: 12.5,
              lineHeight: 1.55,
              color: C.umber,
            }}
            autoFocus
          />
        ) : card.mode === "prompt" ? (
          <div
            className="idle-hidden-scroll"
            style={{
              position: "absolute",
              inset: 0,
              padding: 14,
              boxSizing: "border-box",
              overflowY: "auto",
              fontSize: 12.5,
              lineHeight: 1.55,
              color: C.umber,
              whiteSpace: "pre-wrap",
            }}
          >
            {card.prompt}
          </div>
        ) : (
          <PlaceholderGlyph label="Awaiting" />
        )}

        {card.mode === "generating" || card.mode === "busy" ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: C.ivory,
              fontSize: 11,
              letterSpacing: "0.12em",
              textTransform: "uppercase",
              background: showImage ? `${C.umber}50` : `${C.umber}90`,
            }}
          >
            {card.mode === "busy" ? "Saving…" : "Generating…"}
          </div>
        ) : null}
      </div>

      {card.error ? (
        <div style={{ fontSize: 11, color: C.crimson }}>{card.error}</div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {card.mode === "prompt" ? (
          <>
            <CardAction onClick={onGenerate} primary>
              Generate
            </CardAction>
            <CardAction onClick={onStartEdit}>Edit</CardAction>
            <CardAction onClick={onDiscardPrompt} subdued>
              Discard
            </CardAction>
          </>
        ) : card.mode === "editing" ? (
          <>
            <CardAction onClick={onCommitEdit} primary>
              Save edit
            </CardAction>
            <CardAction onClick={onCancelEdit}>Cancel</CardAction>
          </>
        ) : card.mode === "preview" ? (
          <>
            <CardAction onClick={onAccept} primary>
              Accept
            </CardAction>
            <CardAction onClick={onRegenerate}>Regenerate</CardAction>
            <CardAction onClick={onDiscardPreview} subdued>
              Discard
            </CardAction>
          </>
        ) : null}
      </div>
    </article>
  );
}
