/**
 * Domain types + the sample case schema.
 *
 * Money crosses this boundary as a canonical 2dp STRING, exactly as the dataset
 * expresses it. Decimals live inside the engine; strings live at the edges.
 * That keeps the engine exact and the JSON round-trippable.
 */
import { z } from "zod";

/** "1234.56" — the dataset's money form. Rejects floats-as-numbers on purpose. */
export const MoneyString = z
  .string()
  .regex(/^-?\d+(\.\d{1,2})?$/, "money must be a decimal string with <=2 dp");

/** "2026-04" */
export const MonthKey = z.string().regex(/^\d{4}-\d{2}$/, "month must be YYYY-MM");

/** "2026-04-17" */
export const DateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

export const ExpenseSchema = z.object({
  id: z.string(),
  date: DateKey,
  category: z.string(),
  shop: z.string(),
  amount_bdt: MoneyString,
});

export const PocketSchema = z.object({
  id: z.string(),
  name: z.string(),
  item: z.string(),
  target_bdt: MoneyString,
  monthly_contribution_bdt: MoneyString,
});

export const CaseSchema = z.object({
  case_id: z.string(),
  today: DateKey,
  months: z.object({ last: MonthKey, this: MonthKey }),
  salary_bdt: MoneyString,
  expenses: z.array(ExpenseSchema),
  pockets: z.array(PocketSchema),
  dps_annual_rate_percent: MoneyString,
  dps_rule: z.string(),
});

export const DatasetSchema = z.object({
  schema_version: z.string(),
  problem_id: z.string(),
  format_note: z.string(),
  cases: z.array(CaseSchema),
});

export type Expense = z.infer<typeof ExpenseSchema>;
export type Pocket = z.infer<typeof PocketSchema>;
export type LedgerCase = z.infer<typeof CaseSchema>;
export type Dataset = z.infer<typeof DatasetSchema>;

// ---------------------------------------------------------------- engine output
// Every money field below is a canonical 2dp string.

export interface CategoryLine {
  category: string;
  total_bdt: string;
  /** Share of this month's spending, 1dp, e.g. "24.3" */
  share_percent: string;
  count: number;
}

export interface MonthSummary {
  month: MonthKeyT;
  total_spent_bdt: string;
  expense_count: number;
  by_category: CategoryLine[];
  largest_expenses: Expense[];
}

export type MonthKeyT = string;

export interface MonthComparison {
  this_month: MonthSummary;
  last_month: MonthSummary;
  /** this - last. Negative means spending fell. */
  delta_bdt: string;
  /** Percent change vs last month, 1dp. null when last month was zero. */
  delta_percent: string | null;
  /** Per-category movement, sorted by absolute delta descending. */
  category_deltas: Array<{
    category: string;
    this_bdt: string;
    last_bdt: string;
    delta_bdt: string;
    delta_percent: string | null;
  }>;
}

export interface Forecast {
  today: string;
  days_elapsed: number;
  days_in_month: number;
  days_remaining: number;
  spent_to_date_bdt: string;
  /** spent_to_date / days_elapsed */
  daily_burn_bdt: string;
  /** daily_burn * days_remaining */
  projected_remaining_bdt: string;
  /** spent_to_date + projected_remaining */
  projected_month_total_bdt: string;
  salary_bdt: string;
  /** salary - projected_month_total. Negative = projected shortfall. */
  projected_end_position_bdt: string;
  /** True when projected_end_position is negative. */
  projected_short: boolean;
  /** Position after also funding every pocket contribution this month. */
  projected_end_position_after_pockets_bdt: string;
  total_pocket_contribution_bdt: string;
}

export interface Insight {
  id: string;
  /** Ordering weight; higher surfaces first. */
  severity: "critical" | "warning" | "info";
  text: string;
  /** Machine-readable backing so the UI can link/highlight and tests can assert. */
  evidence: {
    category?: string;
    amount_bdt?: string;
    percent?: string;
    comparison_bdt?: string;
  };
}

export interface DpsMonth {
  month_index: number;
  opening_balance_bdt: string;
  deposit_bdt: string;
  balance_after_deposit_bdt: string;
  interest_bdt: string;
  closing_balance_bdt: string;
}

export interface DpsResult {
  annual_rate_percent: string;
  monthly_deposit_bdt: string;
  months: number;
  schedule: DpsMonth[];
  total_deposited_bdt: string;
  total_interest_bdt: string;
  maturity_value_bdt: string;
}

export interface PocketProjection {
  pocket: Pocket;
  /**
   * Months of contribution needed to reach target, ignoring interest.
   * `null` means unreachable — no contribution, or beyond the 100-year ceiling.
   *
   * Deliberately null and not Infinity: `JSON.stringify(Infinity)` is `null`
   * anyway, so an Infinity here would silently become null on its way through
   * the API and into MongoDB. Making that explicit keeps the wire type honest.
   */
  months_to_target: number | null;
  /** Last day of the month in which the target is reached, "YYYY-MM-DD". */
  expected_completion_date: string;
  expected_completion_month: string;
  /** Plain saving (no interest) at completion — equals months * contribution. */
  plain_total_bdt: string;
  /** Same contributions run through the stated DPS rule over the same months. */
  dps: DpsResult;
  /** dps.maturity_value - plain_total. What the DPS earns you over that time. */
  dps_gain_bdt: string;
  /** Months to target if the DPS interest counts toward the goal. Null = unreachable. */
  months_to_target_with_dps: number | null;
  /** True when the forecast leaves enough room to fund this contribution. */
  affordable_this_month: boolean;

  // --- forecast-based completion (the brief asks for a date "based on the
  // forecast", so the stated contribution alone is not enough) ---
  /** What the forecast says is actually spare each month, after projected
   *  spending and after every other pocket's contribution. Never negative. */
  affordable_monthly_bdt: string;
  /** Months to target funded at `affordable_monthly_bdt` rather than at the
   *  stated contribution. Null when the forecast leaves nothing spare. */
  forecast_months_to_target: number | null;
  /** Completion date implied by the forecast. "—" when unreachable. */
  forecast_completion_date: string;
  /** True when the forecast supports the stated contribution in full, so the
   *  two dates agree. False means the plan is ahead of the money. */
  on_track: boolean;
}

export interface LedgerReport {
  case_id: string;
  comparison: MonthComparison;
  forecast: Forecast;
  insights: Insight[];
  pockets: PocketProjection[];
}
