/**
 * Expenses — required item 1's "add expenses", and the raw material every other
 * required item is computed from.
 */
import { z } from "zod";

import { ExpenseModel } from "./expense.model.js";
import { postExpenseEntry, voidExpenseEntry, type ExpenseForLedger } from "./expense-ledger.js";
import { ensurePeriodCoverage } from "../periods/periods.service.js";
import { notFoundError } from "../../shared/errors/app-error.js";
import { writeAudit } from "../../core/audit.js";
import {
  CategoryInput,
  DateInput,
  MoneyInput,
  MonthInput,
  ObjectIdInput,
} from "../../shared/validation/schemas.js";
import { fmt, money, sum, type Money } from "../../core/money.js";

export const CreateExpenseSchema = z.object({
  date: DateInput,
  category: CategoryInput,
  shop: z.string().trim().min(1, "Where was it spent?").max(120),
  amount_bdt: MoneyInput,
  source: z.enum(["manual", "receipt"]).default("manual"),
  note: z.string().trim().max(500).default(""),
  /** Where the scanned document lives. A URL, not an upload — see the model. */
  attachment_url: z
    .string()
    .trim()
    .max(500)
    .refine((value) => value === "" || /^https?:\/\//.test(value), "An attachment needs to be an http(s) URL.")
    .default(""),
});

export const UpdateExpenseSchema = CreateExpenseSchema.partial();

export const ListExpenseQuery = z.object({
  month: MonthInput.optional(),
  category: CategoryInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/**
 * The register's filters (plan §6 Phase 4): a date window and a category, over
 * all months rather than one.
 *
 * The month filter above answers "what did I spend in June?"; this one answers
 * "what have I spent on transport since March?", which is the question a
 * register exists for. Scoped to the caller like every other read in this
 * module — a register is a personal view, not an organisational one.
 */
export const RegisterQuery = z.object({
  from: DateInput.optional(),
  to: DateInput.optional(),
  category: CategoryInput.optional(),
});

export type CreateExpenseInput = z.output<typeof CreateExpenseSchema>;
export type UpdateExpenseInput = z.output<typeof UpdateExpenseSchema>;

export interface ExpenseView {
  id: string;
  date: string;
  month: string;
  category: string;
  shop: string;
  amount_bdt: string;
  source: string;
  note: string;
  /** Object-storage URL of the scanned document, or empty. */
  attachment_url: string;
  /** The live journal entry for this expense, or null when it is not in the
   *  books yet. Surfaced so the screen can say which it is rather than leaving
   *  the person to guess. */
  journal_entry_id: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(doc: any): ExpenseView {
  return {
    id: String(doc._id),
    date: doc.date,
    month: doc.month,
    category: doc.category,
    shop: doc.shop,
    amount_bdt: doc.amount_bdt,
    source: doc.source ?? "manual",
    note: doc.note ?? "",
    attachment_url: doc.attachment_url ?? "",
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
  };
}

/**
 * Put an expense into the books, or leave it visibly out of them.
 *
 * The write-back is part of the same helper as the post so the two can never be
 * separated by an early return, and a failure resets the link to null rather
 * than leaving a stale id pointing at an entry that was voided half a moment
 * ago — a stale id would hide the expense from the repair path, which is the
 * only thing that would have fixed it.
 */
async function bridgeExpense(
  orgId: string,
  uid: string,
  expense: ExpenseForLedger,
  ip?: string,
): Promise<{ entry_id: string | null; error: string | null }> {
  try {
    const entryId = await postExpenseEntry({ orgId, uid, expense, ...(ip ? { ip } : {}) });
    await ExpenseModel.updateOne(
      { _id: expense.id, uid },
      { $set: { journal_entry_id: entryId, org_id: orgId } },
    );
    return { entry_id: entryId, error: null };
  } catch (error) {
    // Deliberately not swallowed quietly: the count of unbridged expenses is an
    // integrity check, the repair endpoint reports the reason, and this log line
    // is what makes an unexpected cause (as opposed to a closed period)
    // findable.
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[expenses] expense ${expense.id} is not in the ledger: ${message}`);
    await ExpenseModel.updateOne({ _id: expense.id, uid }, { $set: { journal_entry_id: null } }).catch(
      () => undefined,
    );
    return { entry_id: null, error: message };
  }
}

export async function listExpenses(
  uid: string,
  query: z.output<typeof ListExpenseQuery>,
): Promise<ExpenseView[]> {
  const filter: Record<string, unknown> = { uid };
  if (query.month) filter["month"] = query.month;
  if (query.category) filter["category"] = query.category;

  const docs = await ExpenseModel.find(filter).sort({ date: -1, createdAt: -1 }).limit(query.limit).lean();
  return docs.map(toView);
}

/** One category's running total across the register's window. */
export interface CategoryTotal {
  category: string;
  total_bdt: string;
  count: number;
}

export interface ExpenseRegister {
  from: string | null;
  to: string | null;
  /** Every row in the window, newest first — the register itself. */
  expenses: ExpenseView[];
  /** Per-category totals for exactly the rows above, largest first. */
  category_totals: CategoryTotal[];
  total_bdt: string;
}

/**
 * The expense register: a filtered window over this person's spending, with the
 * category totals the plan asks the screen to show.
 *
 * One read feeds both the rows and the totals, so the two cannot disagree — a
 * totals card computed from a second query would drift from the table beside it
 * the moment a row was added between them.
 */
export async function expenseRegister(
  uid: string,
  query: z.output<typeof RegisterQuery>,
): Promise<ExpenseRegister> {
  const filter: Record<string, unknown> = { uid };
  if (query.category) filter["category"] = query.category;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const docs = await ExpenseModel.find(filter).sort({ date: -1, createdAt: -1 }).limit(1000).lean();
  const expenses = docs.map(toView);

  const byCategory = new Map<string, { total: Money; count: number }>();
  for (const expense of expenses) {
    const bucket = byCategory.get(expense.category) ?? { total: money("0.00"), count: 0 };
    bucket.total = bucket.total.plus(money(expense.amount_bdt));
    bucket.count += 1;
    byCategory.set(expense.category, bucket);
  }

  const category_totals = [...byCategory.entries()]
    .map(([category, bucket]) => ({
      category,
      total_bdt: fmt(bucket.total),
      count: bucket.count,
    }))
    .sort((a, b) => (money(b.total_bdt).greaterThan(money(a.total_bdt)) ? 1 : -1));

  return {
    from: query.from ?? null,
    to: query.to ?? null,
    expenses,
    category_totals,
    total_bdt: fmt(sum(category_totals.map((row) => money(row.total_bdt)))),
  };
}

/** Every expense in either of two months — exactly what the dashboard needs. */
export async function listExpensesForMonths(uid: string, months: string[]): Promise<ExpenseView[]> {
  const docs = await ExpenseModel.find({ uid, month: { $in: months } })
    .sort({ date: 1, createdAt: 1 })
    .lean();
  return docs.map(toView);
}

/**
 * Create one expense.
 *
 * `orgId` and `ip` exist only to write the audit row — the row itself is still
 * scoped by `uid`, because personal-ledger data is owned by a person and not by
 * an organisation. The two are deliberately not conflated: an accountant being
 * added to an org in a later phase must not thereby gain sight of their
 * colleagues' private groceries.
 */
export async function createExpense(
  uid: string,
  input: CreateExpenseInput,
  orgId: string,
  ip?: string,
): Promise<ExpenseView> {
  // `month` is derived here and nowhere else, so a date and its month can never
  // disagree — the bug that would quietly drop a row out of the dashboard.
  const created = await ExpenseModel.create({
    ...input,
    uid,
    org_id: orgId,
    month: input.date.slice(0, 7),
  });
  const view = toView(created.toObject());

  await writeAudit({
    orgId,
    uid,
    entity: "expense",
    entityId: view.id,
    action: "EXPENSE_CREATED",
    after: view,
    ...(ip ? { ip } : {}),
  });

  // The expense is recorded either way; whether it reached the books is stated
  // on the row rather than assumed.
  const bridged = await bridgeExpense(orgId, uid, ledgerInput(view), ip);
  return { ...view, journal_entry_id: bridged.entry_id };
}

/** The fields the bridge needs, taken from a view so the two cannot drift. */
function ledgerInput(view: ExpenseView): ExpenseForLedger {
  return {
    id: view.id,
    date: view.date,
    category: view.category,
    shop: view.shop,
    amount_bdt: view.amount_bdt,
  };
}

export async function updateExpense(
  uid: string,
  id: string,
  input: UpdateExpenseInput,
  orgId: string,
  ip?: string,
): Promise<ExpenseView> {
  ObjectIdInput.parse(id);

  const patch: Record<string, unknown> = { ...input };
  if (input.date) patch["month"] = input.date.slice(0, 7);

  // Read the previous row first: an audit entry that records only the new value
  // cannot answer "what did this used to be?", which is the question an audit
  // trail exists to answer.
  const previous = await ExpenseModel.findOne({ _id: id, uid }).lean();
  if (!previous) throw notFoundError("That expense does not exist.");
  const before = toView(previous);

  // Only four fields reach the ledger; everything else (the note, the source)
  // is the expense's own. Editing a note must not void an entry and issue a
  // replacement, which would churn the journal for a change the books cannot see.
  //
  // `?? before.x` is PATCH semantics: an omitted field is an unchanged field,
  // and reading it as "became undefined" would mark every note-only edit as a
  // ledger change.
  const changed =
    ledgerShape(before) !==
    ledgerShape({
      date: input.date ?? before.date,
      category: input.category ?? before.category,
      shop: input.shop ?? before.shop,
      amount_bdt: input.amount_bdt ?? before.amount_bdt,
    });

  // Voided BEFORE the row is touched. A void can be refused — the entry's month
  // may have been closed since it was written — and if it is, nothing has
  // changed and the refusal is the whole story. Doing it after the update would
  // leave an edited expense whose books still hold the old amount.
  if (changed && before.journal_entry_id) {
    await voidExpenseEntry({
      orgId,
      uid,
      entryId: before.journal_entry_id,
      reason: "Expense corrected — replaced by a new entry",
      ...(ip ? { ip } : {}),
    });
  }

  // The uid is part of the filter, not just the payload: an authenticated user
  // must not be able to edit another user's row by guessing its id.
  const updated = await ExpenseModel.findOneAndUpdate(
    { _id: id, uid },
    { ...patch, ...(changed ? { journal_entry_id: null } : {}) },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) throw notFoundError("That expense does not exist.");
  const view = toView(updated);

  await writeAudit({
    orgId,
    uid,
    entity: "expense",
    entityId: view.id,
    action: "EXPENSE_UPDATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });

  if (!changed) return view;

  const bridged = await bridgeExpense(orgId, uid, ledgerInput(view), ip);
  return { ...view, journal_entry_id: bridged.entry_id };
}

/** The four fields that decide what the journal entry says. */
function ledgerShape(view: {
  date: string;
  category: string;
  shop: string;
  amount_bdt: string;
}): string {
  return [view.date, view.category, view.shop, view.amount_bdt].join("\u0000");
}

export async function deleteExpense(
  uid: string,
  id: string,
  orgId: string,
  ip?: string,
): Promise<void> {
  ObjectIdInput.parse(id);

  const previous = await ExpenseModel.findOne({ _id: id, uid }).lean();
  if (!previous) throw notFoundError("That expense does not exist.");
  const before = toView(previous);

  // The books are corrected before the row goes, and a refusal stops the delete.
  // Removing the expense first would destroy the only link to an entry that is
  // still sitting in the ledger — the number would stay in the trial balance
  // with nothing left to explain it, which is worse than refusing the delete.
  if (before.journal_entry_id) {
    await voidExpenseEntry({
      orgId,
      uid,
      entryId: before.journal_entry_id,
      reason: "Expense deleted",
      ...(ip ? { ip } : {}),
    });
  }

  const result = await ExpenseModel.deleteOne({ _id: id, uid });
  if (result.deletedCount === 0) throw notFoundError("That expense does not exist.");

  await writeAudit({
    orgId,
    uid,
    entity: "expense",
    entityId: id,
    action: "EXPENSE_DELETED",
    before,
    ...(ip ? { ip } : {}),
  });
}

/* ── The bridge, from the outside ──────────────────────────────────────────── */

export interface ExpenseLedgerStatus {
  total: number;
  unposted: number;
}

/**
 * How much of this person's spending is in the books.
 *
 * `unposted` is not an error count — it is the honest answer to "is the ledger
 * complete?", and the expenses screen shows it rather than letting the dashboard
 * and the trial balance quietly disagree.
 */
export async function expenseLedgerStatus(uid: string): Promise<ExpenseLedgerStatus> {
  const [total, unposted] = await Promise.all([
    ExpenseModel.countDocuments({ uid }),
    ExpenseModel.countDocuments({ uid, journal_entry_id: null }),
  ]);
  return { total, unposted };
}

export interface ExpenseBridgeResult {
  total: number;
  posted: number;
  failed: number;
  /** Fiscal years opened to reach the data. Usually one, sometimes none. */
  opened_years: string[];
  /** Why the ones that failed failed — the first few, verbatim. */
  failures: string[];
}

/**
 * Put every one of this person's unposted expenses into the books.
 *
 * This is the repair path D3's fail-soft behaviour depends on, and it is
 * idempotent: an expense that already has an entry is not in the query, so
 * running it twice posts nothing the second time.
 *
 * Period coverage is arranged once for the whole batch rather than per expense.
 * A case of forty-one expenses spread over two months is one fiscal year, and
 * asking forty-one times would open forty-one.
 */
export async function postExpensesToLedger(
  orgId: string,
  uid: string,
  ip?: string,
): Promise<ExpenseBridgeResult> {
  const pending = await ExpenseModel.find({ uid, journal_entry_id: null }).sort({ date: 1 }).lean();
  if (pending.length === 0) {
    return { total: 0, posted: 0, failed: 0, opened_years: [], failures: [] };
  }

  const opened_years = await ensurePeriodCoverage(
    orgId,
    uid,
    pending.map((row) => String(row.date).slice(0, 7)),
  );

  let posted = 0;
  const failures: string[] = [];

  for (const row of pending) {
    const view = toView(row);
    const bridged = await bridgeExpense(orgId, uid, ledgerInput(view), ip);
    if (bridged.entry_id) {
      posted += 1;
    } else {
      failures.push(`${view.date} · ${view.category} · ${view.shop} — ${bridged.error ?? "unknown"}`);
    }
  }

  await writeAudit({
    orgId,
    uid,
    entity: "expense",
    entityId: "bulk",
    action: "EXPENSES_POSTED_TO_LEDGER",
    after: { posted, failed: failures.length, opened_years },
    ...(ip ? { ip } : {}),
  });

  return {
    total: pending.length,
    posted,
    failed: failures.length,
    opened_years,
    failures: failures.slice(0, 10),
  };
}
