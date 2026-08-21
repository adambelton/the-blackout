"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { UserRole } from "@blackout/shared";
import { brand as C } from "../../lib/palette";
import { apiGet, apiPatch } from "@/lib/api";
import { routes } from "@/lib/routes";
import { UserRow } from "./components/UserRow";
import type { UserSummary } from "./components/UserRow";

export default function UsersPage() {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await apiGet<UserSummary[]>(routes.admin.users.list()));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setRole = async (userId: string, role: UserRole | null) => {
    setSaving(userId);
    try {
      const updated = await apiPatch<{ role: UserRole | null }, UserSummary>(routes.admin.users.setRole(userId), { role });
      setUsers((prev) => prev.map((u) => (u.id === userId ? updated : u)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <main
      style={{
        maxWidth: 800,
        margin: "0 auto",
        padding: "40px 32px 80px",
        color: C.umber,
      }}
    >
      <div style={{ marginBottom: 32 }}>
        <Link
          href="/broadcasts"
          style={{
            fontSize: 13,
            color: C.stone,
            textDecoration: "none",
            transition: "color 160ms ease",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = C.umber; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = C.stone; }}
        >
          ← Broadcasts
        </Link>
        <h1
          style={{
            fontSize: 32,
            fontWeight: 300,
            letterSpacing: "-0.03em",
            margin: "6px 0 0",
            color: C.umber,
          }}
        >
          Users
        </h1>
      </div>

      {error && (
        <p style={{ color: C.crimson, fontSize: 13, marginBottom: 16 }}>{error}</p>
      )}

      {loading ? (
        <p style={{ color: C.stone, fontSize: 13 }}>Loading…</p>
      ) : users.length === 0 ? (
        <p style={{ color: C.stone, fontSize: 13 }}>No users yet.</p>
      ) : (
        <div>
          {users.map((u) => (
            <UserRow
              key={u.id}
              user={u}
              saving={saving === u.id}
              onSetRole={(role) => setRole(u.id, role)}
            />
          ))}
        </div>
      )}
    </main>
  );
}
