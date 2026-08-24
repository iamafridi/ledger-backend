/**
 * Calendar helpers — deliberately timezone-free.
 *
 * `new Date("2026-04-17")` parses as UTC midnight but `getDate()` reads in the
 * viewer's local zone, so a user in UTC-6 sees the 16th. Every date in this
 * problem is a plain calendar date with no time component, so we parse the
 * string arithmetically and never construct a Date at all. This also makes the
 * engine give identical output on a laptop in Dhaka and a CI box in UTC.
 */

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

export function parseMonth(monthKey: string): YearMonth {
  const m = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!m) throw new Error(`parseMonth(): bad month key "${monthKey}"`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

export function parseDate(dateKey: string): YearMonth & { day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) throw new Error(`parseDate(): bad date key "${dateKey}"`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** "2026-04-17" -> "2026-04" */
export function monthOf(dateKey: string): string {
  return dateKey.slice(0, 7);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(monthKey: string): number {
  const { year, month } = parseMonth(monthKey);
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS[month - 1];
}

/** Add whole months to a month key. addMonths("2026-11", 3) -> "2027-02". */
export function addMonths(monthKey: string, count: number): string {
  const { year, month } = parseMonth(monthKey);
  const zero = year * 12 + (month - 1) + count;
  const y = Math.floor(zero / 12);
  const m = (zero % 12) + 1;
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}`;
}

/** Last calendar day of a month, as "YYYY-MM-DD". */
export function endOfMonth(monthKey: string): string {
  return `${monthKey}-${String(daysInMonth(monthKey)).padStart(2, "0")}`;
}

export function formatMonthLong(monthKey: string): string {
  const { year, month } = parseMonth(monthKey);
  const names = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  return `${names[month - 1]} ${year}`;
}
