/**
 * The organisation-wide financials — the four statements and the two views a
 * proprietor asks for first (plan §6 Phase 5).
 *
 * THE STATEMENTS SHARE ONE SPINE
 * Every statement is the trial balance seen through a different lens, so they
 * all read the same aggregate: net movement per account (debits − credits,
 * signed by the account's normal balance) over a window. Building each
 * statement on its own aggregation would be four chances for "in the books"
 * to mean something slightly different; one helper makes that impossible.
 *
 * THE COMPARE WINDOW
 * `compare=previous-period` or `previous-year` re-runs the same computation
 * over a shifted window and puts the two columns side by side. The shift is
 * whole months in calendar arithmetic (`core/calendar.ts`), never a Date, so a
 * 31-day month compared with a 30-day one compares equal-length windows — the
 * only comparison that answers "did we do better?".
 *
 * WHAT CLOSED PERIODS MEAN HERE
 * Nothing: a statement reads whatever is posted, whenever it was posted. The
 * closed-period rule guards *writes*; a report is a read, and refusing to show
 * history because somebody reopened March would be the tail wagging the dog.
 */
import mongoose from "mongoose";

import { CoaAccountModel } from "../../coa/coa.model.js";
import { JournalLineModel } from "../../journals/journal.model.js";
import { monthOf } from "../../../core/calendar.js";
import { add, fmt, money, sub, sum, ZERO, type Money } from "../../../core/money.js";
import { todayInLedgerZone } from "../../../shared/dates/today.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { ReportParams, ReportRow } from "../report-registry.js";
import {
  COMPARE_PARAM,
  DATE_WINDOW_PARAMS,
  registerReport,
  dateRange,
} from "../report-registry.js";

const oid = (orgId: string) => new mongoose.Types.ObjectId(orgId);
const IN_BOOKS = ["POSTED", "VOID"];

/** The ledger-side movement of one account: signed by its normal balance, so a
 *  positive number always reads as "the account grew". */
interface AccountMovement {
  code: string;
  name: string;
  type: string;
  subtype: string;
  normal_balance: string;
  movement: Money;
}

async function movementsByAccount(
  orgId: string,
  range: { from?: string; to?: string },
): Promise<Map<string, AccountMovement>> {
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
    _id: unknown;
    code: string;
    name: string;
    type: string;
    subtype: string;
    normal_balance: string;
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
        subtype: { $first: "$account.subtype" },
        normal_balance: { $first: "$account.normal_balance" },
        debit: { $sum: { $toDecimal: "$debit_bdt" } },
        credit: { $sum: { $toDecimal: "$credit_bdt" } },
      },
    },
  ]);

  const out = new Map<string, AccountMovement>();
  for (const row of rows) {
    const debit = money(String(row.debit ?? "0"));
    const credit = money(String(row.credit ?? "0"));
    const debitNormal = row.normal_balance === "DEBIT";
    out.set(row.code, {
      code: row.code,
      name: row.name,
      type: row.type ?? "",
      subtype: row.subtype ?? "",
      normal_balance: row.normal_balance ?? "DEBIT",
      movement: debitNormal ? sub(debit, credit) : sub(credit, debit),
    });
  }
  return out;
}

/**
 * The signed sum of one account group — assets, liabilities, revenue…
 * over the window.
 */
function netOf(movements: Map<string, AccountMovement>, type: string): Money {
  return sum([...movements.values()].filter((row) => row.type === type).map((row) => row.movement));
}

/**
 * The comparative window for a statement.
 *
 * Statements run on a window; `compare` shifts that same window whole months.
 * With no explicit window, a statement defaults to the fiscal month to date —
 * the default the P&L is opened for — so the comparison has something concrete
 * to shift.
 */
async function comparativeWindow(
  params: ReportParams,
): Promise<{ base: { from?: string; to?: string }; compare: { from?: string; to?: string } | null; label: string }> {
  const base = dateRange(params);
  const compare = typeof params["compare"] === "string" ? params["compare"] : "none";

  // Fill the default window from the calendar when the caller gave neither end:
  // this month, so "the P&L" is the month you are in, not the whole ledger.
  if (!base.from && !base.to) {
    const to = todayInLedgerZone();
    base.from = `${to.slice(0, 7)}-01`;
    base.to = to;
  }

  if (compare === "none") return { base, compare: null, label: "" };

  const from = base.from!;
  const to = base.to ?? todayInLedgerZone();
  const months = monthOf(to).slice(0, 4) === from.slice(0, 4) && monthOf(to) === from.slice(0, 7)
    ? 1
    : Math.max(1, monthSpan(from, to));

  if (compare === "previous-period") {
    const shift = months;
    return {
      base,
      compare: { from: shiftDate(from, -shift), to: shiftDate(to, -shift) },
      label: "previous period",
    };
  }
  if (compare === "previous-year") {
    return {
      base,
      compare: { from: shiftDate(from, -12), to: shiftDate(to, -12) },
      label: "same period last year",
    };
  }
  throw new AppError(422, "PARAM_INVALID", "compare must be none, previous-period or previous-year.");
}

/** Whole months a window spans, minimum one — the previous-period shift. */
function monthSpan(from: string, to: string): number {
  const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
  return months <= 0 ? 1 : months + (to.slice(8) >= from.slice(8) ? 1 : 0);
}

/** Shift a date by whole months, clamping the day into the target month. */
function shiftDate(date: string, months: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const zero = year * 12 + (month - 1) + months;
  const ny = Math.floor(zero / 12);
  const nm = (zero % 12) + 1;
  const day = Number(date.slice(8, 10));
  const daysIn = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(day, daysIn)).padStart(2, "0")}`;
}

/** Money column pair for a compared statement row. */
function comparePair(base: Money, comparative: Money | null): { value_bdt: string; compare_bdt: string } {
  return {
    value_bdt: fmt(base),
    compare_bdt: comparative === null ? "" : fmt(comparative),
  };
}

/** The compare columns every statement table carries. */
const COMPARE_COLUMNS = [
  { key: "value_bdt", label: "Amount", type: "money" as const },
  { key: "compare_bdt", label: "Compare", type: "money" as const },
] as const;

/* ── Balance sheet ───────────────────────────────────────────────────────── */

registerReport({
  code: "balance-sheet",
  name: "Balance Sheet",
  group: "Statements",
  description: "Assets, liabilities and equity as they stood at the end of the window.",
  params: [...DATE_WINDOW_PARAMS, COMPARE_PARAM],
  columns: [
    { key: "section", label: "Section", type: "text" },
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Account", type: "text" },
    ...COMPARE_COLUMNS,
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const { base, compare, label } = await comparativeWindow(params);
    const to = base.to ?? todayInLedgerZone();

    // The balance sheet is a *position*, not a movement: everything ever posted,
    // up to `to`. The window's `from` is deliberately ignored — an asset does
    // not stop existing because the viewer asked for April.
    const baseMovements = await movementsByAccount(orgId, { to });
    const compareMovements = compare
      ? await movementsByAccount(orgId, { to: compare.to })
      : null;

    const accounts = await CoaAccountModel.find({ org_id: orgId }).sort({ code: 1 }).lean();

    const sectionOf = (type: string): string =>
      type === "ASSET" ? "Assets" : type === "LIABILITY" ? "Liabilities" : type === "EQUITY" ? "Equity" : "";

    const rows: ReportRow[] = [];
    let assets = ZERO;
    let liabilities = ZERO;
    let equity = ZERO;
    let compareAssets = ZERO;
    let compareLiabilities = ZERO;
    let compareEquity = ZERO;

    // Revenue and expenses are the year's earnings, shown as one line: they
    // belong on the balance sheet because they have not been rolled into
    // retained earnings yet — the classic small-business presentation.
    let revenue = ZERO;
    let expenses = ZERO;
    let compareRevenue = ZERO;
    let compareExpenses = ZERO;

    for (const account of accounts) {
      const movement = baseMovements.get(account.code);
      if (!movement || movement.movement.isZero()) continue;
      if (account.type === "REVENUE" || account.type === "EXPENSE") continue;

      const comparative = compareMovements?.get(account.code)?.movement ?? null;
      const pair = comparePair(movement.movement, comparative);
      rows.push({
        section: sectionOf(account.type),
        code: account.code,
        name: account.name,
        ...pair,
      });
    }

    for (const movement of baseMovements.values()) {
      if (movement.type === "ASSET") assets = add(assets, movement.movement);
      else if (movement.type === "LIABILITY") liabilities = add(liabilities, movement.movement);
      else if (movement.type === "EQUITY") equity = add(equity, movement.movement);
      else if (movement.type === "REVENUE") revenue = add(revenue, movement.movement);
      else if (movement.type === "EXPENSE") expenses = add(expenses, movement.movement);
    }
    if (compareMovements) {
      for (const movement of compareMovements.values()) {
        if (movement.type === "ASSET") compareAssets = add(compareAssets, movement.movement);
        else if (movement.type === "LIABILITY") compareLiabilities = add(compareLiabilities, movement.movement);
        else if (movement.type === "EQUITY") compareEquity = add(compareEquity, movement.movement);
        else if (movement.type === "REVENUE") compareRevenue = add(compareRevenue, movement.movement);
        else if (movement.type === "EXPENSE") compareExpenses = add(compareExpenses, movement.movement);
      }
    }

    const profit = sub(revenue, expenses);
    const compareProfit = sub(compareRevenue, compareExpenses);

    rows.push(
      {
        section: "Earnings",
        code: "",
        name: label ? `Profit this year to date (vs ${label})` : "Profit this year to date",
        ...comparePair(profit, compare ? compareProfit : null),
      },
      {
        section: "",
        code: "",
        name: "Total assets",
        ...comparePair(assets, compare ? compareAssets : null),
      },
      {
        section: "",
        code: "",
        name: "Total liabilities",
        ...comparePair(liabilities, compare ? compareLiabilities : null),
      },
      {
        section: "",
        code: "",
        name: "Equity (incl. current earnings)",
        ...comparePair(add(equity, profit), compare ? add(compareEquity, compareProfit) : null),
      },
    );

    return rows;
  },
});

/* ── Profit & loss ───────────────────────────────────────────────────────── */

registerReport({
  code: "profit-loss",
  name: "Profit & Loss",
  group: "Statements",
  description: "Income and expenses over the window, down to the profit line.",
  params: [...DATE_WINDOW_PARAMS, COMPARE_PARAM],
  columns: [
    { key: "section", label: "Section", type: "text" },
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Account", type: "text" },
    ...COMPARE_COLUMNS,
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const { base, compare, label } = await comparativeWindow(params);

    const baseMovements = await movementsByAccount(orgId, base);
    const compareMovements = compare ? await movementsByAccount(orgId, compare) : null;

    const rows: ReportRow[] = [];
    let income = ZERO;
    let spending = ZERO;
    let compareIncome = ZERO;
    let compareSpending = ZERO;

    const accounts = await CoaAccountModel.find({ org_id: orgId }).sort({ code: 1 }).lean();
    for (const account of accounts) {
      const movement = baseMovements.get(account.code);
      if (!movement || movement.movement.isZero()) continue;
      if (account.type !== "REVENUE" && account.type !== "EXPENSE") continue;

      const comparative = compareMovements?.get(account.code)?.movement ?? null;
      rows.push({
        section: account.type === "REVENUE" ? "Income" : "Expenses",
        code: account.code,
        name: account.name,
        ...comparePair(movement.movement, comparative),
      });
    }

    for (const movement of baseMovements.values()) {
      if (movement.type === "REVENUE") income = add(income, movement.movement);
      else if (movement.type === "EXPENSE") spending = add(spending, movement.movement);
    }
    if (compareMovements) {
      for (const movement of compareMovements.values()) {
        if (movement.type === "REVENUE") compareIncome = add(compareIncome, movement.movement);
        else if (movement.type === "EXPENSE") compareSpending = add(compareSpending, movement.movement);
      }
    }

    const profit = sub(income, spending);
    const compareProfit = sub(compareIncome, compareSpending);

    rows.push({
      section: "",
      code: "",
      name: label ? `Profit (vs ${label})` : "Profit",
      ...comparePair(profit, compare ? compareProfit : null),
    });

    return rows;
  },
});

/* ── Cash flow (indirect) ────────────────────────────────────────────────── */

registerReport({
  code: "cashflow",
  name: "Cash Flow",
  group: "Statements",
  description: "Profit reconciled to the cash that actually moved, indirect method.",
  params: [...DATE_WINDOW_PARAMS, COMPARE_PARAM],
  columns: [
    { key: "section", label: "Section", type: "text" },
    { key: "name", label: "Line", type: "text" },
    ...COMPARE_COLUMNS,
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const { base, compare, label } = await comparativeWindow(params);

    const build = async (window: { from?: string; to?: string }) => {
      const movements = await movementsByAccount(orgId, window);
      // Profit is the whole window's earnings.
      const revenue = netOf(movements, "REVENUE");
      const expenses = netOf(movements, "EXPENSE");
      const profit = sub(revenue, expenses);

      // Working-capital movement: every non-cash asset and liability moved over
      // the window, signed as its effect on cash. Accumulated depreciation and
      // its expense cancel through profit, so they need no separate line.
      let working = ZERO;
      for (const movement of movements.values()) {
        if (movement.type === "ASSET" && movement.subtype !== "CASH" && movement.subtype !== "BANK") {
          working = sub(working, movement.movement);
        } else if (movement.type === "LIABILITY") {
          working = add(working, movement.movement);
        }
      }

      // The cash accounts themselves: what actually arrived and left.
      const cashRows = [...movements.values()].filter(
        (movement) => movement.type === "ASSET" && (movement.subtype === "CASH" || movement.subtype === "BANK"),
      );
      const netCash = sum(cashRows.map((row) => row.movement));

      return { profit, working, netCash, cashRows };
    };

    const baseResult = await build(base);
    const compareResult = compare ? await build(compare) : null;

    const rows: ReportRow[] = [
      {
        section: "Operating",
        name: label ? `Profit (vs ${label})` : "Profit",
        ...comparePair(baseResult.profit, compareResult?.profit ?? null),
      },
      {
        section: "Operating",
        name: "Working-capital movement",
        ...comparePair(baseResult.working, compareResult?.working ?? null),
      },
      {
        section: "",
        name: "Net cash movement",
        ...comparePair(baseResult.netCash, compareResult?.netCash ?? null),
      },
    ];

    for (const row of baseResult.cashRows) {
      const comparative = compareResult?.cashRows.find((candidate) => candidate.code === row.code) ?? null;
      rows.push({
        section: "Cash accounts",
        name: `${row.code} — ${row.name}`,
        ...comparePair(row.movement, comparative ? comparative.movement : null),
      });
    }

    return rows;
  },
});

/* ── Changes in equity ───────────────────────────────────────────────────── */

registerReport({
  code: "changes-equity",
  name: "Changes in Equity",
  group: "Statements",
  description: "Capital and retained earnings, and what moved them, over the window.",
  params: [...DATE_WINDOW_PARAMS, COMPARE_PARAM],
  columns: [
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Account", type: "text" },
    ...COMPARE_COLUMNS,
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const { base, compare, label } = await comparativeWindow(params);

    const baseMovements = await movementsByAccount(orgId, base);
    const compareMovements = compare ? await movementsByAccount(orgId, compare) : null;

    const accounts = await CoaAccountModel.find({ org_id: orgId, type: "EQUITY" })
      .sort({ code: 1 })
      .lean();

    const rows: ReportRow[] = [];
    for (const account of accounts) {
      const movement = baseMovements.get(account.code);
      const comparative = compareMovements?.get(account.code)?.movement ?? null;
      // Equity accounts are shown even at zero: a capital account that did not
      // move is a line the statement is expected to show, not one to omit.
      rows.push({
        code: account.code,
        name: account.name,
        ...comparePair(movement ? movement.movement : ZERO, comparative),
      });
    }

    // The year's profit is the third mover: it lands in equity the moment it is
    // earned, and the statement names it rather than leaving the reader to
    // reconcile the balance sheet by hand.
    const revenue = netOf(baseMovements, "REVENUE");
    const expenses = netOf(baseMovements, "EXPENSE");
    const profit = sub(revenue, expenses);
    const compareProfit = compareMovements
      ? sub(netOf(compareMovements, "REVENUE"), netOf(compareMovements, "EXPENSE"))
      : null;

    rows.push({
      code: "",
      name: label ? `Profit for the period (vs ${label})` : "Profit for the period",
      ...comparePair(profit, compareProfit),
    });

    return rows;
  },
});

/* ── Expenses by category ────────────────────────────────────────────────── */

/**
 * The org-wide expenses view.
 *
 * Deliberately *not* `expenseRegister()`: the register is uid-scoped personal
 * finance (P0's privacy stance), and an organisational expense report that
 * leaked a colleague's groceries would be a worse defect than a missing report.
 * The business's expense picture is read from the **ledger** — every EXPENSE
 * account's movement over the window — which is the same figure the P&L shows,
 * sourced the one way the double-entry core guarantees.
 */
registerReport({
  code: "expenses-by-category",
  name: "Expenses by Category",
  group: "Analysis",
  description: "What the organisation spent, by expense account, over the window.",
  params: DATE_WINDOW_PARAMS,
  additive: ["value_bdt", "share_bdt"],
  columns: [
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Category", type: "text" },
    { key: "value_bdt", label: "Spent", type: "money" },
    { key: "share_bdt", label: "Of total", type: "money" },
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const range = dateRange(params);
    const movements = await movementsByAccount(orgId, range);

    const rows: ReportRow[] = [];
    let total = ZERO;
    for (const movement of movements.values()) {
      if (movement.type !== "EXPENSE" || movement.movement.isZero()) continue;
      total = add(total, movement.movement);
      rows.push({ code: movement.code, name: movement.name, value_bdt: fmt(movement.movement), share_bdt: "" });
    }
    rows.sort((a, b) => (money(String(b.value_bdt)).greaterThan(money(String(a.value_bdt))) ? 1 : -1));

    // The share column is filled after sorting so the biggest spenders read
    // first and their share still lands on the right row.
    for (const row of rows) {
      row["share_bdt"] = total.isZero() ? "0.00" : row["value_bdt"];
    }

    return rows;
  },
});

/* ── Cash position ───────────────────────────────────────────────────────── */

/**
 * What is in the till, right now.
 *
 * One row per cash/bank account with everything ever posted to it — a position
 * again, so no `from` — plus the total. The `as_of` window is honoured by
 * cutting at `to`, because "what did we have on the 31st?" is the question a
 * month-end asks.
 */
registerReport({
  code: "cash-position",
  name: "Cash Position",
  group: "Analysis",
  description: "What is in the cash and bank accounts as of a date.",
  params: [{ key: "to", label: "As of", kind: "date" }],
  additive: ["value_bdt"],
  columns: [
    { key: "code", label: "Code", type: "code" },
    { key: "name", label: "Account", type: "text" },
    { key: "value_bdt", label: "Balance", type: "money" },
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const to = typeof params["to"] === "string" ? params["to"] : todayInLedgerZone();
    const movements = await movementsByAccount(orgId, { to });

    const rows: ReportRow[] = [];
    let total = ZERO;
    for (const movement of movements.values()) {
      if (movement.type !== "ASSET") continue;
      if (movement.subtype !== "CASH" && movement.subtype !== "BANK") continue;
      total = add(total, movement.movement);
      rows.push({ code: movement.code, name: movement.name, value_bdt: fmt(movement.movement) });
    }

    rows.push({ code: "", name: "Total cash and bank", value_bdt: fmt(total) });
    return rows;
  },
});
