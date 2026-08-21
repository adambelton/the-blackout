import Link from "next/link";
import { brand as C } from "../lib/palette";

/**
 * The Blackout wordmark in its primary lockup. Per the brand guide:
 *   - "The" / "Blackout" stacked, DM Sans 300, -0.04em tracking
 *   - Domain tag beneath in DM Sans 500, 0.14em tracking, uppercase
 *   - Wordmark Umber on Ivory; domain tag Driftwood
 *
 * Two display sizes: `display` (52px Blackout) for landing-style
 * masthead, `compact` (32px Blackout) for sub-page headers where
 * the page title carries the headline weight.
 *
 * `as` controls whether the wordmark renders as a link to /. Default
 * yes — the only place to render the static form is the landing page
 * itself, where `as="div"` avoids a same-page self-link.
 */
interface WordmarkProps {
  size?: "display" | "compact";
  as?: "link" | "div";
}

export function Wordmark({ size = "display", as = "link" }: WordmarkProps) {
  const blackoutSize = size === "display" ? 52 : 32;
  const theSize = size === "display" ? 18 : 13;
  const tagSize = size === "display" ? 11 : 10;
  const tagSpacing = size === "display" ? 8 : 6;

  const inner = (
    <>
      <span
        style={{
          display: "block",
          fontSize: theSize,
          fontWeight: 300,
          color: C.driftwood,
          letterSpacing: "-0.04em",
          lineHeight: 1,
          marginBottom: 2,
        }}
      >
        The
      </span>
      <span
        style={{
          display: "block",
          fontSize: blackoutSize,
          fontWeight: 300,
          color: C.umber,
          letterSpacing: "-0.04em",
          lineHeight: 1,
        }}
      >
        Blackout
      </span>
      <span
        style={{
          display: "block",
          fontSize: tagSize,
          fontWeight: 500,
          color: C.driftwood,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          lineHeight: 1,
          marginTop: tagSpacing,
        }}
      >
        Live football fiction
      </span>
    </>
  );

  if (as === "div") {
    return <div>{inner}</div>;
  }
  return (
    <Link
      href="/"
      style={{
        display: "inline-block",
        textDecoration: "none",
      }}
    >
      {inner}
    </Link>
  );
}
