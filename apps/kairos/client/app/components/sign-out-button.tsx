"use client";

import { signOut } from "@/lib/auth-client";

export default function SignOutButton() {
  return (
    <button
      type="button"
      onClick={() =>
        signOut({
          fetchOptions: {
            onSuccess: () => {
              window.location.href = "/login";
            },
          },
        })
      }
      className="btn btn-sm btn-ghost"
    >
      Sign out
    </button>
  );
}
