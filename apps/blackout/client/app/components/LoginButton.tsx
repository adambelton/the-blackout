"use client";

import Link from "next/link";
import { useFeatureFlagEnabled } from "posthog-js/react";
import { signOut, useSession } from "@/lib/auth-client";
import { brand as C } from "../lib/palette";

export function LoginButton() {
  const showLogin = useFeatureFlagEnabled("show-login");
  const { data: session, isPending } = useSession();

  if (!showLogin || isPending) return null;

  if (!session?.user) {
    return (
      <Link href="/login" style={{ color: C.umber }}>
        Sign in
      </Link>
    );
  }

  const role = (session.user as { role?: string | null }).role;
  const handleLogout = async () => {
    await signOut();
  };

  if (role === "admin") {
    return (
      <>
        <Link href="/broadcasts" style={{ color: C.umber }}>
          Broadcasts
        </Link>
        <Link href="/replays" style={{ color: C.umber }}>
          Replays
        </Link>
        <a onClick={handleLogout} style={{ color: C.umber, cursor: "pointer" }}>
          Sign out
        </a>
      </>
    );
  }

  // Logged in, not admin — replays + sign-out.
  return (
    <>
      <Link href="/replays" style={{ color: C.umber }}>
        Replays
      </Link>
      <a onClick={handleLogout} style={{ color: C.umber, cursor: "pointer" }}>
        Sign out
      </a>
    </>
  );
}
