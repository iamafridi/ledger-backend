/**
 * Phase 1's four reports: the ones an accountant checks before anything else.
 *
 * WHY THE AGGREGATION USES `$toDecimal`
 * Money is stored as a canonical 2dp *string* so it never becomes a BSON double
 * (see `shared/db/money-field.ts`). Summing those in MongoDB naively would
 * coerce them to doubles and reintroduce exactly the drift this codebase exists
 * to prevent — so the sums run over `Decimal128`, which is exact, and the result
 * is stringified and re-canonicalised through `core/money.ts` on the way out.
 * Nothing here ever touches a JavaScript `number` for an amount.
 *
 * INCLUDES VOID ENTRIES, ON PURPOSE
 * A voided entry's lines are left in place and a reversing entry mirrors them.
 * Filtering to `POSTED` alone would drop the original and keep its reversal —
 * a net that is exactly backwards. So every non-draft entry counts: a posted
 * entry contributes itself, and a voided one contributes itself plus its
 * reversal, which nets to zero while both remain visible in the journal.
 */
import mongoose from "mongoose";

import { CoaAccountModel } from "../../coa/coa.model.js";
import { JournalLineModel } from "../../journals/journal.model.js";
import { money, fmt, add, sub, ZERO, type Money } from "../../../core/money.js";
import type { ReportParams, ReportRow } from "../report-registry.js";
import {
  DATE_WINDOW_PARAMS,
  registerReport,
  dateRange,
  requireParam,
  type ReportParam,
} from "../report-registry.js";

/** Statuses that are "in the books". Drafts are not; voids are (see above). */
const IN_BOOKS = ["POSTED", "VOID"];

const oid = (orgId: string) => new mongoose.Types.ObjectId(orgId);

/**
 * Sum debit and credit per account over a date range.
 *
 * One helper because Trial Balance, opening balances and the balance-sheet
 * work in Phase 5 all need the same three shapes: movement, opening, closing —
 * and three hand-rolled copies of this would drift apart the first time someone
 * remembered to exclude voids in one of them.
 */
async function sumByAccount(
  orgId: string,
  range: { from?: string; to?: string },
): Promise<Map<string, { code: string; name: string; type: string; debit: Money; credit: Money }>> {
  const match: Record<string, unknown> = {
    org_id: oid(orgId),
    "entry.status": { $in: IN_BOOKS },
  };
  if (range.from || range.to) {
    match["entry.date"] = {
      ...(range.from ? { $gte: range.from } : {}),
      ...(range.to ? { $lte: range.to } : {}),
    };
  }

  const rows = await JournalLineModel.aggregate<{
    _id: mongoose.Types.ObjectId;
    code: string;
    name: string;
    type: string;
    debit: unknown;
    credit: unknown;
  }>([
    { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
    { $unwind: "$entry" },
    { $match: match },
    { $lookup: { from: "coaaccounts", localField: "account_id", foreignField: "_id", as: "account" } },
    { $unwind: { path: "$account", preserveNullAndEmptyArrays: true } },
    {
      $group: {
        _id: "$account_id",
        code: { $first: "$account_code" },
        name: { $first: "$account_name" },
        type: { $first: "$account.type" },
        debit: { $sum: { $toDecimal: "$debit_bdt" } },
        credit: { $sum: { $toDecimal: "$credit_bdt" } },
      },
    },
    { $sort: { code: 1 } },
  ]);

  const grouped = new Map<string, { code: string; name: string; type: string; debit: Money; credit: Money }>();
  for (const row of rows) {
    grouped.set(row.code, {
      code: row.code,
      name: row.name,
      type: row.type ?? "",
      debit: money(String(row.debit ?? "0")),
      credit: money(String(row.credit ?? "0")),
    });
  }
  return grouped;
}

/**
 * Trial balance: opening, movement and closing per account, for a range.
 *
 * Opening is everything strictly before `from`, so a TB run for April shows
 * March's closing as its opening — which is the check an accountant performs
 * without being told to: last month's ending has to be this month's beginning.
 */
registerReport({
  code: "trial-balance",
  name: "Trial Balance",
  group: "GL",
  description: "Debit and credit movement with opening and closing balance per account.",
  params: DATE_WINDOW_PARAMS,
  additive: ["debit_bdt", "credit_bdt"],
  columns: [
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Account", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "opening_bdt", label: "Opening", type: "money" },
    { key: "debit_bdt", label: "Debit", type: "money" },
    { key: "credit_bdt", label: "Credit", type: "money" },
    { key: "closing_bdt", label: "Closing", type: "money" },
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const range = dateRange(params);

    const opening = range.from ? await sumByAccount(orgId, { to: dayBefore(range.from) }) : new Map();
    const movement = await sumByAccount(orgId, range);

    // Every active account is listed, even with no activity: a trial balance
    // that silently omits rows makes "is this everything?" unanswerable.
    const accounts = await CoaAccountModel.find({ org_id: orgId }).sort({ code: 1 }).lean();
    const byCode = new Map(accounts.map((account) => [account.code, account]));

    const codes = new Set([...opening.keys(), ...movement.keys(), ...byCode.keys()]);

    const rows: ReportRow[] = [];
    let totalOpening = ZERO;
    let totalDebit = ZERO;
    let totalCredit = ZERO;

    for (const code of [...codes].sort()) {
      const account = byCode.get(code);
      const open = opening.get(code);
      const move = movement.get(code);

      // A normal-balance sign keeps the closing column readable: assets and
      // expenses show a positive balance, their contra shows negative — rather
      // than every row being raw debits-minus-credits, which reads backwards for
      // half the chart.
      const isDebitNormal = account?.normal_balance === "DEBIT" || move?.type === "EXPENSE";
      const openingNet = open ? sub(open.debit, open.credit) : ZERO;
      const movementNet = move ? sub(move.debit, move.credit) : ZERO;
      const closingNet = add(openingNet, movementNet);
      const sign = isDebitNormal ? 1 : -1;

      const openingShown = sign === 1 ? openingNet : closingNet.minus(movementNet).times(-1);
      const closingShown = sign === 1 ? closingNet : closingNet.times(-1);

      const debit = move?.debit ?? ZERO;
      const credit = move?.credit ?? ZERO;

      totalOpening = add(totalOpening, sign === 1 ? openingShown : openingShown);
      totalDebit = add(totalDebit, debit);
      totalCredit = add(totalCredit, credit);
      void openingShown;

      rows.push({
        code,
        name: account?.name ?? move?.name ?? "(inactive account)",
        type: account?.type ?? "",
        opening_bdt: fmt(openingNet.times(sign)),
        debit_bdt: fmt(debit),
        credit_bdt: fmt(credit),
        closing_bdt: fmt(closingShown),
      });
    }

    return rows;
  },
});

/** `2026-04-01` → `2026-03-31`, computed arithmetically to stay timezone-free. */
function dayBefore(date: string): string {
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

/**
 * General Ledger for one account: every posting, in order, with a running
 * balance.
 *
 * The running balance cannot be aggregated — each row depends on the one before
 * it — so the rows are read in date order and accumulated with decimal.js. That
 * is sequential by nature, and it is the one place in the reporting layer where
 * a per-row loop is the correct shape rather than a shortcut.
 */
registerReport({
  code: "general-ledger",
  name: "General Ledger",
  group: "GL",
  description: "Every posting for one account, in date order, with a running balance.",
  params: [
    { key: "account_code", label: "Account", kind: "account", required: true },
    ...DATE_WINDOW_PARAMS,
  ] satisfies ReportParam[],
  // Debits and credits may be totalled; the running balance must not be.
  additive: ["debit_bdt", "credit_bdt"],
  columns: [
    { key: "date", label: "Date", type: "date" },
    { key: "entry_no", label: "Entry", type: "code" },
    { key: "description", label: "Description", type: "text" },
    { key: "memo", label: "Line memo", type: "text" },
    { key: "debit_bdt", label: "Debit", type: "money" },
    { key: "credit_bdt", label: "Credit", type: "money" },
    { key: "balance_bdt", label: "Balance", type: "money" },
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const accountCode = requireParam(params, "account_code", "Choose an account to see its general ledger.");

    const match: Record<string, unknown> = { org_id: oid(orgId), account_code: accountCode };
    const range = dateRange(params);
    if (range.from || range.to) {
      // The range is applied to the joined entry, so the lookup must come first.
      match["entry.date"] = {
        ...(range.from ? { $gte: range.from } : {}),
        ...(range.to ? { $lte: range.to } : {}),
      };
    }

    const rows = await JournalLineModel.aggregate<{
      date: string;
      entry_no: string | null;
      description: string;
      memo: string;
      debit_bdt: string;
      credit_bdt: string;
      status: string;
    }>([
      { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
      { $unwind: "$entry" },
      { $match: match },
      { $match: { "entry.status": { $in: IN_BOOKS } } },
      { $sort: { "entry.date": 1, "entry.entry_no": 1, sort_order: 1 } },
      {
        $project: {
          date: "$entry.date",
          entry_no: "$entry.entry_no",
          description: "$entry.description",
          status: "$entry.status",
          memo: 1,
          debit_bdt: 1,
          credit_bdt: 1,
        },
      },
    ]);

    const account = await CoaAccountModel.findOne({ org_id: orgId, code: accountCode }).lean();
    const isDebitNormal = account?.normal_balance === "DEBIT";

    let balance: Money = ZERO;
    return rows.map((row) => {
      const debit = money(row.debit_bdt);
      const credit = money(row.credit_bdt);
      balance = add(balance, isDebitNormal ? sub(debit, credit) : sub(credit, debit));

      return {
        date: row.date,
        entry_no: row.entry_no ?? "(draft)",
        description: row.description,
        memo: row.memo ?? "",
        debit_bdt: row.debit_bdt,
        credit_bdt: row.credit_bdt,
        balance_bdt: fmt(balance),
        status: row.status,
      };
    });
  },
});

/** Every posting on one date — the book a small business checks nightly. */
registerReport({
  code: "day-book",
  name: "Day Book",
  group: "GL",
  description: "All entries posted on a single date, with their lines.",
  params: [{ key: "date", label: "Date", kind: "date", required: true }],
  additive: ["debit_bdt", "credit_bdt"],
  columns: [
    { key: "entry_no", label: "Entry", type: "code" },
    { key: "date", label: "Date", type: "date" },
    { key: "account_code", label: "Account", type: "code" },
    { key: "account_name", label: "Account name", type: "text" },
    { key: "description", label: "Description", type: "text" },
    { key: "debit_bdt", label: "Debit", type: "money" },
    { key: "credit_bdt", label: "Credit", type: "money" },
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const date = requireParam(params, "date", "Choose a date to see the day book.");

    const rows = await JournalLineModel.aggregate<{
      entry_no: string | null;
      date: string;
      account_code: string;
      account_name: string;
      description: string;
      debit_bdt: string;
      credit_bdt: string;
    }>([
      { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
      { $unwind: "$entry" },
      { $match: { org_id: oid(orgId), "entry.date": date, "entry.status": { $in: IN_BOOKS } } },
      { $sort: { "entry.entry_no": 1, sort_order: 1 } },
      {
        $project: {
          entry_no: "$entry.entry_no",
          date: "$entry.date",
          description: "$entry.description",
          account_code: 1,
          account_name: 1,
          debit_bdt: 1,
          credit_bdt: 1,
        },
      },
    ]);

    return rows.map((row) => ({ ...row }));
  },
});

/** The chart itself, as a report — printable, and the frame the others hang on. */
registerReport({
  code: "chart-of-accounts",
  name: "Chart of Accounts",
  group: "GL",
  description: "Every account with its type, normal balance and active state.",
  columns: [
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Name", type: "text" },
    { key: "type", label: "Type", type: "text" },
    { key: "subtype", label: "Subtype", type: "text" },
    { key: "normal_balance", label: "Normal balance", type: "text" },
    { key: "is_active", label: "Active", type: "text" },
  ],
  query: async (orgId: string): Promise<ReportRow[]> => {
    const accounts = await CoaAccountModel.find({ org_id: orgId }).sort({ code: 1 }).lean();
    return accounts.map((account) => ({
      code: account.code,
      name: account.name,
      type: account.type,
      subtype: account.subtype ?? "",
      normal_balance: account.normal_balance,
      is_active: account.is_active === false ? "no" : "yes",
    }));
  },
});
