/**
 * Straight-line depreciation — the arithmetic, with no database and no clock.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 * The schedule an accountant checks on a screen (preview) and the schedule that
 * actually posts must be the *same function*, or the preview is a second
 * implementation that agrees with the first only until somebody edits one. So the
 * whole of the maths lives here: `depreciation.service.ts` calls it to draw up a
 * preview, calls the same function to post, and `assets.service.ts` calls it to
 * project an asset's remaining life.
 *
 * THE FOUR RULES
 *
 *  1. **The base is cost − salvage.** An asset is never depreciated below what it
 *     is expected to be worth at the end of its life, so the last charge is the
 *     remainder rather than a fixed monthly figure overshooting it.
 *
 *  2. **A month is a month, and the first one is short.** The charge for a period
 *     is `monthly × days charged ÷ days in the month`, where the days charged run
 *     from the asset's purchase date to the end of the period (or to a disposal
 *     date, see below). An asset bought on the 16th of a 30-day month therefore
 *     takes half a month's charge — because it was only in service for half of
 *     it. Buying on the 1st is the full month, with no special case: 30/30 is 1.
 *
 *  3. **The remainder lands on the last month, exactly.** Rounding happens once,
 *     to the paisa, per charge — and every charge is *capped at what is left*.
 *     So the sum of the charges equals the base to the paisa, with no residue
 *     stranded on the balance sheet and no final adjustment to remember.
 *
 *  4. **Nothing is charged for a period before the asset existed.** Eligibility
 *     is the purchase month onwards, stated once in `chargeDays`.
 *
 * All amounts are `Money` (Decimal), never a number, for the reason the whole
 * codebase gives: a fraction of a paisa of drift per month is a depreciation
 * schedule that does not add up by the end of the asset's life.
 */
import { addMonths, daysInMonth, endOfMonth, monthOf, parseDate, parseMonth } from "./calendar.js";
import { fmt, money, toPaisa, ZERO, type Money } from "./money.js";

/** What a depreciation schedule needs to know about an asset. */
export interface DepreciationTerms {
  /** What it cost, landed. */
  cost: Money;
  /** What it is expected to be worth when it is done — never depreciated. */
  salvage: Money;
  /** How many months it is written down over. At least one. */
  usefulLifeMonths: number;
}

/** The amount that will ever be charged: cost less salvage. Never negative — a
 *  salvage value above cost means there is nothing to depreciate, and the
 *  register refuses to create such an asset rather than treating it as zero. */
export function depreciableBase(terms: DepreciationTerms): Money {
  return money(terms.cost).minus(money(terms.salvage));
}

/** One full month's charge, rounded once to the paisa. */
export function monthlyCharge(terms: DepreciationTerms): Money {
  const base = depreciableBase(terms);
  if (!base.greaterThan(ZERO)) return ZERO;
  if (!(terms.usefulLifeMonths >= 1)) return ZERO;
  return toPaisa(base.dividedBy(terms.usefulLifeMonths));
}

/**
 * How many days of a period the asset was in service for.
 *
 * `throughDay` is the day the charge stops — normally the end of the month, or
 * the day of a disposal in `disposeChargeForPeriod`. A purchase in an earlier
 * month starts at day 1; a purchase in *this* month starts on the purchase date.
 * The result can be zero (a purchase dated after the day the charge stops), and
 * that is a legitimate answer rather than an error: nothing was in service.
 */
export function chargeDays(periodKey: string, purchaseDate: string, throughDay?: number): number {
  const lastDay = daysInMonth(periodKey);
  const stop = Math.min(throughDay ?? lastDay, lastDay);
  const start = monthOf(purchaseDate) === periodKey ? parseDate(purchaseDate).day : 1;
  return Math.max(0, stop - start + 1);
}

export interface PeriodCharge {
  /** The amount to post, already rounded and already capped at the remainder. */
  amount: Money;
  daysCharged: number;
  daysInMonth: number;
  /** True when the period is short of a full month's charge — the first month,
   *  or a month cut off by a disposal. A screen shows this rather than making the
   *  reader work out why the figure is not the monthly one. */
  prorated: boolean;
  /** True when the charge was the last of the asset's life (the remainder). */
  final: boolean;
}

/**
 * The charge for one period, given what has already been written off.
 *
 * `accumBefore` is what runs already posted say the asset has accumulated —
 * passed in rather than stored here, so this stays a pure function and the
 * service cannot accidentally ask two different sources the same question.
 */
export function chargeForPeriod(
  terms: DepreciationTerms,
  accumBefore: Money,
  periodKey: string,
  purchaseDate: string,
  throughDay?: number,
): PeriodCharge {
  const lastDay = daysInMonth(periodKey);
  const days = chargeDays(periodKey, purchaseDate, throughDay);
  const base = depreciableBase(terms);
  const remaining = base.minus(money(accumBefore));

  const shape = {
    daysCharged: days,
    daysInMonth: lastDay,
    prorated: days < lastDay,
  };

  // Out of service for the whole period, already written down to salvage, or a
  // base that never existed: nothing to charge, and saying so is the answer.
  if (days <= 0 || !base.greaterThan(ZERO) || !remaining.greaterThan(ZERO)) {
    return { ...shape, amount: ZERO, final: false };
  }

  // A charge can round *down* to nothing — a ten-taka base over sixty months is
  // 0.0017 a month — and a schedule that charges zero for ever leaves the base on
  // the balance sheet permanently. One paisa a month is silly but it is finite,
  // and the cap below finishes the asset off early instead of never.
  const exact = toPaisa(monthlyCharge(terms).times(days).dividedBy(lastDay));
  const full = exact.isZero() ? money("0.01") : exact;

  // Rule 3: the cap is what makes the schedule sum to the base exactly. The last
  // charge is whatever is left, which is why `final` is worth reporting.
  const capped = full.greaterThan(remaining) ? remaining : full;

  return { ...shape, amount: capped, final: capped.greaterThanOrEqualTo(remaining) };
}

/**
 * The month an amount for `periodKey` is dated in: the last day of the period.
 *
 * Posting on the last day of the month is what a monthly close means, and it
 * keeps the entry inside the period it belongs to whatever day of the month the
 * run is actually made on.
 */
export function postingDateForPeriod(periodKey: string): string {
  return endOfMonth(periodKey);
}

/** The month after `periodKey`, as "YYYY-MM". */
export function nextPeriod(periodKey: string): string {
  return addMonths(periodKey, 1);
}

/** A month key, or null when the string is not one. Used to validate input
 *  without letting a bad key reach `parseMonth`'s throw. */
export function isPeriodKey(value: string): boolean {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(value)) return false;
  try {
    parseMonth(value);
    return true;
  } catch {
    return false;
  }
}

/** The last day of a period the charge can stop on, for a disposal: the day the
 *  asset left. Beyond the month's length it is clipped by `chargeDays`. */
export function disposalThroughDay(periodKey: string, disposalDate: string): number {
  if (monthOf(disposalDate) !== periodKey) return daysInMonth(periodKey);
  return parseDate(disposalDate).day;
}

export interface ScheduleRow {
  period_key: string;
  date: string;
  amount_bdt: string;
  accum_after_bdt: string;
  nbv_after_bdt: string;
  days_charged: number;
  days_in_month: number;
  prorated: boolean;
  final: boolean;
}

/**
 * Project the rest of an asset's life from where it stands now.
 *
 * Starting point rather than replaying history: `fromPeriod` is the first month
 * not yet written off, and `accum` is what the register says has been written off
 * so far. A schedule drawn from the beginning would have to know which months
 * were skipped, and it is the *remaining* life a reader is asking about — how
 * much is left, and over how long.
 *
 * `maxRows` bounds the walk: a mistyped useful life of 9,999 months would
 * otherwise render a nine-thousand-row table nobody asked for. When the cap bites
 * the schedule says so (the caller compares the row count to it).
 */
export function projectSchedule(
  terms: DepreciationTerms,
  accum: Money,
  purchaseDate: string,
  fromPeriod: string,
  maxRows = 600,
): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let running = money(accum);
  let period = fromPeriod;
  const purchaseMonth = monthOf(purchaseDate);
  if (period < purchaseMonth) period = purchaseMonth;

  for (let index = 0; index < maxRows; index += 1) {
    const charge = chargeForPeriod(terms, running, period, purchaseDate);
    if (charge.amount.isZero()) {
      // Either the asset was not in service that month (before the purchase) or
      // it is fully written down — and in both cases so is every month after it,
      // so the walk stops rather than padding the table with zeroes.
      break;
    }
    running = running.plus(charge.amount);
    rows.push({
      period_key: period,
      date: postingDateForPeriod(period),
      amount_bdt: fmt(charge.amount),
      accum_after_bdt: fmt(running),
      nbv_after_bdt: fmt(money(terms.cost).minus(running)),
      days_charged: charge.daysCharged,
      days_in_month: charge.daysInMonth,
      prorated: charge.prorated,
      final: charge.final,
    });
    if (charge.final) break;
    period = nextPeriod(period);
  }

  return rows;
}
