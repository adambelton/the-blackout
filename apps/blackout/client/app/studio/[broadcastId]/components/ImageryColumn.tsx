"use client";

import type { StudioPoolItem, Card } from "../types";
import { SectionHeader } from "./SectionHeader";
import { CardGrid } from "./CardGrid";
import { SuggestBar } from "./SuggestBar";
import { CustomPromptForm } from "./CustomPromptForm";
import { PoolStrip } from "./PoolStrip";

export function ImageryColumn({
  pool,
  poolError,
  onRemovePoolItem,
  onOpenPoolItem,
  queueRemaining,
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
  suggestError,
  onRequestSuggestions,
  customPrompt,
  onCustomPromptChange,
  onSubmitCustomPrompt,
  matchEmpty,
}: {
  pool: StudioPoolItem[];
  poolError: string | null;
  onRemovePoolItem: (poolItemId: string) => void;
  onOpenPoolItem: (item: StudioPoolItem) => void;
  queueRemaining: number;
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
  suggestError: string | null;
  onRequestSuggestions: () => void;
  customPrompt: string;
  onCustomPromptChange: (v: string) => void;
  onSubmitCustomPrompt: () => void;
  matchEmpty: boolean;
}) {
  const poolMeta =
    pool.length > 0
      ? `${pool.length} in pool${queueRemaining > 0 ? ` · ${queueRemaining} queued` : ""}`
      : queueRemaining > 0
        ? `${queueRemaining} queued`
        : undefined;

  return (
    <section
      className="idle-hidden-scroll"
      style={{
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        minHeight: 0,
        overflowY: "auto",
        paddingRight: 6,
      }}
    >
      <SectionHeader label="Illustrations" />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 16,
          marginBottom: 24,
        }}
      >
        <CardGrid
          cards={cards}
          onDiscardPrompt={onDiscardPrompt}
          onStartEdit={onStartEdit}
          onCancelEdit={onCancelEdit}
          onSetEditBuffer={onSetEditBuffer}
          onCommitEdit={onCommitEdit}
          onGenerate={onGenerate}
          onAccept={onAccept}
          onRegenerate={onRegenerate}
          onDiscardPreview={onDiscardPreview}
          onOpenCardViewer={onOpenCardViewer}
          suggesting={suggesting}
        />
        <SuggestBar
          onRequestSuggestions={onRequestSuggestions}
          suggesting={suggesting}
          suggestError={suggestError}
          queueRemaining={queueRemaining}
          cardsCount={cards.length}
          matchEmpty={matchEmpty}
        />
        <CustomPromptForm
          value={customPrompt}
          onChange={onCustomPromptChange}
          onSubmit={onSubmitCustomPrompt}
        />
      </div>

      <SectionHeader label="Illustration pool" meta={poolMeta} />

      <PoolStrip
        pool={pool}
        poolError={poolError}
        onRemove={onRemovePoolItem}
        onOpen={onOpenPoolItem}
      />
    </section>
  );
}
