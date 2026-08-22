/**
 * Insights — required item 3's "at least three insights that name specific
 * categories and amounts rather than giving general advice".
 *
 * DESIGN NOTE — why these are rules, not an LLM call.
 * The brief demands insights derived "from the actual numbers". A language model
 * asked to comment on a table will occasionally round, drop a digit, or invent a
 * category, and there is no way to grade that. So every sentence below is
 * generated from the computed figures, and each insight carries an `evidence`
 * object holding the exact values it quotes — the UI highlights from it and the
 * tests assert on it. The LLM is used where it genuinely helps (reading a
 * receipt photo, see lib/ocr) and kept away from arithmetic.
 *
 * Generators are pure and independently testable. Each returns null when it has
 * nothing worth saying, so an empty or single-category month degrades cleanly
 * instead of emitting "Your top category is undefined (NaN%)".
 */
import { display, money, pct, type Money } from "./money.js";
import { formatMonthLong } from "./calendar.js";
import type { Forecast, Insight, MonthComparison, PocketProjection } from "./types.js";

const BDT = "৳";
const amt = (m: Money | string) => `${BDT}${display(money(m))}`;

export interface InsightInput {
  comparison: MonthComparison;
  forecast: Forecast;
  pockets: PocketProjection[];
}

/** The headline: are we going to make it to month end? */
function shortfallInsight({ forecast }: InsightInput): Insight | null {
  const position = money(forecast.projected_end_position_bdt);
  const projected = money(forecast.projected_month_total_bdt);

  if (position.isNegative()) {
    return {
      id: "projected-shortfall",
      severity: "critical",
      text:
        `At your current pace of ${amt(forecast.daily_burn_bdt)}/day you are on track to spend ` +
        `${amt(projected)} this month against a salary of ${amt(forecast.salary_bdt)} — ` +
        `a shortfall of ${amt(position.abs())} by ${forecast.days_in_month === forecast.days_elapsed ? "today" : "month end"}. ` +
        `Cutting ${amt(position.abs().dividedBy(Math.max(forecast.days_remaining, 1)))}/day for the remaining ` +
        `${forecast.days_remaining} day${forecast.days_remaining === 1 ? "" : "s"} closes the gap.`,
      evidence: {
        amount_bdt: forecast.projected_end_position_bdt,
        comparison_bdt: forecast.salary_bdt,
      },
    };
  }

  return {
    id: "projected-surplus",
    severity: "info",
    text:
      `You are on track to spend ${amt(projected)} of your ${amt(forecast.salary_bdt)} salary this month, ` +
      `leaving ${amt(position)} at month end (${amt(forecast.daily_burn_bdt)}/day across ` +
      `${forecast.days_elapsed} day${forecast.days_elapsed === 1 ? "" : "s"} so far).`,
    evidence: {
      amount_bdt: forecast.projected_end_position_bdt,
      comparison_bdt: forecast.salary_bdt,
    },
  };
}

/** Which category dominates, and by how much. */
function topCategoryInsight({ comparison }: InsightInput): Insight | null {
  const top = comparison.this_month.by_category[0];
  if (!top) return null;
  return {
    id: "top-category",
    severity: money(top.share_percent).greaterThanOrEqualTo(40) ? "warning" : "info",
    text:
      `${top.category} is your largest category in ${formatMonthLong(comparison.this_month.month)} ` +
      `at ${amt(top.total_bdt)} across ${top.count} transaction${top.count === 1 ? "" : "s"} — ` +
      `${top.share_percent}% of everything you spent.`,
    evidence: {
      category: top.category,
      amount_bdt: top.total_bdt,
      percent: top.share_percent,
    },
  };
}

/** The category that grew most in absolute taka — usually the actionable one. */
function biggestRiseInsight({ comparison }: InsightInput): Insight | null {
  const rise = comparison.category_deltas.find((d) => money(d.delta_bdt).greaterThan(0));
  if (!rise) return null;
  const pctText = rise.delta_percent === null ? "new this month" : `up ${rise.delta_percent}%`;
  return {
    id: "biggest-rise",
    severity: "warning",
    text:
      `${rise.category} rose ${amt(rise.delta_bdt)} versus ${formatMonthLong(comparison.last_month.month)} ` +
      `(${amt(rise.last_bdt)} → ${amt(rise.this_bdt)}, ${pctText}) — the largest increase of any category.`,
    evidence: {
      category: rise.category,
      amount_bdt: rise.delta_bdt,
      percent: rise.delta_percent ?? undefined,
      comparison_bdt: rise.last_bdt,
    },
  };
}

/** Credit where due — the biggest genuine saving. */
function biggestFallInsight({ comparison }: InsightInput): Insight | null {
  const falls = comparison.category_deltas.filter((d) => money(d.delta_bdt).isNegative());
  const fall = falls[0];
  if (!fall) return null;
  return {
    id: "biggest-fall",
    severity: "info",
    text:
      `${fall.category} fell ${amt(money(fall.delta_bdt).abs())} versus ` +
      `${formatMonthLong(comparison.last_month.month)} (${amt(fall.last_bdt)} → ${amt(fall.this_bdt)}) — ` +
      `your biggest saving this month.`,
    evidence: {
      category: fall.category,
      amount_bdt: fall.delta_bdt,
      comparison_bdt: fall.last_bdt,
    },
  };
}

/** The single line item worth questioning. */
function largestExpenseInsight({ comparison }: InsightInput): Insight | null {
  const biggest = comparison.this_month.largest_expenses[0];
  if (!biggest) return null;
  const share = pct(money(biggest.amount_bdt), money(comparison.this_month.total_spent_bdt))
    .toDecimalPlaces(1)
    .toFixed(1);
  return {
    id: "largest-expense",
    severity: "info",
    text:
      `Your single largest expense was ${amt(biggest.amount_bdt)} at ${biggest.shop} ` +
      `(${biggest.category}, ${biggest.date}) — ${share}% of the month's total on its own.`,
    evidence: {
      category: biggest.category,
      amount_bdt: biggest.amount_bdt,
      percent: share,
    },
  };
}

/** Do the savings pockets actually survive contact with the forecast? */
function pocketPressureInsight({ forecast, pockets }: InsightInput): Insight | null {
  if (pockets.length === 0) return null;
  const afterPockets = money(forecast.projected_end_position_after_pockets_bdt);
  const contribution = money(forecast.total_pocket_contribution_bdt);
  const names = pockets.map((p) => p.pocket.name).join(", ");

  if (afterPockets.isNegative()) {
    return {
      id: "pocket-pressure",
      severity: "critical",
      text:
        `Funding ${names} takes ${amt(contribution)} a month. After your projected spending ` +
        `of ${amt(forecast.projected_month_total_bdt)} that leaves you ${amt(afterPockets.abs())} short — ` +
        `the contribution is not affordable at this month's pace.`,
      evidence: {
        amount_bdt: forecast.projected_end_position_after_pockets_bdt,
        comparison_bdt: forecast.total_pocket_contribution_bdt,
      },
    };
  }

  return {
    id: "pocket-headroom",
    severity: "info",
    text:
      `After projected spending and ${amt(contribution)} into ${names}, you still end the month ` +
      `${amt(afterPockets)} ahead.`,
    evidence: {
      amount_bdt: forecast.projected_end_position_after_pockets_bdt,
      comparison_bdt: forecast.total_pocket_contribution_bdt,
    },
  };
}

const GENERATORS = [
  shortfallInsight,
  pocketPressureInsight,
  biggestRiseInsight,
  topCategoryInsight,
  largestExpenseInsight,
  biggestFallInsight,
];

const RANK = { critical: 0, warning: 1, info: 2 } as const;

/**
 * Build the insight list. Ordered by severity, then by the order the generators
 * are declared above (which is roughly "most actionable first"). The brief asks
 * for at least three; we emit every generator that had something concrete to say.
 */
export function buildInsights(input: InsightInput): Insight[] {
  return GENERATORS.map((g) => g(input))
    .filter((i): i is Insight => i !== null)
    .map((insight, index) => ({ insight, index }))
    .sort((a, b) =>
      RANK[a.insight.severity] !== RANK[b.insight.severity]
        ? RANK[a.insight.severity] - RANK[b.insight.severity]
        : a.index - b.index,
    )
    .map(({ insight }) => insight);
}
