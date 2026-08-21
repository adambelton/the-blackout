import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import SignOutButton from "./components/sign-out-button";

/**
 * Placeholder authenticated landing — K6.3b's bootstrap milestone.
 * Confirms the OAuth → org-gate → session-cookie loop works
 * end-to-end. Real content (profiles list → service tree → spec
 * viewer) follows in the next chunk.
 */
export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });

  // Proxy gate catches the missing-cookie case; this guards the
  // edge where a cookie exists but the validation rejects (stale,
  // forged, user deleted). Belt + braces.
  if (!session) {
    redirect("/login");
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Kairos admin</h1>
        <SignOutButton />
      </header>

      <section className="card border border-base-300 bg-base-100">
        <div className="card-body gap-2 p-6">
          <p className="text-sm">
            Signed in as <strong>{session.user.name}</strong> ({session.user.email}).
          </p>
          <p className="text-sm opacity-70">
            Profile / service / spec management lands in the next chunk. This
            page just confirms the auth loop works end-to-end.
          </p>
        </div>
      </section>
    </main>
  );
}
