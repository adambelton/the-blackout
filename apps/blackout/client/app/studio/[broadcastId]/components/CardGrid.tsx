"use client";

import type { Card } from "../types";
import { VISIBLE_CARDS } from "../types";
import { CardView } from "./CardView";
import { GhostSlot } from "./GhostSlot";
import { SkeletonSlot } from "./SkeletonSlot";

export function CardGrid({
  cards,
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
  suggesting,
}: {
  cards: Card[];
  onDiscardPrompt: (id: string) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: (id: string) => void;
  onSetEditBuffer: (id: string, buf: string) => void;
  onCommitEdit: (id: string) => void;
  onGenerate: (id: string) => void;
  onAccept: (id: string) => void;
  onRegenerate: (id: string) => void;
  onDiscardPreview: (id: string) => void;
  onOpenCardViewer: (prompt: string, imageUrl: string) => void;
  suggesting: boolean;
}) {
  const real = cards.slice(0, VISIBLE_CARDS);
  const remaining = VISIBLE_CARDS - real.length;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${VISIBLE_CARDS}, minmax(0, 1fr))`,
        gap: 14,
      }}
    >
      {real.map((card) => (
        <CardView
          key={card.id}
          card={card}
          onDiscardPrompt={() => onDiscardPrompt(card.id)}
          onStartEdit={() => onStartEdit(card.id)}
          onCancelEdit={() => onCancelEdit(card.id)}
          onSetEditBuffer={(b) => onSetEditBuffer(card.id, b)}
          onCommitEdit={() => onCommitEdit(card.id)}
          onGenerate={() => onGenerate(card.id)}
          onAccept={() => onAccept(card.id)}
          onRegenerate={() => onRegenerate(card.id)}
          onDiscardPreview={() => onDiscardPreview(card.id)}
          onOpenCardViewer={onOpenCardViewer}
        />
      ))}
      {Array.from({ length: remaining }).map((_, i) =>
        suggesting && real.length === 0 ? (
          <SkeletonSlot key={`skel-${i}`} />
        ) : (
          <GhostSlot key={`ghost-${i}`} />
        ),
      )}
    </div>
  );
}
