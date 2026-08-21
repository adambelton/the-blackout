"use client";

import { createAuthClient } from "better-auth/react";

// React-side Better Auth client. `useSession`, `signIn`, `signOut`
// come off the returned object. Talks to the server-side auth via
// the `/api/auth/[...all]` route handler in this same app.
export const authClient = createAuthClient();

export const { useSession, signIn, signOut } = authClient;
