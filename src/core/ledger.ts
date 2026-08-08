/**
 * Ledger aggregation — required item 2 (the monthly dashboard).
 *
 * Pure functions over the case data: no IO, no framework, no clock. The
 * verification harness calls exactly these, which is what makes differential
 * testing against an independent implementation meaningful.
 */
import { ZERO, add, fmt, money, pct, sum, type Money } from "./money.js";
import { monthOf } from "./calendar.js";
import type {
  CategoryLine,
  Expense,
  MonthComparison,
  MonthSummary,
} from "./types.js";

/** Expenses belonging to a given "YYYY-MM". */
export function expensesInMonth(expenses: Expense[], monthKey: string): Expense[] {
  return expenses.filter((e) => monthOf(e.date) === monthKey);
}

export function totalOf(expenses: Expense[]): Money {
  return sum(expenses.map((e) => money(e.amount_bdt)));
}

/**
 * Category breakdown, largest first. Ties break alphabetically so the output is
 * stable across runs — an unstable sort would make snapshot tests flap.
 */
export function byCategory(expenses: Expense[]): CategoryLine[] {
  const totals = new Map<string, { total: Money; count: number }>();
  for (const e of expenses) {
    const current = totals.get(e.category) ?? { total: ZERO, count: 0 };
    totals.set(e.category, {
      total: add(current.total, money(e.amount_bdt)),
      count: current.count + 1,
    });
  }

  const grand = totalOf(expenses);
  return [...totals.entries()]
    .map(([category, { total, count }]) => ({
      category,
      total_bdt: fmt(total),
      share_percent: pct(total, grand).toDecimalPlaces(1).toFixed(1),
      count,
      _sort: total,
    }))
    .sort((a, b) =>
      b._sort.comparedTo(a._sort) !== 0
        ? b._sort.comparedTo(a._sort)
        : a.category.localeCompare(b.category),
    )
    .map(({ _sort, ...line }) => line);
}

/** Largest individual expenses, biggest first; ties break by id for stability. */
export function largestExpenses(expenses: Expense[], limit = 5): Expense[] {
  return [...expenses]
    .sort((a, b) => {
      const cmp = money(b.amount_bdt).comparedTo(money(a.amount_bdt));
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    })
    .slice(0, limit);
}

export function summariseMonth(expenses: Expense[], monthKey: string): MonthSummary {
  const rows = expensesInMonth(expenses, monthKey);
  return {
    month: monthKey,
    total_spent_bdt: fmt(totalOf(rows)),
    expense_count: rows.length,
    by_category: byCategory(rows),
    largest_expenses: largestExpenses(rows),
  };
}

/** Percent change from `last` to `current`; null when there is no base to compare. */
function deltaPercent(current: Money, last: Money): string | null {
  if (last.isZero()) return null;
  return current.minus(last).dividedBy(last).times(100).toDecimalPlaces(1).toFixed(1);
}

/**
 * This month vs last month — required item 2's "change compared to last month".
 * Category movement covers categories present in EITHER month, so a category
 * that vanished this month still shows as a fall rather than disappearing.
 */
export function compareMonths(
  expenses: Expense[],
  thisMonth: string,
  lastMonth: string,
): MonthComparison {
  const thisSummary = summariseMonth(expenses, thisMonth);
  const lastSummary = summariseMonth(expenses, lastMonth);

  const thisTotal = money(thisSummary.total_spent_bdt);
  const lastTotal = money(lastSummary.total_spent_bdt);

  const thisByCat = new Map(thisSummary.by_category.map((c) => [c.category, money(c.total_bdt)]));
  const lastByCat = new Map(lastSummary.by_category.map((c) => [c.category, money(c.total_bdt)]));

  const categories = [...new Set([...thisByCat.keys(), ...lastByCat.keys()])];

  const category_deltas = categories
    .map((category) => {
      const t = thisByCat.get(category) ?? ZERO;
      const l = lastByCat.get(category) ?? ZERO;
      return {
        category,
        this_bdt: fmt(t),
        last_bdt: fmt(l),
        delta_bdt: fmt(t.minus(l)),
        delta_percent: deltaPercent(t, l),
        _abs: t.minus(l).abs(),
      };
    })
    .sort((a, b) =>
      b._abs.comparedTo(a._abs) !== 0
        ? b._abs.comparedTo(a._abs)
        : a.category.localeCompare(b.category),
    )
    .map(({ _abs, ...row }) => row);

  return {
    this_month: thisSummary,
    last_month: lastSummary,
    delta_bdt: fmt(thisTotal.minus(lastTotal)),
    delta_percent: deltaPercent(thisTotal, lastTotal),
    category_deltas,
  };
}
