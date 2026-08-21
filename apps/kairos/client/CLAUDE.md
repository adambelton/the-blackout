# Kairos admin client — working notes for AI-assisted dev

Next.js 16 App Router admin app for editing Kairos content (event profiles, service specs). Issues Better Auth sessions via email/password sign-in (sign-up is closed; admin users are seeded via `scripts/create-user.ts`); `apps/kairos/server` validates them on admin routes. The CMS layer that `apps/kairos/server` exposes for spec promotion / archival / editing.

**Read [`README.md`](README.md) first** for what's shipped today (K6.3b bootstrap), the auth contract, and the deferred content-page work. This file carries only the rules that bite when you edit `apps/kairos/client/**`; it does not restate the architecture.

## Working rules

- **Same `BETTER_AUTH_SECRET` as `apps/kairos/server`.** Drift = silent 401s. Both ignored local `.env` files are generated together; don't regenerate one without the other.
- **Tailwind + daisyui (default theme, utilitarian).** Component classes (`btn`, `input`, `card`, etc.) instead of hand-rolled utility chains; daisyui's `light --default, dark --prefersdark` themes carry the look. No brand palette, no custom colours. The admin app is built for engine-staff to read tables and edit forms — not for delight. If a design decision feels like "let me make this pretty," pause.
- **Server Components by default; `"use client"` only where interactivity is required.** Pages that fetch + render are server components; the sign-in button + sign-out button + any form with state get `"use client"`.
- **Spec body forms = editable `<textarea>` with `font-mono`, not rendered HTML, not `<pre>`.** The content goes to the LLM as text; rendering it as HTML misrepresents what it is. View vs edit toggle is `readOnly` on the same `<textarea>`, not a different element.
- **Auth gate lives in `proxy.ts`** (Next 16's renamed `middleware.ts`). Cookie-presence only — full session validation happens in server components via `auth.api.getSession({ headers: await headers() })`. Belt + braces: the page also checks and redirects.
- **No spec content lives in this app.** It calls `apps/kairos/server`'s admin routes for everything content-shaped. The only DB access here is auth tables (Better Auth's adapter).

## Migration discipline

`apps/kairos/client` doesn't own a database — Better Auth uses Kairos's Postgres (auth tables migrated by `apps/kairos/server`'s drizzle setup). Schema work happens in `apps/kairos/server`; see the [`migrations` skill](../../../.claude/skills/migrations/SKILL.md).

## Scope

K6.3b ships scaffold + auth loop only. K6.3b's follow-up = read-only content pages (profiles → service tree → spec viewer). K6.4 = editing + promote/archive/clone + save-and-run-eval. See [root CLAUDE.md § Scope](../../../CLAUDE.md) and [`docs/prompts-as-content-design.md`](../../../docs/prompts-as-content-design.md) § *Kairos client — the CMS* for the phased plan.
