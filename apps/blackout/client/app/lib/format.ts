/**
 * Shared formatting helpers. Keep this file dependency-free — just
 * takes primitives in and returns strings out so any surface can use it.
 */

const DATE_OPTS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  day: "numeric",
  month: "short",
};
const TIME_OPTS: Intl.DateTimeFormatOptions = {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
};

/**
 * Split a broadcast's match date into `{ date, time }` parts so
 * callers can compose them with their own separator and styling
 * (uppercase on the landing card, two columns on the broadcasts
 * index, etc.). Returns empty strings on a bad input.
 */
export function formatMatchDateParts(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: "", time: "" };
  return {
    date: d.toLocaleDateString("en-GB", DATE_OPTS),
    time: d.toLocaleTimeString("en-GB", TIME_OPTS),
  };
}

/**
 * Render a broadcast's match date as "Fri 3 May 14:30" (en-GB, 24h).
 * Returns the empty string on a bad input rather than throwing —
 * calling surfaces can decide whether to show the subtitle without
 * date information.
 */
export function formatMatchDate(iso: string): string {
  const { date, time } = formatMatchDateParts(iso);
  if (!date && !time) return "";
  return `${date} ${time}`;
}
