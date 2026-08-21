"use client";

import { use, useCallback, useEffect, useRef, useState } from "react";
import type { Broadcast, BroadcastStatus } from "@blackout/shared";
import { AdminFooter } from "../../components/AdminFooter";
import { PageHeader } from "../../components/PageHeader";
import { StatusPill } from "../../components/StatusPill";
import { brand as C } from "../../lib/palette";
import { apiDelete, apiGet, apiPatch, apiPost } from "@/lib/api";
import { routes } from "@/lib/routes";
import type { StudioPoolItem, StudioGeneratedIllustration, Card } from "./types";
import { VISIBLE_CARDS } from "./types";
import { BriefsColumn } from "./components/BriefsColumn";
import { ImageryColumn } from "./components/ImageryColumn";
import { IllustrationDialog } from "./components/IllustrationDialog";

/**
 * Content studio — the writer's prep workspace for a broadcast. Owns
 * the match brief (narrative_context) and the illustration pool. The
 * narrative voice is a product-wide default loaded from
 * `content/voice.md`, not a per-broadcast field. Live ops stays on
 * /moderator.
 *
 * Illustration flow: ask for a batch of Haiku-suggested prompts,
 * review 3-5 at a time as cards, discard or generate each, then on
 * a generated image accept / regenerate / discard. Accepted items
 * land in the per-broadcast pool in Kairos (via the Blackout proxy
 * routes) where the imagery selector can pick from them at runtime.
 */

const SUGGESTION_BATCH = 25;

let cardSeq = 0;
function newCardId(): string {
  cardSeq++;
  return `c${Date.now().toString(36)}-${cardSeq}`;
}

export default function StudioPage({
  params,
}: {
  params: Promise<{ broadcastId: string }>;
}) {
  const { broadcastId } = use(params);

  const [broadcast, setBroadcast] = useState<Broadcast | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [matchBrief, setMatchBrief] = useState("");
  const [briefDirty, setBriefDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [pool, setPool] = useState<StudioPoolItem[]>([]);
  const [poolError, setPoolError] = useState<string | null>(null);
  const [queue, setQueue] = useState<string[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  // Tracks prompts seen this session so a suggest-re-request doesn't
  // surface one we've already shown (server-side history covers
  // persisted accepts/discards, but an undecided card from earlier in
  // the session shouldn't reappear).
  const seenPromptsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    apiGet<Broadcast>(routes.broadcasts.item(broadcastId))
      .then((b) => {
        if (cancelled) return;
        setBroadcast(b);
        setMatchBrief(b.matchBrief ?? "");
      })
      .catch((err) => {
        if (!cancelled) setLoadError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [broadcastId]);

  const loadPool = useCallback(async () => {
    try {
      const body = await apiGet<{ items: StudioPoolItem[] }>(
        routes.broadcasts.studio.pool(broadcastId),
      );
      setPool(body.items);
      setPoolError(null);
    } catch (err) {
      setPoolError((err as Error).message);
    }
  }, [broadcastId]);

  useEffect(() => {
    loadPool();
  }, [loadPool]);

  const status: BroadcastStatus = broadcast?.status ?? "draft";
  const editable = status === "draft" || status === "scheduled";
  const matchEmpty = matchBrief.trim().length === 0;
  const canSave = editable && briefDirty && !matchEmpty;

  const saveBrief = useCallback(async () => {
    if (!broadcast) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await apiPatch<{ matchBrief: string }, Broadcast>(
        routes.broadcasts.item(broadcast.id),
        { matchBrief },
      );
      setBroadcast(updated);
      setBriefDirty(false);
      setSavedAt(Date.now());
    } catch (err) {
      setSaveError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, [broadcast, matchBrief]);

  // Keep cards topped up whenever the queue changes or a card drops.
  useEffect(() => {
    if (cards.length < VISIBLE_CARDS && queue.length > 0) {
      const need = VISIBLE_CARDS - cards.length;
      const take = queue.slice(0, need);
      setQueue((q) => q.slice(take.length));
      setCards((curr) => [
        ...curr,
        ...take.map<Card>((prompt) => ({ id: newCardId(), prompt, mode: "prompt" })),
      ]);
    }
  }, [cards.length, queue]);

  const requestSuggestions = useCallback(async () => {
    if (suggesting) return;
    if (matchEmpty) {
      setSuggestError("Set a match brief before asking for suggestions.");
      return;
    }
    setSuggesting(true);
    setSuggestError(null);
    try {
      const body = await apiPost<{ count: number }, { prompts: string[] }>(
        routes.broadcasts.studio.suggestPrompts(broadcastId),
        { count: SUGGESTION_BATCH },
      );
      const fresh = body.prompts.filter((p) => !seenPromptsRef.current.has(p));
      for (const p of fresh) seenPromptsRef.current.add(p);
      setQueue((q) => [...q, ...fresh]);
    } catch (err) {
      setSuggestError((err as Error).message);
    } finally {
      setSuggesting(false);
    }
  }, [broadcastId, matchEmpty, suggesting]);

  const updateCard = useCallback((id: string, patch: Partial<Card>) => {
    setCards((curr) => curr.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }, []);

  const removeCard = useCallback((id: string) => {
    setCards((curr) => curr.filter((c) => c.id !== id));
  }, []);

  const startEdit = useCallback((id: string) => {
    setCards((curr) =>
      curr.map((c) =>
        c.id === id ? { ...c, mode: "editing", editBuffer: c.prompt } : c,
      ),
    );
  }, []);

  const cancelEdit = useCallback((id: string) => {
    setCards((curr) =>
      curr.map((c) =>
        c.id === id ? { ...c, mode: "prompt", editBuffer: undefined } : c,
      ),
    );
  }, []);

  const setEditBuffer = useCallback((id: string, buf: string) => {
    setCards((curr) =>
      curr.map((c) => (c.id === id ? { ...c, editBuffer: buf } : c)),
    );
  }, []);

  const commitEdit = useCallback((id: string) => {
    setCards((curr) =>
      curr.map((c) => {
        if (c.id !== id) return c;
        const next = (c.editBuffer ?? c.prompt).trim();
        if (!next) return c;
        return { ...c, prompt: next, mode: "prompt", editBuffer: undefined };
      }),
    );
  }, []);

  const discardPromptCard = useCallback(
    async (id: string) => {
      const card = cards.find((c) => c.id === id);
      if (!card) return;
      removeCard(id);
      try {
        await apiPost(
          routes.broadcasts.studio.discardPrompt(broadcastId),
          { prompt: card.prompt },
        );
      } catch {
        // Discard is fire-and-forget for UX — local removal proceeds
        // regardless of the server response. A retry comes naturally
        // on the next session's suggestion request.
      }
    },
    [broadcastId, cards, removeCard],
  );

  const generateForCard = useCallback(
    async (id: string) => {
      const card = cards.find((c) => c.id === id);
      if (!card) return;
      updateCard(id, { mode: "generating", error: undefined });
      try {
        const illustration = await apiPost<{ prompt: string }, StudioGeneratedIllustration>(
          routes.broadcasts.studio.generateIllustration(broadcastId),
          { prompt: card.prompt },
        );
        updateCard(id, { mode: "preview", illustration });
      } catch (err) {
        updateCard(id, {
          mode: "prompt",
          error: (err as Error).message || "generation failed",
        });
      }
    },
    [broadcastId, cards, updateCard],
  );

  const regenerateForCard = useCallback(
    async (id: string) => {
      const card = cards.find((c) => c.id === id);
      if (!card?.illustration) return;
      updateCard(id, { mode: "generating", error: undefined });
      // Orphan the previous staging row rather than calling `discard`
      // on it — `discard` records the prompt in the rejected list,
      // which would muddy the next suggestion call. The old row +
      // R2 object stay around unused. Worst case in a pathological
      // regenerate loop: a handful of orphan rows per session,
      // negligible storage cost. A periodic cleanup job can sweep
      // them later if it becomes worth the code.
      try {
        const illustration = await apiPost<{ prompt: string }, StudioGeneratedIllustration>(
          routes.broadcasts.studio.generateIllustration(broadcastId),
          { prompt: card.prompt },
        );
        updateCard(id, { mode: "preview", illustration });
      } catch (err) {
        updateCard(id, {
          mode: "preview",
          error: (err as Error).message || "regenerate failed",
        });
      }
    },
    [broadcastId, cards, updateCard],
  );

  const acceptCard = useCallback(
    async (id: string) => {
      const card = cards.find((c) => c.id === id);
      if (!card?.illustration) return;
      updateCard(id, { mode: "busy", error: undefined });
      try {
        const poolItem = await apiPost<Record<string, never>, StudioPoolItem>(
          routes.broadcasts.studio.acceptIllustration(broadcastId, card.illustration.id),
          {},
        );
        setPool((prev) => [poolItem, ...prev]);
        removeCard(id);
      } catch (err) {
        updateCard(id, {
          mode: "preview",
          error: (err as Error).message || "accept failed",
        });
      }
    },
    [broadcastId, cards, removeCard, updateCard],
  );

  const discardPreviewCard = useCallback(
    async (id: string) => {
      const card = cards.find((c) => c.id === id);
      if (!card?.illustration) return;
      removeCard(id);
      apiPost(
        routes.broadcasts.studio.discardIllustration(broadcastId, card.illustration.id),
        {},
      ).catch(() => {});
    },
    [broadcastId, cards, removeCard],
  );

  const submitCustomPrompt = useCallback(() => {
    const text = customPrompt.trim();
    if (!text) return;
    setCustomPrompt("");
    seenPromptsRef.current.add(text);
    setCards((curr) => [
      { id: newCardId(), prompt: text, mode: "prompt" },
      ...curr,
    ]);
  }, [customPrompt]);

  const removePoolItem = useCallback(
    async (poolItemId: string) => {
      setPool((prev) => prev.filter((p) => p.poolItemId !== poolItemId));
      try {
        await apiDelete(routes.broadcasts.studio.poolItem(broadcastId, poolItemId));
      } catch {
        // If the delete fails, refetch — optimistic-remove corrects
        // itself on next load.
        loadPool();
      }
    },
    [broadcastId, loadPool],
  );

  const updatePoolItemTags = useCallback(
    async (poolItemId: string, tags: string[]): Promise<boolean> => {
      try {
        const updated = await apiPatch<{ tags: string[] }, StudioPoolItem>(
          routes.broadcasts.studio.poolItem(broadcastId, poolItemId),
          { tags },
        );
        setPool((prev) =>
          prev.map((p) => (p.poolItemId === poolItemId ? updated : p)),
        );
        return true;
      } catch {
        return false;
      }
    },
    [broadcastId],
  );

  const [viewer, setViewer] = useState<
    | { kind: "pool"; item: StudioPoolItem }
    | { kind: "preview"; prompt: string; imageUrl: string }
    | null
  >(null);

  if (loadError) {
    return (
      <main
        style={{
          minHeight: "100vh",
          background: C.ivory,
          color: C.umber,
          padding: 40,
          fontFamily: "inherit",
        }}
      >
        Broadcast not reachable: {loadError}
      </main>
    );
  }
  if (!broadcast) {
    return <main style={{ minHeight: "100vh", background: C.ivory }} />;
  }

  return (
    <main
      style={{
        maxWidth: 1440,
        margin: "0 auto",
        padding: "32px 32px 0",
        color: C.umber,
        background: C.ivory,
        // Hard-cap at viewport height so overflow falls to internal
        // scroll containers (pool, brief textarea) instead of pushing
        // the footer below the fold.
        height: "100vh",
        fontFamily: "inherit",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      <PageHeader
        back={{ href: `/moderator/${broadcast.id}`, label: "Moderator" }}
        title="Studio"
        broadcast={broadcast}
      >
        <StatusPill status={status} />
      </PageHeader>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 400px) minmax(0, 1fr)",
          gap: 32,
          marginTop: 24,
          marginBottom: 20,
          flex: 1,
          minHeight: 0,
        }}
      >
        <BriefsColumn
          status={status}
          editable={editable}
          matchBrief={matchBrief}
          onMatchBriefChange={(v) => {
            setMatchBrief(v);
            setBriefDirty(true);
          }}
          canSave={canSave}
          saving={saving}
          savedAt={savedAt}
          saveError={saveError}
          onSave={saveBrief}
          matchEmpty={matchEmpty}
          dirty={briefDirty}
        />

        <ImageryColumn
          pool={pool}
          poolError={poolError}
          onRemovePoolItem={removePoolItem}
          onOpenPoolItem={(item) => setViewer({ kind: "pool", item })}
          queueRemaining={queue.length}
          cards={cards}
          onDiscardPrompt={discardPromptCard}
          onStartEdit={startEdit}
          onCancelEdit={cancelEdit}
          onSetEditBuffer={setEditBuffer}
          onCommitEdit={commitEdit}
          onGenerate={generateForCard}
          onAccept={acceptCard}
          onRegenerate={regenerateForCard}
          onDiscardPreview={discardPreviewCard}
          onOpenCardViewer={(prompt, imageUrl) =>
            setViewer({ kind: "preview", prompt, imageUrl })
          }
          suggesting={suggesting}
          suggestError={suggestError}
          onRequestSuggestions={requestSuggestions}
          customPrompt={customPrompt}
          onCustomPromptChange={setCustomPrompt}
          onSubmitCustomPrompt={submitCustomPrompt}
          matchEmpty={matchEmpty}
        />
      </div>

      <AdminFooter left="Studio" />

      {viewer ? (
        <IllustrationDialog
          viewer={viewer}
          onClose={() => setViewer(null)}
          onUpdatePoolTags={updatePoolItemTags}
        />
      ) : null}

      <style>{`
        .idle-hidden-scroll { scrollbar-width: thin; scrollbar-color: transparent transparent; }
        .idle-hidden-scroll:hover, .idle-hidden-scroll:focus-within { scrollbar-color: ${C.driftwood}66 transparent; }
        .idle-hidden-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
        .idle-hidden-scroll::-webkit-scrollbar-track { background: transparent; }
        .idle-hidden-scroll::-webkit-scrollbar-thumb { background: transparent; border-radius: 4px; transition: background 180ms ease; }
        .idle-hidden-scroll:hover::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:focus-within::-webkit-scrollbar-thumb,
        .idle-hidden-scroll:active::-webkit-scrollbar-thumb { background: ${C.driftwood}66; }
        @keyframes studio-skel-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.55; }
        }
      `}</style>
    </main>
  );
}
