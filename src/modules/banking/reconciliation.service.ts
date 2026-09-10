/**
 * Reconciliation — book against bank, and the one number that must be zero
 * (plan §6, Phase 6; this is the phase's exit gate).
 *
 * THE WALK
 * Every reconciliation, on paper or on screen, is the same walk:
 *
 *   book closing balance
 *     − what the books show that the bank has not seen yet   (items in transit;
 *       a cheque written is in the books the day it is written and on the
 *       statement the day it clears)
 *     + what the bank shows that the books do not yet carry   (a charge nobody
 *       recorded, a deposit the bank posted first)
 *     − a difference carried in from before this statement   (the opening
 *       balances not agreeing, which is last period's unfinished business)
 *   = the amount that has to be explained by the pairing itself
 *
 * If every matched pair agrees, and every correction posts exactly the line it
 * came from, that last figure is **0.00**. That is not a coincidence of the
 * arithmetic — it is what "reconciled" means, and it is why this phase's gate is
 * stated as zero unexplained difference rather than "the screen shows numbers".
 *
 * WHY THE OPENING IS DERIVED FROM THE FILE
 * When the statement prints a running balance, the opening is read back out of
 * it (first printed balance − that line's own effect), so the bank's own opening
 * is used rather than one we assumed. When the file prints no balances, the book
 * opening is assumed — stated here, and surfaced as `opening_basis`, because an
 * assumption that is invisible is one nobody can challenge.
 *
 * WHAT IS NOT BUILT
 * N:M matching (one statement line against several journal lines, and the
 * reverse). It is the honest next step for real bank charges that arrive netted,
 * and it is deliberately left as roadmap rather than half-built: a partial
 * many-to-many match is a reconciliation nobody can audit.
 */
import { z } from "zod";

import { BankAccountModel, StatementLineModel, type StatementLineDocument } from "./banking.model.js";
import { accountBalance, bookMovements, type BookMovement } from "./banking.ledger.js";
import { lineView, suggestionsFor, type StatementLineView, type Suggestion } from "./statement.service.js";
import { add, fmt, money, sub, ZERO, type Money } from "../../core/money.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";
import { notFoundError } from "../../shared/errors/app-error.js";
import { DateInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

export const ReconciliationQuery = z.object({
  from: DateInput.optional(),
  to: DateInput.optional(),
});

export type ReconciliationQueryInput = z.output<typeof ReconciliationQuery>;

export interface ReconciliationSummary {
  bank_account_id: string;
  account_code: string;
  account_name: string;
  from: string;
  to: string;

  book_opening_bdt: string;
  book_movement_bdt: string;
  book_closing_bdt: string;

  bank_opening_bdt: string;
  statement_movement_bdt: string;
  bank_closing_bdt: string;

  /** The raw gap: book closing − bank closing. Shown first, explained below. */
  difference_bdt: string;

  /** In the books, not on the statement (negative when it decreases the bank). */
  outstanding_book_bdt: string;
  outstanding_book_count: number;
  /** On the statement, not in the books. */
  unrecorded_bank_bdt: string;
  unrecorded_bank_count: number;
  /** Carried in from before the window: book opening − bank opening. */
  opening_difference_bdt: string;

  matched_count: number;
  matched_book_bdt: string;
  matched_statement_bdt: string;
  corrected_count: number;
  corrected_bdt: string;
  ignored_count: number;

  /** The figure this phase exists to drive to zero. */
  unexplained_bdt: string;
  /** Statement lines still awaiting a decision, plus book movements nothing on
   *  the statement accounts for. */
  open_items: number;
  /** `unexplained_bdt === "0.00"` and nothing is left open. */
  reconciled: boolean;
  /** Where the bank opening came from — the file's printed balance, or the
   *  books because the file printed none. */
  opening_basis: "statement" | "books";
}

export interface BookMovementView extends Omit<BookMovement, "effect"> {
  effect_bdt: string;
  matched: boolean;
  /** The statement line that matched this movement, when one did. */
  statement_line_id: string | null;
}

export interface ReconciliationWorkspace {
  summary: ReconciliationSummary;
  statement_lines: Array<StatementLineView & { suggestions: Suggestion[] }>;
  book_movements: BookMovementView[];
}

/** Signed effect of a statement line on the bank account. */
const effectOfLine = (line: StatementLineDocument): Money =>
  line.direction === "IN" ? money(line.amount_bdt) : money(line.amount_bdt).negated();

/** The day before `date`, in UTC so a month boundary cannot slip a day. */
function dayBefore(date: string): string {
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() - 1);
  return utc.toISOString().slice(0, 10);
}

/** `2026-09-14` → `2026-09-01`. */
function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** `2026-09-14` → `2026-09-30`, by asking the platform for day zero of the next
 *  month rather than carrying a table of month lengths. */
function endOfMonth(date: string): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const last = new Date(Date.UTC(year, month, 0));
  return last.toISOString().slice(0, 10);
}

export async function reconciliation(
  orgId: string,
  bankAccountId: string,
  query: ReconciliationQueryInput,
): Promise<ReconciliationWorkspace> {
  assertObjectId(bankAccountId, "That bank account does not exist.");
  const account = await BankAccountModel.findOne({ _id: bankAccountId, org_id: orgId }).lean();
  if (!account) throw notFoundError("That bank account does not exist.");

  const allLines = await StatementLineModel.find({ org_id: orgId, bank_account_id: account._id })
    .sort({ date: 1, seq: 1 })
    .lean();

  // Default window: the calendar month(s) the statement covers, not merely the
  // days that happen to carry lines. A bank statement *is* a month, and a
  // deposit made after its last line but inside that month is exactly the item in
  // transit this workspace exists to show. With no lines at all, today is the
  // only honest window there is.
  const today = todayInLedgerZone();
  const firstLine = allLines[0]?.date;
  const lastLine = allLines[allLines.length - 1]?.date;
  const from = query.from ?? (firstLine ? startOfMonth(firstLine) : today);
  const to = query.to ?? (lastLine ? endOfMonth(lastLine) : today);

  const inWindow = allLines.filter((line) => line.date >= from && line.date <= to);

  const [bookOpening, bookClosing, movements] = await Promise.all([
    accountBalance(orgId, account.account_code, dayBefore(from)),
    accountBalance(orgId, account.account_code, to),
    bookMovements(orgId, account.account_code, { from, to }),
  ]);

  // Where the bank's opening came from. The first printed running balance minus
  // its own line's effect is the balance *before* that line, i.e. the bank's
  // opening for the period that line belongs to.
  const firstWithBalance = allLines.find((line) => (line.balance_bdt ?? "") !== "");
  const bankOpening =
    firstWithBalance && firstWithBalance.balance_bdt
      ? lineOpening(firstWithBalance)
      : bookOpening;

  const statementMovement = inWindow.reduce((acc, line) => add(acc, effectOfLine(line)), ZERO);
  const bankClosing = add(bankOpening, statementMovement);

  const matchedLineIds = new Set(
    inWindow.filter((line) => line.matched_line_id).map((line) => String(line.matched_line_id)),
  );
  // A correction's own posting is this reconciliation's work product, not an
  // outstanding item — counting it as one would double-count the very line it
  // was posted for.
  const correctionEntryIds = new Set(
    allLines.filter((line) => line.adjustment_entry_id).map((line) => String(line.adjustment_entry_id)),
  );

  let outstanding = ZERO;
  let outstandingCount = 0;
  let matchedBook = ZERO;
  let matchedCount = 0;

  for (const movement of movements) {
    if (correctionEntryIds.has(movement.entry_id)) continue;
    if (matchedLineIds.has(movement.line_id)) {
      matchedBook = add(matchedBook, movement.effect);
      matchedCount += 1;
    } else {
      outstanding = add(outstanding, movement.effect);
      outstandingCount += 1;
    }
  }

  let matchedStatement = ZERO;
  let unrecorded = ZERO;
  let unrecordedCount = 0;
  let corrected = ZERO;
  let correctedCount = 0;
  let ignoredCount = 0;

  for (const line of inWindow) {
    const effect = effectOfLine(line);
    if (line.status === "MATCHED") matchedStatement = add(matchedStatement, effect);
    else if (line.status === "CORRECTED") {
      corrected = add(corrected, effect);
      correctedCount += 1;
    } else if (line.status === "IGNORED") ignoredCount += 1;
    else {
      unrecorded = add(unrecorded, effect);
      unrecordedCount += 1;
    }
  }

  const bookMovement = sub(bookClosing, bookOpening);
  const difference = sub(bookClosing, bankClosing);
  const openingDifference = sub(bookOpening, bankOpening);

  // The walk, term by term. Rearranging the identity above gives
  //   unexplained = difference − opening difference − in transit + not yet booked
  // and it is zero exactly when every matched pair agrees on its amount — which
  // is the only thing left once the timing items are named.
  const unexplained = difference.minus(openingDifference).minus(outstanding).plus(unrecorded);

  const openItems = unrecordedCount + outstandingCount;

  const summary: ReconciliationSummary = {
    bank_account_id: String(account._id),
    account_code: account.account_code,
    account_name: account.name,
    from,
    to,

    book_opening_bdt: fmt(bookOpening),
    book_movement_bdt: fmt(bookMovement),
    book_closing_bdt: fmt(bookClosing),

    bank_opening_bdt: fmt(bankOpening),
    statement_movement_bdt: fmt(statementMovement),
    bank_closing_bdt: fmt(bankClosing),

    difference_bdt: fmt(difference),

    outstanding_book_bdt: fmt(outstanding),
    outstanding_book_count: outstandingCount,
    unrecorded_bank_bdt: fmt(unrecorded),
    unrecorded_bank_count: unrecordedCount,
    opening_difference_bdt: fmt(openingDifference),

    matched_count: matchedCount,
    matched_book_bdt: fmt(matchedBook),
    matched_statement_bdt: fmt(matchedStatement),
    corrected_count: correctedCount,
    corrected_bdt: fmt(corrected),
    ignored_count: ignoredCount,

    unexplained_bdt: fmt(unexplained),
    open_items: openItems,
    // Reconciled means nothing is unexplained *and* every statement line has
    // been decided. Book movements the bank has not seen are items in transit —
    // a cheque written and not yet cleared, a deposit not yet credited — and a
    // live account always has some. Requiring those to be gone would make a
    // perfectly reconciled period look unreconciled.
    reconciled: money(fmt(unexplained)).isZero() && unrecordedCount === 0,
    opening_basis: firstWithBalance ? "statement" : "books",
  };

  const statementById = new Map(inWindow.map((line) => [String(line.matched_line_id ?? ""), String(line._id)]));
  const statementLines = await Promise.all(
    inWindow.map(async (line) => {
      const view = lineView(line);
      const suggestions = view.status === "UNMATCHED" ? await suggestionsFor(orgId, account.account_code, view) : [];
      return { ...view, suggestions };
    }),
  );

  return {
    summary,
    statement_lines: statementLines,
    book_movements: movements.map((movement) => ({
      ...movement,
      effect_bdt: fmt(movement.effect),
      matched: matchedLineIds.has(movement.line_id),
      statement_line_id: statementById.get(movement.line_id) ?? null,
    })),
  };
}

/** The balance *before* a line, read back out of its printed running balance. */
function lineOpening(line: StatementLineDocument): Money {
  const balance = money(line.balance_bdt ?? "0");
  return line.direction === "IN"
    ? sub(balance, money(line.amount_bdt))
    : add(balance, money(line.amount_bdt));
}
