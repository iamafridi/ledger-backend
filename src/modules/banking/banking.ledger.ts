/**
 * The ledger side of banking — one read, used by every screen in this module.
 *
 * A bank/cash account is a *view* of a chart account, so "what do the books say
 * this account holds, and what moved it" is a journal question, and it is asked
 * here and nowhere else. The position, the reconciliation workspace and the
 * transfer form all read this spine, which is what keeps them from disagreeing
 * about what a movement is — the same reason the P5 statements share
 * `movementsByAccount`.
 *
 * DIRECTION IS DERIVED, NEVER STORED
 * Every bank/cash account is an ASSET with a DEBIT normal balance (the mapping
 * service refuses anything else), so a debit is money **in** and a credit is
 * money **out**. Stating that once, here, is what lets the reconciliation
 * compare a statement line's direction with a journal line's side without each
 * caller inventing its own sign convention.
 */
import mongoose from "mongoose";

import { JournalLineModel } from "../journals/journal.model.js";
import { add, fmt, money, sub, ZERO, type Money } from "../../core/money.js";

const oid = (orgId: string) => new mongoose.Types.ObjectId(orgId);

/** Entries that count as "in the books". A voided entry and its reversal each
 *  balance, and the pair nets to zero — including both is what makes a voided
 *  transfer disappear from the book balance without the row vanishing. */
export const IN_BOOKS = ["POSTED", "VOID"] as const;

export interface BookMovement {
  line_id: string;
  entry_id: string;
  entry_no: string | null;
  /** The journal entry's business date — the date the transfer or posting was
   *  recorded for, which is what a bank statement's date lines up with. */
  date: string;
  description: string;
  memo: string;
  /** `IN` increases the account (a debit on a debit-normal asset), `OUT`
   *  decreases it. The same vocabulary a statement line uses. */
  direction: "IN" | "OUT";
  amount_bdt: string;
  /** Signed effect on the account: positive for IN, negative for OUT. */
  effect: Money;
  /** The account's true balance immediately after this line, so a workspace
   *  can print a running balance without re-deriving the opening itself. */
  balance_bdt: string;
}

interface RawLine {
  line_id: unknown;
  entry_id: unknown;
  entry_no: string | null;
  date: string;
  description: string;
  memo: string;
  debit: unknown;
  credit: unknown;
  entry_seq: number | null;
  sort_order: number;
}

/** Every journal line on one account's code, in the order it hit the ledger. */
async function rawMovements(
  orgId: string,
  accountCode: string,
  range: { from?: string; to?: string },
): Promise<RawLine[]> {
  const match: Record<string, unknown> = {
    org_id: oid(orgId),
    account_code: accountCode,
    "entry.status": { $in: IN_BOOKS },
  };
  if (range.from || range.to) {
    match["entry.date"] = {
      ...(range.from ? { $gte: range.from } : {}),
      ...(range.to ? { $lte: range.to } : {}),
    };
  }

  return JournalLineModel.aggregate<RawLine>([
    { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
    { $unwind: "$entry" },
    { $match: match },
    {
      $project: {
        _id: 0,
        line_id: "$_id",
        entry_id: "$entry_id",
        entry_no: "$entry.entry_no",
        date: "$entry.date",
        description: "$entry.description",
        memo: "$memo",
        debit: { $toDecimal: "$debit_bdt" },
        credit: { $toDecimal: "$credit_bdt" },
        entry_seq: "$entry.entry_seq",
        sort_order: "$sort_order",
      },
    },
    // Date first, then the entry's own sequence, then the line's position inside
    // it: a deterministic order, so a running balance is reproducible.
    { $sort: { date: 1, entry_seq: 1, sort_order: 1 } },
  ]);
}

/** Signed effect of one raw line: debit grows a debit-normal account. */
function effectOf(line: RawLine): Money {
  return sub(money(String(line.debit ?? "0")), money(String(line.credit ?? "0")));
}

/**
 * The account's balance as it stood **just before** `from`, which is what makes
 * a running balance a real balance rather than a total since the window opened.
 */
async function openingBefore(orgId: string, accountCode: string, from: string | undefined): Promise<Money> {
  if (!from) return ZERO;
  const head = await rawMovements(orgId, accountCode, { to: previousDay(from) });
  return head.reduce((acc, line) => add(acc, effectOf(line)), ZERO);
}

/** `2026-03-01` → `2026-02-28`, in UTC so a month boundary cannot slip a day. */
function previousDay(date: string): string {
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

/** The movements on one account over a window, with a running balance. */
export async function bookMovements(
  orgId: string,
  accountCode: string,
  range: { from?: string; to?: string } = {},
): Promise<BookMovement[]> {
  const [opening, rows] = await Promise.all([
    openingBefore(orgId, accountCode, range.from),
    rawMovements(orgId, accountCode, range),
  ]);

  let running = opening;
  return rows.map((line) => {
    const effect = effectOf(line);
    running = add(running, effect);
    const debit = money(String(line.debit ?? "0"));
    const credit = money(String(line.credit ?? "0"));
    const direction: "IN" | "OUT" = debit.greaterThan(credit) ? "IN" : "OUT";

    return {
      line_id: String(line.line_id),
      entry_id: String(line.entry_id),
      entry_no: line.entry_no ?? null,
      date: line.date,
      description: line.description,
      memo: line.memo ?? "",
      direction,
      amount_bdt: fmt(debit.greaterThan(credit) ? debit : credit),
      effect,
      balance_bdt: fmt(running),
    };
  });
}

/** The account's balance as at `to` (inclusive), or as at today when omitted. */
export async function accountBalance(
  orgId: string,
  accountCode: string,
  to?: string,
): Promise<Money> {
  const rows = await rawMovements(orgId, accountCode, to ? { to } : {});
  return rows.reduce((acc, line) => add(acc, effectOf(line)), ZERO);
}

/** One journal line, resolved by id, scoped to the organisation — used when a
 *  statement line is matched to a specific line the client picked. */
export async function journalLineById(orgId: string, lineId: string): Promise<
  | {
      line_id: string;
      entry_id: string;
      entry_no: string | null;
      date: string;
      description: string;
      account_code: string;
      direction: "IN" | "OUT";
      amount_bdt: string;
    }
  | null
> {
  // A mistyped id is the client's problem, not a driver cast error dressed up as
  // a 500.
  if (!/^[0-9a-fA-F]{24}$/.test(lineId)) return null;

  const rows = await JournalLineModel.aggregate<{
    line_id: unknown;
    entry_id: unknown;
    entry_no: string | null;
    date: string;
    description: string;
    account_code: string;
    debit: unknown;
    credit: unknown;
  }>([
    { $match: { org_id: oid(orgId), _id: new mongoose.Types.ObjectId(lineId) } },
    { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
    { $unwind: "$entry" },
    { $match: { "entry.status": { $in: IN_BOOKS } } },
    {
      $project: {
        _id: 0,
        line_id: "$_id",
        entry_id: "$entry_id",
        entry_no: "$entry.entry_no",
        date: "$entry.date",
        description: "$entry.description",
        account_code: "$account_code",
        debit: { $toDecimal: "$debit_bdt" },
        credit: { $toDecimal: "$credit_bdt" },
      },
    },
  ]);

  const row = rows[0];
  if (!row) return null;

  const debit = money(String(row.debit ?? "0"));
  const credit = money(String(row.credit ?? "0"));
  const isDebit = debit.greaterThan(credit);

  return {
    line_id: String(row.line_id),
    entry_id: String(row.entry_id),
    entry_no: row.entry_no ?? null,
    date: row.date,
    description: row.description,
    account_code: row.account_code,
    direction: isDebit ? "IN" : "OUT",
    amount_bdt: fmt(isDebit ? debit : credit),
  };
}
