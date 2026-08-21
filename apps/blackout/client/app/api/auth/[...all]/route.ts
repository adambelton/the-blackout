import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "../../../../lib/auth";

// Catch-all Better Auth route — handles OAuth start + callback, session
// read, sign-out, and everything else Better Auth exposes. The `[...all]`
// path must match Better Auth's internal path expectations.
export const { POST, GET } = toNextJsHandler(auth);
