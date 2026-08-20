/**
 * The keystone. Assembles the signed-in user's stored records into the exact
 * `LedgerCase` shape the sample dataset uses, then runs the one engine entry point
 * over it.
 *
 * WHY THIS SHAPE MATTERS
 * `buildReport` is also what the verification harness runs against all 25 public
 * cases, and against an independent Python implementation of the same spec. By
 * making the live application feed that identical function, the figures a user
 * sees on the dashboard are produced by code that is proven correct against the
 * published dataset — not by a second, unverified implementation that happens to
 * live in the API layer. There is exactly one place in this system where money
 * is computed.
 *
 * Required items 2, 3 and 4 are all served from this one call.
 */
import { addMonths, daysInMonth } from "../../core/calendar.js";
import { buildReport } from "../../core/report.js";
import type { LedgerCase, LedgerReport } from "../../core/types.js";
import { listExpensesForMonths } from "../expenses/expense.service.js";
import { effectiveSalary } from "../salary/salary.service.js";
import { listPockets } from "../pockets/pocket.service.js";
import { getSettings } from "../settings/settings.service.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";

/**
 * The rule the DPS figures are computed under, quoted verbatim from the dataset spec
 * dataset. It travels with the report so the UI can show the user exactly what
 * the projection assumes rather than asking them to trust a number.
 */
export const DPS_RULE =
  "Annual rate as stated. Each month: balance = balance + deposit, then " +
  "interest = balance x rate / 12 / 100 rounded half up to the paisa and added " +
  "to the balance (interest joins the balance, so later months earn on it).";

/**
 * The reference date for a month's forecast.
 *
 * For the current month that is genuinely today. For a month already finished,
 * "today" is its last day — the month is complete, so the forecast has nothing
 * left to project and correctly reports the actual total. Using the real today
 * against a past month would divide that month's spending by today's
 * day-of-month and invent a wild projection.
 */
function referenceDate(month: string, asOf?: string): string {
  // A loaded case states its own reference date, and the published figures are
  // only reproducible against that date. It wins whenever it falls in the month
  // being viewed.
  if (asOf && asOf.slice(0, 7) === month) return asOf;

  const today = todayInLedgerZone();
  if (today.slice(0, 7) === month) return today;
  if (month < today.slice(0, 7)) return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
  // A future month has no elapsed days; treat its first day as the reference.
  return `${month}-01`;
}

export interface DashboardResult {
  month: string;
  last_month: string;
  today: string;
  dps_annual_rate_percent: string;
  dps_rule: string;
  /** The exact input the engine was given, so the figures can be reproduced. */
  ledger_case: LedgerCase;
  report: LedgerReport;
}

export async function buildDashboard(uid: string, month: string): Promise<DashboardResult> {
  const lastMonth = addMonths(month, -1);

  const [expenses, salary, pockets, settings] = await Promise.all([
    listExpensesForMonths(uid, [month, lastMonth]),
    effectiveSalary(uid, month),
    listPockets(uid),
    getSettings(uid),
  ]);

  const ledgerCase: LedgerCase = {
    case_id: `${uid.slice(0, 8)}-${month}`,
    today: referenceDate(month, settings.as_of_date),
    months: { last: lastMonth, this: month },
    salary_bdt: salary,
    expenses: expenses.map((expense) => ({
      id: expense.id,
      date: expense.date,
      category: expense.category,
      shop: expense.shop,
      amount_bdt: expense.amount_bdt,
    })),
    pockets: pockets.map((pocket) => ({
      id: pocket.id,
      name: pocket.name,
      item: pocket.item,
      target_bdt: pocket.target_bdt,
      monthly_contribution_bdt: pocket.monthly_contribution_bdt,
    })),
    dps_annual_rate_percent: settings.dps_annual_rate_percent,
    dps_rule: DPS_RULE,
  };

  return {
    month,
    last_month: lastMonth,
    today: ledgerCase.today,
    dps_annual_rate_percent: settings.dps_annual_rate_percent,
    dps_rule: DPS_RULE,
    ledger_case: ledgerCase,
    report: buildReport(ledgerCase),
  };
}
