import type { ReactNode } from "react";
import Link from "next/link";
import { brand as C } from "../lib/palette";
import { Wordmark } from "./Wordmark";
import { LoginButton } from "./LoginButton";

/**
 * Shared chrome for every public-facing page (landing + about + values).
 * Header carries the Wordmark lockup
 * on the left and the gated LoginButton on the right (`show-login`
 * PostHog flag — invisible to most visitors). Footer holds the public
 * navigation on the left and the editorial mailto on the right.
 *
 * `wordmark` controls the masthead size. The landing page uses
 * `display` for the full lockup; sub-pages use `compact` so the
 * page title carries the headline weight without competing with the
 * wordmark.
 *
 * `wordmarkAs` lets the landing render the wordmark as plain text
 * (no link to the page you're already on); every other page links
 * back home.
 */
interface PublicLayoutProps {
  children: ReactNode;
  wordmark?: "display" | "compact";
  wordmarkAs?: "link" | "div";
}

const NAV_LINKS = [
  { href: "/about", label: "About" },
  { href: "/values", label: "Values" },
];

export function PublicLayout({
  children,
  wordmark = "compact",
  wordmarkAs = "link",
}: PublicLayoutProps) {
  return (
    <main
      style={{
        maxWidth: 640,
        margin: "0 auto",
        padding: "4rem 1.5rem",
        color: C.umber,
        lineHeight: 1.7,
        fontSize: "0.9375rem",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: "1.5rem",
          marginBottom: "2rem",
        }}
      >
        <Wordmark size={wordmark} as={wordmarkAs} />
        <div
          style={{
            display: "flex",
            gap: "1rem",
            fontSize: "0.85rem",
            fontWeight: 500,
            paddingTop: "0.25rem",
          }}
        >
          <LoginButton />
        </div>
      </header>

      {children}

      <footer
        style={{
          borderTop: `0.5px solid ${C.celadon}`,
          paddingTop: 10,
          marginTop: "2rem",
          fontSize: "0.85rem",
        }}
      >
        <nav
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: "1.25rem",
            alignItems: "center",
          }}
        >
          {NAV_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                color: C.umber,
                textDecoration: "none",
                fontWeight: 500,
              }}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </footer>
    </main>
  );
}
