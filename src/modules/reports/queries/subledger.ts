/**
 * The sub-ledger reports — aging, statements, and the parties behind them.
 *
 * The AR and AP services already own the aging and statement logic (P3/P4);
 * these reports adapt their exact output into report rows rather than
 * re-deriving a second copy of either. A report that recomputed what
 * `agingReport()` already guarantees would be a second place for the buckets to
 * drift — and the day the aging screen and the aging CSV disagreed is the day
 * nobody trusts either.
 *
 * Statements are per-party, so they carry a required `party_id` parameter and
 * a from/to window; the totals row of each statement is the closing balance,
 * which is the figure the CSV is being printed to chase.
 */
import { Types } from "mongoose";

import { PartyModel } from "../../masterdata/parties.model.js";
import { agingReport as arAging, customerStatement } from "../../sales/ar.service.js";
import { agingReport as apAging, supplierStatement } from "../../purchases/ap.service.js";
import { AGING_BUCKETS } from "../../sales/ar.service.js";
import type { ReportParam, ReportParams, ReportRow } from "../report-registry.js";
import { DATE_WINDOW_PARAMS, registerReport } from "../report-registry.js";

const PARTY_PARAM: ReportParam = {
  key: "party_id",
  label: "Party",
  kind: "party",
  required: true,
  placeholder: "Choose a party…",
};

const isValidObjectId = (value: string): boolean => Types.ObjectId.isValid(value);

/* ── Aging ───────────────────────────────────────────────────────────────── */

const AGING_COLUMNS = [
  { key: "party_code", label: "Code", type: "code" as const },
  { key: "party_name", label: "Name", type: "text" as const },
  { key: "current_bdt", label: "Not yet due", type: "money" as const },
  { key: "d1_30_bdt", label: "1–30 days", type: "money" as const },
  { key: "d31_60_bdt", label: "31–60 days", type: "money" as const },
  { key: "d61_90_bdt", label: "61–90 days", type: "money" as const },
  { key: "d90_plus_bdt", label: "Over 90 days", type: "money" as const },
  { key: "total_bdt", label: "Total", type: "money" as const },
];

const AGING_ADDITIVE = [
  "current_bdt",
  "d1_30_bdt",
  "d31_60_bdt",
  "d31_60_bdt",
  "d61_90_bdt",
  "d90_plus_bdt",
  "total_bdt",
];

const asOfParam: ReportParam = { key: "as_of", label: "As of", kind: "date" };

function agingQuery(
  run: (orgId: string, asOf?: string) => Promise<{
    parties: Array<Record<string, string | number>>;
    totals: Record<string, string | number>;
  }>,
) {
  return async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const report = await run(orgId, typeof params["as_of"] === "string" ? params["as_of"] : undefined);
    return [
      ...report.parties,
      // The totals row as a row, so the CSV carries the check with the figures
      // it sums — the same convention the aging screens use.
      { ...report.totals, party_code: "", party_name: `Total (${report.parties.length} parties)` },
    ];
  };
}

registerReport({
  code: "ar-aging",
  name: "AR Aging",
  group: "Sub-ledgers",
  description: "What customers owe, bucketed by how late it is, as of a date.",
  params: [asOfParam],
  additive: AGING_ADDITIVE,
  columns: AGING_COLUMNS,
  query: agingQuery((orgId, asOf) => arAging(orgId, {} as never, asOf).then((report) => report as never)),
});

registerReport({
  code: "ap-aging",
  name: "AP Aging",
  group: "Sub-ledgers",
  description: "What we owe suppliers, bucketed by how late it is, as of a date.",
  params: [asOfParam],
  additive: AGING_ADDITIVE,
  columns: AGING_COLUMNS,
  query: agingQuery((orgId, asOf) => apAging(orgId, {} as never, asOf).then((report) => report as never)),
});

/* ── Statements ──────────────────────────────────────────────────────────── */

const STATEMENT_COLUMNS = [
  { key: "date", label: "Date", type: "date" as const },
  { key: "type", label: "Type", type: "text" as const },
  { key: "doc_no", label: "Document", type: "code" as const },
  { key: "description", label: "Description", type: "text" as const },
  { key: "debit_bdt", label: "Debit", type: "money" as const },
  { key: "credit_bdt", label: "Credit", type: "money" as const },
  { key: "balance_bdt", label: "Balance", type: "money" as const },
];

const STATEMENT_ADDITIVE = ["debit_bdt", "credit_bdt"];

function statementQuery(
  run: (orgId: string, partyId: string, window: { from?: string; to?: string }) => Promise<{
    party_code: string;
    party_name: string;
    opening_bdt: string;
    closing_bdt: string;
    movements: Array<Record<string, string | null>>;
  }>,
) {
  return async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const partyId = typeof params["party_id"] === "string" ? params["party_id"] : "";
    if (!isValidObjectId(partyId)) {
      // Shape-checking a party id here keeps a malformed one from reaching the
      // service as a cast error; the required-param case is already refused by
      // the registry's parse.
      return [];
    }
    const statement = await run(orgId, partyId, {
      from: typeof params["from"] === "string" ? params["from"] : undefined,
      to: typeof params["to"] === "string" ? params["to"] : undefined,
    });

    return [
      {
        date: "",
        type: "OPENING",
        doc_no: null,
        description: `${statement.party_name} — opening balance`,
        debit_bdt: "0.00",
        credit_bdt: "0.00",
        balance_bdt: statement.opening_bdt,
      },
      ...statement.movements,
      {
        date: typeof params["to"] === "string" ? params["to"] : "",
        type: "CLOSING",
        doc_no: null,
        description: `${statement.party_name} — closing balance`,
        debit_bdt: "0.00",
        credit_bdt: "0.00",
        balance_bdt: statement.closing_bdt,
      },
    ];
  };
}

registerReport({
  code: "customer-statement",
  name: "Customer Statement",
  group: "Sub-ledgers",
  description: "One customer's opening balance, movements and closing balance.",
  params: [PARTY_PARAM, ...DATE_WINDOW_PARAMS],
  additive: STATEMENT_ADDITIVE,
  columns: STATEMENT_COLUMNS,
  query: statementQuery((orgId, partyId, window) =>
    customerStatement(orgId, partyId, window as never).then((statement) => statement as never),
  ),
});

registerReport({
  code: "supplier-statement",
  name: "Supplier Statement",
  group: "Sub-ledgers",
  description: "One supplier's opening balance, movements and closing balance.",
  params: [PARTY_PARAM, ...DATE_WINDOW_PARAMS],
  additive: STATEMENT_ADDITIVE,
  columns: STATEMENT_COLUMNS,
  query: statementQuery((orgId, partyId, window) =>
    supplierStatement(orgId, partyId, window as never).then((statement) => statement as never),
  ),
});

/* ── Parties ─────────────────────────────────────────────────────────────── */

registerReport({
  code: "parties",
  name: "Parties",
  group: "Sub-ledgers",
  description: "Every customer and supplier with the account their balance posts to.",
  columns: [
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Name", type: "text" },
    { key: "kind", label: "Kind", type: "text" },
    { key: "email", label: "Email", type: "text" },
    { key: "phone", label: "Phone", type: "text" },
    { key: "control_account_code", label: "Control account", type: "code" },
    { key: "credit_limit_bdt", label: "Credit limit", type: "money" },
    { key: "is_active", label: "Active", type: "text" },
  ],
  query: async (orgId: string): Promise<ReportRow[]> => {
    const parties = await PartyModel.find({ org_id: orgId }).sort({ code: 1 }).lean();
    return parties.map((party) => ({
      code: party.code,
      name: party.name,
      kind: party.kind,
      email: party.email ?? "",
      phone: party.phone ?? "",
      control_account_code: party.control_account_code,
      credit_limit_bdt: party.credit_limit_bdt,
      is_active: party.is_active === false ? "no" : "yes",
    }));
  },
});

/** The bucket keys, exported for the smoke harness — one source, as everywhere. */
export { AGING_BUCKETS };
