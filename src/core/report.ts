/**
 * The one entry point that turns a sample case into the full report.
 *
 * Everything the UI renders and everything the verification harness checks comes
 * from this single pure function. If the app and the harness ever disagree, they
 * disagree about this function's output and nothing else — which is exactly the
 * property that makes the differential test in scripts/verify.ts meaningful.
 */
import { compareMonths } from "./ledger.js";
import { buildForecast } from "./forecast.js";
import { buildInsights } from "./insights.js";
import { projectPockets } from "./pockets.js";
import { CaseSchema, type LedgerCase, type LedgerReport } from "./types.js";

export function buildReport(input: LedgerCase): LedgerReport {
  // Parse rather than trust: a malformed money string must fail loudly here,
  // not silently become NaN three layers down.
  const c = CaseSchema.parse(input);

  const comparison = compareMonths(c.expenses, c.months.this, c.months.last);

  const forecast = buildForecast({
    expenses: c.expenses,
    today: c.today,
    thisMonth: c.months.this,
    salaryBdt: c.salary_bdt,
    pockets: c.pockets,
  });

  const pockets = projectPockets({
    pockets: c.pockets,
    thisMonth: c.months.this,
    annualRatePercent: c.dps_annual_rate_percent,
    forecast,
  });

  const insights = buildInsights({ comparison, forecast, pockets });

  return { case_id: c.case_id, comparison, forecast, insights, pockets };
}
