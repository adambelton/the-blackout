"use client";

import { createAuthClient } from "better-auth/react";

// Generic OAuth providers are registered as standard social providers
// by Better Auth 1.7+, so the client no longer needs a matching plugin.
export const authClient = createAuthClient();

export const { useSession, signIn, signOut } = authClient;
