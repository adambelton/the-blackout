"use client";

import Link from "next/link";
import { brand } from "../lib/palette";

/**
 * Small "← Somewhere" nav link used in the header of every admin /
 * writer surface. Pulled out so studio, moderator, and inspector
 * share the same type size, colour, and hover transition.
 */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      style={{
        fontSize: 13,
        color: brand.stone,
        textDecoration: "none",
        transition: "color 160ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = brand.umber;
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = brand.stone;
      }}
    >
      ← {label}
    </Link>
  );
}
