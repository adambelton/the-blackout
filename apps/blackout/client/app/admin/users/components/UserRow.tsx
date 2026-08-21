"use client";

import type { UserRole } from "@blackout/shared";
import { brand as C } from "../../../lib/palette";
import { RolePill } from "./RolePill";

const ROLES: { value: UserRole | null; label: string }[] = [
  { value: null, label: "Member" },
  { value: "writer", label: "Writer" },
  { value: "admin", label: "Admin" },
];

export interface UserSummary {
  id: string;
  name: string;
  email: string;
  role: UserRole | null;
  createdAt: string;
}

export function UserRow({
  user: u,
  saving,
  onSetRole,
}: {
  user: UserSummary;
  saving: boolean;
  onSetRole: (role: UserRole | null) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "14px 18px",
        border: `0.5px solid ${C.celadon}`,
        borderRadius: 10,
        marginBottom: 8,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 15,
            fontWeight: 300,
            letterSpacing: "-0.02em",
            color: C.umber,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {u.name}
        </div>
        <div style={{ fontSize: 12, color: C.driftwood, marginTop: 2 }}>
          {u.email}
        </div>
      </div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {saving && (
          <span style={{ fontSize: 11, color: C.stone }}>Saving…</span>
        )}
        {ROLES.map(({ value, label }) => (
          <RolePill
            key={label}
            label={label}
            active={u.role === value}
            onClick={() => onSetRole(value)}
            disabled={saving}
          />
        ))}
      </div>
    </div>
  );
}
