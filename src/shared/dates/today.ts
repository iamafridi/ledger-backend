/**
 * "Today", in the user's actual timezone.
 *
 * The ledger is a Bangladeshi household ledger and the server runs in whatever
 * region the host picked — Render's default is Oregon. `new Date()` on that box
 * is already the previous day for six hours of every Dhaka evening, which would
 * silently file an 11pm receipt under yesterday and, once a month, under the
 * wrong month entirely.
 *
 * Intl with an explicit timeZone and the en-CA locale yields "YYYY-MM-DD"
 * directly, with no string surgery on a Date object.
 */
const LEDGER_TIMEZONE = "Asia/Dhaka";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: LEDGER_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today as "YYYY-MM-DD" in the ledger's timezone. */
export function todayInLedgerZone(): string {
  return formatter.format(new Date());
}

/** The current month as "YYYY-MM" in the ledger's timezone. */
export function currentMonth(): string {
  return todayInLedgerZone().slice(0, 7);
}
