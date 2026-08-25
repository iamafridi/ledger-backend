/**
 * The bridge between personal expenses and the general ledger (plan §4, D3).
 *
 * WHY THIS MODULE EXISTS
 * An expense is the one place in this application where a person writes an
 * amount directly, and it used to write exactly one row: a category and a
 * number. The dashboard read that row; the books knew nothing about it. Two
 * views of the same money can only agree while there is one of them, so an
 * expense now posts a journal entry like every other financial document does —
 * `DR expense account / CR cash` — and carries the entry's id.
 *
 * WHY IT IS FAIL-SOFT, AND WHY THAT IS NOT A COP-OUT
 * Posting can legitimately fail: a date in a closed period, an account somebody
 * deactivated. Refusing to record the expense in that case would break the
 * personal edition for a reason that has nothing to do with the person typing.
 * So a failed post is swallowed *at the point of writing the expense* and the
 * row keeps `journal_entry_id: null`.
 *
 * Null is not a silent state, which is what makes this honest: the integrity run
 * counts it and fails while it is non-zero, `GET /expenses/ledger-status` reports
 * it, and the expenses screen offers to repair it. Fail-soft is only defensible
 * when the failure is visible and fixable; here it is both.
 */
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import { accountForCategory } from "../coa/coa.service.js";
import { ensurePeriodCoverage } from "../periods/periods.service.js";
import { postJournal, voidEntry } from "../../core/posting.js";

export interface ExpenseForLedger {
  id: string;
  date: string;
  category: string;
  shop: string;
  amount_bdt: string;
}

/**
 * Post one expense, making sure the books reach its date first.
 *
 * Coverage comes before the post because the whole point is that historic data
 * must be able to reach the ledger — an expense recorded in a month the calendar
 * has not opened yet is brought in rather than left out. `ensurePeriodCoverage`
 * is idempotent, so a month that is already open costs one read.
 *
 * The credit side is always cash: a personal expense is money leaving the house,
 * and the plan's D3 states the shape as `DR expense / CR cash`. Splitting it
 * across bank and cash would need a payment-method field on the expense, which
 * is a change to the personal edition rather than to the bridge.
 */
export async function postExpenseEntry(input: {
  orgId: string;
  uid: string;
  expense: ExpenseForLedger;
  ip?: string;
}): Promise<string> {
  const account = await accountForCategory(input.orgId, input.expense.category);

  await ensurePeriodCoverage(input.orgId, input.uid, [input.expense.date.slice(0, 7)]);

  const entry = await postJournal({
    orgId: input.orgId,
    uid: input.uid,
    date: input.expense.date,
    description: `${input.expense.category} — ${input.expense.shop}`,
    source: "EXPENSE",
    source_id: input.expense.id,
    lines: [
      { account_code: account.code, debit_bdt: input.expense.amount_bdt, memo: input.expense.category },
      { account_code: CONTROL_ACCOUNT.CASH, credit_bdt: input.expense.amount_bdt },
    ],
    ...(input.ip ? { ip: input.ip } : {}),
  });

  return entry.id;
}

/**
 * Reverse an expense's entry.
 *
 * A void rather than a delete, and a reason is mandatory, so the journal shows
 * that something was removed and why. A closed period refuses the void — that
 * refusal propagates, because the alternative is silently losing the reason a
 * figure changed.
 */
export async function voidExpenseEntry(input: {
  orgId: string;
  uid: string;
  entryId: string;
  reason: string;
  ip?: string;
}): Promise<void> {
  await voidEntry(input.orgId, input.uid, input.entryId, input.reason, input.ip);
}
