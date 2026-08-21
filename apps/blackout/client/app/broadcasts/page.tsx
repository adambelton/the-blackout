"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Broadcast } from "@blackout/shared";
import { useCurrentUser } from "../../lib/use-current-user";
import { NewBroadcastDialog } from "../components/NewBroadcastDialog";
import { brand as C } from "../lib/palette";
import { apiDelete, apiGet, apiPatch } from "@/lib/api";
import { routes } from "@/lib/routes";
import { Topbar } from "./components/Topbar";
import { SectionLabel } from "./components/SectionLabel";
import { BroadcastRow } from "./components/BroadcastRow";
import { EmptyState } from "./components/EmptyState";

export default function BroadcastsPage() {
  // Access control is enforced by proxy.ts (writer OR admin role required).
  // The hook here only supplies `isAdmin` to gate admin-specific UI
  // (Radio sources + New broadcast) within the page.
  const router = useRouter();
  const { user } = useCurrentUser();
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [newDialogOpen, setNewDialogOpen] = useState(false);

  const isAdmin = user?.isAdmin ?? false;

  const loadBroadcasts = () =>
    apiGet<Broadcast[]>(routes.broadcasts.list())
      .then((data) => setBroadcasts(data))
      .catch((err) => console.error("Failed to load broadcasts:", err));

  useEffect(() => {
    loadBroadcasts().finally(() => setLoading(false));
    // loadBroadcasts is a stable lexical closure; no dependency needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this broadcast? This cannot be undone.")) return;
    await apiDelete(routes.broadcasts.item(id));
    setBroadcasts((prev) => prev.filter((b) => b.id !== id));
  };

  const handleArchive = async (id: string) => {
    const updated = await apiPatch<{ status: string }, Broadcast>(routes.broadcasts.item(id), { status: "archived" });
    setBroadcasts((prev) => prev.map((b) => (b.id === id ? updated : b)));
  };

  const finishedStatuses: Broadcast["status"][] = ["complete", "archived"];
  const upcoming = broadcasts
    .filter((b) => !finishedStatuses.includes(b.status))
    .sort((a, b) => new Date(a.matchDate).getTime() - new Date(b.matchDate).getTime());

  const completed = broadcasts
    .filter((b) => finishedStatuses.includes(b.status))
    .sort((a, b) => new Date(b.matchDate).getTime() - new Date(a.matchDate).getTime());

  return (
    <main
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: "40px 32px 80px",
        color: C.umber,
      }}
    >
      <Topbar isAdmin={isAdmin} onNewBroadcast={() => setNewDialogOpen(true)} />

      <NewBroadcastDialog
        open={newDialogOpen}
        onClose={() => setNewDialogOpen(false)}
        onCreated={(id) => {
          setNewDialogOpen(false);
          // Route straight into the moderator console for the new broadcast —
          // that's where the rest of its setup (briefs, scheduling) happens.
          router.push(`/moderator/${id}`);
        }}
      />

      {loading ? (
        <p style={{ color: C.stone, fontSize: 13 }}>Loading…</p>
      ) : broadcasts.length === 0 ? (
        <EmptyState isAdmin={isAdmin} onCreate={() => setNewDialogOpen(true)} />
      ) : (
        <>
          {upcoming.length > 0 && (
            <>
              <SectionLabel>Upcoming</SectionLabel>
              {upcoming.map((b) => (
                <BroadcastRow
                  key={b.id}
                  broadcast={b}
                  isAdmin={isAdmin}
                  onDelete={handleDelete}
                  onArchive={handleArchive}
                />
              ))}
            </>
          )}
          {completed.length > 0 && (
            <>
              <SectionLabel>Completed</SectionLabel>
              {completed.map((b) => (
                <BroadcastRow
                  key={b.id}
                  broadcast={b}
                  dimmed
                  isAdmin={isAdmin}
                  onDelete={handleDelete}
                  onArchive={handleArchive}
                />
              ))}
            </>
          )}
        </>
      )}
    </main>
  );
}

