/**
 * Shift and compare business dates.
 *
 * Business dates in this codebase are `YYYY-MM-DD` strings with no time and no
 * timezone (see `shared/dates/today.ts` for why the timezone matters at all).
 * Arithmetic on them is therefore done in UTC: constructing `new Date("2026-03-31T00:00:00Z")`
 * and stepping it cannot land on the previous day through a local offset, which
 * is the classic way a 31-day month turns into a 30-day one.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** `2026-01-31` + 30 → `2026-03-02`. Leap years and month lengths are the
 *  platform's problem, not a table of our own. */
export function addDays(date: string, days: number): string {
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/**
 * Whole days from `from` to `to` — negative when `to` is earlier.
 *
 * Used by AR aging, where the number decides which bucket a balance falls into.
 * Getting it wrong by one moves an invoice across a bucket boundary and changes
 * the totals a credit controller acts on, so it is worth its own tested function
 * rather than an inline subtraction somebody re-derives at each call site.
 */
export function daysBetween(from: string, to: string): number {
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((end - start) / DAY_MS);
}
