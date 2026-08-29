/**
 * Savings pockets — required item 4.
 *
 * For each pocket we report:
 *   - months to target at the stated monthly contribution
 *   - the expected completion date (end of the month the target is reached)
 *   - what a DPS at the case's stated rate returns over that same period
 *   - whether this month's forecast actually leaves room for the contribution
 *
 * Contributions are assumed to start in the current month, so a pocket needing
 * N months completes at the end of month (this_month + N - 1). The DPS figure
 * runs the SAME contribution for the SAME number of months through the rule in
 * dps.ts, which is what makes "what a DPS would return over that time" a
 * like-for-like comparison rather than a marketing number.
 */
import { fmt, money } from "./money.js";
import { addMonths, endOfMonth } from "./calendar.js";
import { monthsToReachPlain, monthsToReachWithDps, runDps } from "./dps.js";
import type { Forecast, Pocket, PocketProjection } from "./types.js";

export interface PocketInput {
  pockets: Pocket[];
  thisMonth: string;
  annualRatePercent: string;
  forecast: Forecast;
}

export function projectPockets({
  pockets,
  thisMonth,
  annualRatePercent,
  forecast,
}: PocketInput): PocketProjection[] {
  const headroom = money(forecast.projected_end_position_bdt);

  // Total asked for by every pocket this month. Used to share out the forecast
  // surplus proportionally when it cannot cover all of them — funding the first
  // pocket in the list fully and starving the rest would be an arbitrary and
  // invisible policy.
  const totalAsked = pockets.reduce(
    (acc, p) => acc.plus(money(p.monthly_contribution_bdt)),
    money("0"),
  );

  return pockets.map((pocket) => {
    const contribution = money(pocket.monthly_contribution_bdt);
    const months = monthsToReachPlain(pocket.target_bdt, contribution);

    // A zero or absent contribution never completes; keep the row rather than
    // crashing, and let the UI show it as "not on track".
    const finite = Number.isFinite(months);
    const completionMonth = finite ? addMonths(thisMonth, months - 1) : thisMonth;

    const dps = runDps({
      monthlyDeposit: contribution,
      annualRatePercent,
      months: finite ? months : 0,
    });

    const plainTotal = contribution.times(finite ? months : 0);

    // ---- forecast-based completion -------------------------------------
    // The brief asks for "an expected completion date based on the forecast".
    // Target ÷ contribution ignores whether the money is actually there, so a
    // pocket whose contribution exceeds the projected surplus would show a
    // confident date the ledger cannot support. We therefore also compute the
    // date implied by what the forecast says is genuinely spare.
    //
    // When the surplus cannot cover every pocket, it is shared in proportion to
    // what each pocket asked for, rather than first-come-first-served.
    const spare = headroom.isNegative() ? money("0") : headroom;
    const share = totalAsked.isZero()
      ? money("0")
      : spare.times(contribution).dividedBy(totalAsked);
    const affordableMonthly = share.greaterThan(contribution) ? contribution : share;

    const forecastMonths = monthsToReachPlain(pocket.target_bdt, affordableMonthly);
    const forecastFinite = Number.isFinite(forecastMonths);
    const forecastMonth = forecastFinite ? addMonths(thisMonth, forecastMonths - 1) : thisMonth;

    const withDps = monthsToReachWithDps(pocket.target_bdt, contribution, annualRatePercent);

    return {
      pocket,
      // Non-finite becomes null at this boundary — see the note on the type.
      months_to_target: finite ? months : null,
      expected_completion_date: finite ? endOfMonth(completionMonth) : "—",
      expected_completion_month: finite ? completionMonth : "—",
      plain_total_bdt: fmt(plainTotal),
      dps,
      dps_gain_bdt: fmt(money(dps.maturity_value_bdt).minus(plainTotal)),
      months_to_target_with_dps: Number.isFinite(withDps) ? withDps : null,
      affordable_this_month: headroom.greaterThanOrEqualTo(contribution),

      affordable_monthly_bdt: fmt(affordableMonthly),
      forecast_months_to_target: forecastFinite ? forecastMonths : null,
      forecast_completion_date: forecastFinite ? endOfMonth(forecastMonth) : "—",
      on_track: affordableMonthly.greaterThanOrEqualTo(contribution),
    };
  });
}
