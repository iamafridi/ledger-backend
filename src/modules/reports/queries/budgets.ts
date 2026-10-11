import { registerReport, type ReportParam, type ReportRow } from "../report-registry.js";
import { getBudgetVariance } from "../../budgets/budgets.service.js";

const BUDGET_PARAMS: ReportParam[] = [
  {
    key: "period_key",
    label: "Period",
    kind: "month",
    required: true,
  },
  {
    key: "segment_id",
    label: "Segment",
    kind: "choice",
    required: false,
  },
];

registerReport({
  code: "budget-variance",
  name: "Budget vs. Actual Variance",
  group: "analysis",
  description: "Variance analysis comparing budgeted revenue & expenses against posted ledger actuals.",
  params: BUDGET_PARAMS,
  additive: ["budget_bdt", "actual_bdt", "variance_bdt"],
  columns: [
    { key: "account_code", label: "Account Code", type: "code" },
    { key: "account_name", label: "Account Name", type: "text" },
    { key: "account_type", label: "Type", type: "text" },
    { key: "budget_bdt", label: "Budget (BDT)", type: "money" },
    { key: "actual_bdt", label: "Actual (BDT)", type: "money" },
    { key: "variance_bdt", label: "Variance (BDT)", type: "money" },
    { key: "variance_pct", label: "Variance %", type: "text" },
    { key: "status", label: "Evaluation", type: "text" },
  ],
  async query(orgId, params) {
    const periodKey = String(params["period_key"] || new Date().toISOString().slice(0, 7));
    const segmentId = params["segment_id"] ? String(params["segment_id"]) : undefined;

    const result = await getBudgetVariance(orgId, { periodKey, segmentId });

    const rows: ReportRow[] = result.rows.map((r) => ({
      account_code: r.account_code,
      account_name: r.account_name,
      account_type: r.account_type,
      budget_bdt: r.budget_bdt,
      actual_bdt: r.actual_bdt,
      variance_bdt: r.variance_bdt,
      variance_pct: r.variance_pct,
      status: r.is_favorable ? "FAVORABLE" : "UNFAVORABLE",
    }));

    return rows;
  },
});
