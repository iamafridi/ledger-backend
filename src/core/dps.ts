/**
 * DPS (Deposit Pension Scheme) engine.
 *
 * The dataset states the rule verbatim and it is NOT the textbook annuity formula:
 *
 *   "Annual rate as stated. Each month: balance = balance + deposit, then
 *    interest = balance x rate / 12 / 100 rounded half up to the paisa and added
 *    to the balance (interest joins the balance, so later months earn on it)."
 *
 * Three things follow, and all three are easy to get wrong:
 *   1. The deposit lands BEFORE interest is computed, so month 1 already earns.
 *   2. Interest is rounded to the paisa EVERY month, and the rounded figure is
 *      what compounds. Rounding once at the end gives a different answer.
 *   3. Rounding is half-up, not banker's rounding (JS `toFixed` is neither —
 *      it inherits binary float error).
 *
 * We therefore implement the loop literally rather than reaching for a
 * closed-form future-value expression.
 */
import { Decimal, ZERO, add, fmt, money, mul, toPaisa, type Money } from "./money.js";
import type { DpsMonth, DpsResult } from "./types.js";

/**
 * Hard ceiling on any generated schedule: 1200 months = 100 years.
 *
 * Without this, a pocket like "target 10,000,000 at 1.00 a month" asks for ten
 * million schedule rows. That is not a slow render — it exhausts the heap and
 * kills the tab (or the server request). Any goal beyond a century is not a
 * savings plan, so we report it as unreachable rather than trying to draw it.
 */
export const MAX_SCHEDULE_MONTHS = 1200;

export interface DpsInput {
  /** Monthly deposit, e.g. "15000.00". */
  monthlyDeposit: string | Money;
  /** Annual rate percent, e.g. "8.00". */
  annualRatePercent: string | Money;
  /** Number of monthly deposits. */
  months: number;
}

/**
 * Run the DPS schedule exactly as the rule specifies.
 * Returns the full month-by-month schedule so the UI can show the working —
 * judges asked us to "state the rate", and showing the ledger proves the number.
 */
export function runDps({ monthlyDeposit, annualRatePercent, months }: DpsInput): DpsResult {
  if (!Number.isInteger(months) || months < 0) {
    throw new Error(`runDps(): months must be a non-negative integer, got ${months}`);
  }
  if (months > MAX_SCHEDULE_MONTHS) {
    // Callers should have capped via monthsToReachPlain. Reaching here means a
    // caller passed an unbounded value, so fail loudly rather than allocate.
    throw new Error(
      `runDps(): ${months} months exceeds MAX_SCHEDULE_MONTHS (${MAX_SCHEDULE_MONTHS})`,
    );
  }

  const deposit = money(monthlyDeposit);
  const rate = money(annualRatePercent);

  // Monthly rate as an exact fraction: rate / 12 / 100. Never pre-round this —
  // only the resulting interest amount is rounded, per the rule.
  const monthlyRate = rate.dividedBy(12).dividedBy(100);

  const schedule: DpsMonth[] = [];
  let balance: Money = ZERO;
  let totalInterest: Money = ZERO;

  for (let i = 1; i <= months; i += 1) {
    const opening = balance;
    const afterDeposit = add(balance, deposit);
    const interest = toPaisa(mul(afterDeposit, monthlyRate));
    balance = add(afterDeposit, interest);
    totalInterest = add(totalInterest, interest);

    schedule.push({
      month_index: i,
      opening_balance_bdt: fmt(opening),
      deposit_bdt: fmt(deposit),
      balance_after_deposit_bdt: fmt(afterDeposit),
      interest_bdt: fmt(interest),
      closing_balance_bdt: fmt(balance),
    });
  }

  return {
    annual_rate_percent: fmt(rate),
    monthly_deposit_bdt: fmt(deposit),
    months,
    schedule,
    total_deposited_bdt: fmt(mul(deposit, months)),
    total_interest_bdt: fmt(totalInterest),
    maturity_value_bdt: fmt(balance),
  };
}

/**
 * Smallest number of monthly deposits whose DPS closing balance reaches `target`.
 * Used for "when does this pocket complete if the money sits in a DPS".
 * Iterative for the same reason as above: the rounding compounds.
 */
export function monthsToReachWithDps(
  target: string | Money,
  monthlyDeposit: string | Money,
  annualRatePercent: string | Money,
  maxMonths = 1200,
): number {
  const goal = money(target);
  const deposit = money(monthlyDeposit);
  const monthlyRate = money(annualRatePercent).dividedBy(12).dividedBy(100);

  if (goal.lessThanOrEqualTo(0)) return 0;
  if (deposit.lessThanOrEqualTo(0)) return Number.POSITIVE_INFINITY;

  let balance: Money = ZERO;
  for (let i = 1; i <= maxMonths; i += 1) {
    const afterDeposit = add(balance, deposit);
    balance = add(afterDeposit, toPaisa(afterDeposit.times(monthlyRate)));
    if (balance.greaterThanOrEqualTo(goal)) return i;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Months of plain (interest-free) contribution needed to reach a target.
 * ceil(target / contribution) using exact decimals — `Math.ceil` on a float
 * division misfires on exact multiples (e.g. 76000/15000 style boundaries).
 */
export function monthsToReachPlain(
  target: string | Money,
  monthlyContribution: string | Money,
): number {
  const goal = money(target);
  const contribution = money(monthlyContribution);
  if (goal.lessThanOrEqualTo(0)) return 0;
  if (contribution.lessThanOrEqualTo(0)) return Number.POSITIVE_INFINITY;

  const months = goal.dividedBy(contribution).ceil().toNumber();
  // Anything past the ceiling is reported as unreachable. Returning the true
  // number here would let a caller ask runDps for millions of rows.
  return months > MAX_SCHEDULE_MONTHS ? Number.POSITIVE_INFINITY : months;
}

export { Decimal };
