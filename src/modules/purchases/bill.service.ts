/**
 * Bills — the claim side of Accounts Payable (plan §6, Phase 4).
 *
 * THE DRAFT IS THE POINT
 * A bill is built as a draft, edited as many times as it takes, and only then
 * issued. Nothing about a draft touches the ledger: no number, no posting, no
 * balance. That is what makes "an abandoned draft leaves no hole in the
 * sequence" true, and it is why `POST /bills/:id/issue` is a separate act from
 * `POST /bills`, rather than a flag on it.
 *
 * ISSUING IS ONE TRANSACTION
 * The number, the journal entry and the bill's own status are written together.
 * Half of that — a posted entry behind a bill still marked DRAFT, or a number
 * claimed for a bill that never posted — is worse than neither, so the whole act
 * runs in a transaction and rolls back as one.
 *
 * WHAT AN ISSUED BILL WILL NOT DO
 * It will not be edited (the lines are immutable once the supplier's document
 * has been entered), and it will not be voided while a payment is allocated to
 * it — clawing back money we have already paid out is a business event of its
 * own, not a side effect of correcting a bill.
 *
 * WHAT POSTS
 * `DR expense accounts (+ input VAT) / CR the supplier's AP control account`,
 * which is the mirror of an invoice. The accounts a line may name are restricted
 * to expense accounts, and `PURCHASE` in `core/document-lines.ts` explains why
 * inventory and fixed assets are deliberately not admitted yet.
 */
import { z } from "zod";

import { BillLineModel, BillModel, DebitNoteModel, PaymentAllocationModel } from "./purchases.model.js";
import {
  DocumentLineInput,
  PURCHASE,
  assertTotalsUsable,
  documentPostingLines,
  lineDocs,
  lineView,
  resolveLines,
  totalsOf,
  type DocumentLineView,
  type DocumentWarning,
} from "../../core/document-lines.js";
import {
  loadLines,
  partyNamesFor,
  recomputeBillSettlement,
  replaceLines,
  resolveSupplier,
  settlementOf,
  type PurchasesParty,
} from "./purchases.support.js";
import { allocateAdvance, reverseAdjustmentsFor } from "../advances/advance.service.js";
import { inTransaction, postJournal, voidEntry } from "../../core/posting.js";
import { reverseStockForSource, stockInFromBill } from "../inventory/stock.service.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, ZERO } from "../../core/money.js";
import { daysBetween } from "../../shared/dates/shift.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { AppError, notFoundError, validationError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

/** Blank, or a real calendar date — and blank means "same as the bill date",
 *  which is the fallback the aging report reads (plan §6). */
const DueDateInput = z.union([DateInput, z.literal("")]).default("");

export const CreateBillSchema = z.object({
  party_id: ObjectIdInput,
  date: DateInput,
  due_date: DueDateInput,
  memo: z.string().trim().max(500).default(""),
  lines: z.array(DocumentLineInput).min(1, "A bill needs at least one line.").max(200),
});

export const UpdateBillSchema = z.object({
  party_id: ObjectIdInput.optional(),
  date: DateInput.optional(),
  due_date: DueDateInput.optional(),
  memo: z.string().trim().max(500).optional(),
  lines: z.array(DocumentLineInput).min(1).max(200).optional(),
});

export const ListBillQuery = z.object({
  status: z.enum(["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"]).optional(),
  party_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});export const VoidBillSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason for voiding this bill.").max(300),
});

/** The issue request (Phase 10): how much of a prepayment this bill claims. See
 *  `IssueInvoiceSchema` — the mirror on the sales side. */
export const IssueBillSchema = z.object({
  advance_bdt: MoneyInput.default("0.00"),
});

export type CreateBillInput = z.output<typeof CreateBillSchema>;
export type UpdateBillInput = z.output<typeof UpdateBillSchema>;
export type IssueBillInput = z.output<typeof IssueBillSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface BillView {
  id: string;
  doc_no: string | null;
  party_id: string;
  party_code: string;
  party_name: string;
  date: string;
  due_date: string;
  memo: string;
  status: "DRAFT" | "ISSUED" | "PARTIALLY_PAID" | "PAID" | "VOID";
  subtotal_bdt: string;
  discount_total_bdt: string;
  tax_total_bdt: string;
  total_bdt: string;
  paid_bdt: string;
  debited_bdt: string;
  outstanding_bdt: string;
  /** Days past the due date, or 0. Shown so a list can be sorted by what is
   *  actually late rather than by date and hoped about. */
  days_overdue: number;
  is_overdue: boolean;
  journal_entry_id: string | null;
  void_reason: string;
  lines: DocumentLineView[];
}

/** The party fields `billView` needs, for the list path where the party is
 *  looked up in bulk and only its label is known. */
function labelOnly(partyId: unknown, label: { code: string; name: string } | undefined): PurchasesParty {
  return {
    id: String(partyId),
    code: label?.code ?? "",
    name: label?.name ?? "",
    control_account_code: "",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function billView(doc: any, lines: any[], party: PurchasesParty, today: string): BillView {
  const { paid, debited, outstanding } = settlementOf(doc);
  const dueDate = doc.due_date || doc.date;
  // A voided or fully settled bill is not overdue — nothing is chasing it — so
  // the days are zeroed rather than shown as history nobody acts on.
  const overdueDays =
    doc.status === "VOID" || doc.status === "PAID" ? 0 : Math.max(0, daysBetween(dueDate, today));

  return {
    id: String(doc._id),
    doc_no: doc.doc_no ?? null,
    party_id: String(doc.party_id),
    party_code: party.code,
    party_name: party.name,
    date: doc.date,
    due_date: doc.due_date ?? "",
    memo: doc.memo ?? "",
    status: doc.status,
    subtotal_bdt: doc.subtotal_bdt,
    discount_total_bdt: doc.discount_total_bdt,
    tax_total_bdt: doc.tax_total_bdt,
    total_bdt: doc.total_bdt,
    paid_bdt: fmt(paid),
    debited_bdt: fmt(debited),
    outstanding_bdt: fmt(outstanding),
    days_overdue: overdueDays,
    is_overdue: overdueDays > 0 && outstanding.isPositive(),
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    void_reason: doc.void_reason ?? "",
    lines: lines.map(lineView),
  };
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listBills(
  orgId: string,
  query: z.output<typeof ListBillQuery>,
): Promise<BillView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.status) filter["status"] = query.status;
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await BillModel.find(filter)
    .sort({ date: -1, doc_seq: -1, createdAt: -1 })
    .limit(query.limit)
    .lean();
  if (rows.length === 0) return [];

  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));
  const today = todayInLedgerZone();

  // Lines for the whole page in one read, grouped in memory: the list shows
  // every line, and a query per bill would make a 100-row page 101 queries.
  const lineRows = await BillLineModel.find({
    org_id: orgId,
    doc_type: "BILL",
    doc_id: { $in: rows.map((row) => row._id) },
  })
    .sort({ sort_order: 1 })
    .lean();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byBill = new Map<string, any[]>();
  for (const line of lineRows) {
    const key = String(line.doc_id);
    const bucket = byBill.get(key);
    if (bucket) bucket.push(line);
    else byBill.set(key, [line]);
  }

  return rows.map((row) =>
    billView(
      row,
      byBill.get(String(row._id)) ?? [],
      labelOnly(row.party_id, names.get(String(row.party_id))),
      today,
    ),
  );
}

/** One bill with its lines and its live settlement. */
export async function getBill(orgId: string, id: string): Promise<BillView> {
  assertObjectId(id, "That bill does not exist.");

  const doc = await BillModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That bill does not exist.");

  const [lines, party] = await Promise.all([
    loadLines(orgId, "BILL", id),
    resolveSupplier(orgId, String(doc.party_id)),
  ]);

  return billView(doc, lines, party, todayInLedgerZone());
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export async function createBill(
  orgId: string,
  uid: string,
  input: CreateBillInput,
): Promise<BillView> {
  const party = await resolveSupplier(orgId, input.party_id);

  // Resolved before anything is written: a document that fails validation must
  // leave no rows behind, and a draft holding unresolvable lines would fail
  // later, at issue, when somebody senior is watching.
  const lines = await resolveLines(orgId, input.lines, PURCHASE);
  const totals = totalsOf(lines);
  assertTotalsUsable(totals);

  return inTransaction(async (session) => {
    const created = await BillModel.create(
      [
        {
          org_id: orgId,
          doc_no: null,
          party_id: party.id,
          date: input.date,
          due_date: input.due_date,
          memo: input.memo,
          status: "DRAFT",
          ...totals,
          paid_bdt: "0.00",
          debited_bdt: "0.00",
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    await replaceLines(orgId, "BILL", String(created._id), lineDocs(lines), session);

    const view = billView(
      created.toObject(),
      await loadLines(orgId, "BILL", String(created._id), session),
      party,
      todayInLedgerZone(),
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.bill",
        entityId: view.id,
        action: "BILL_DRAFTED",
        after: { party_id: view.party_id, total_bdt: view.total_bdt, line_count: view.lines.length },
      },
      session,
    );

    return view;
  });
}

/**
 * Edit a draft.
 *
 * Only a draft: an issued bill is a document that has been entered against the
 * supplier's statement, and the only way to change one is to void it and enter
 * another — which is what makes the number on it trustworthy. The line set and
 * the totals derived from it are rewritten together.
 */
export async function updateBill(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateBillInput,
): Promise<BillView> {
  assertObjectId(id, "That bill does not exist.");

  const existing = await BillModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That bill does not exist.");
  if (existing.status !== "DRAFT") {
    throw new AppError(
      409,
      "BILL_NOT_EDITABLE",
      existing.status === "VOID"
        ? "That bill was voided and cannot be edited."
        : "That bill has been issued. Void it and enter a corrected bill — the number it claimed must keep meaning what it says.",
    );
  }

  const patch: Record<string, unknown> = {};
  if (input.party_id !== undefined) patch["party_id"] = (await resolveSupplier(orgId, input.party_id)).id;
  if (input.date !== undefined) patch["date"] = input.date;
  if (input.due_date !== undefined) patch["due_date"] = input.due_date;
  if (input.memo !== undefined) patch["memo"] = input.memo;

  const replacement = input.lines !== undefined ? await resolveLines(orgId, input.lines, PURCHASE) : null;
  if (replacement) {
    const totals = totalsOf(replacement);
    assertTotalsUsable(totals);
    Object.assign(patch, totals);
  }

  // The lines and the totals derived from them are written together: a draft
  // holding line rows that do not sum to its own totals is a document that
  // prints one number and posts another.
  return inTransaction(async (session) => {
    if (replacement) {
      await replaceLines(orgId, "BILL", id, lineDocs(replacement), session);
    }

    const updated = await BillModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: "DRAFT" },
      { $set: patch },
      { new: true, runValidators: true, session },
    ).lean();
    if (!updated) throw notFoundError("That bill does not exist.");

    const view = billView(
      updated,
      await loadLines(orgId, "BILL", id, session),
      await resolveSupplier(orgId, String(updated.party_id)),
      todayInLedgerZone(),
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.bill",
        entityId: view.id,
        action: "BILL_UPDATED",
        before: { party_id: String(existing.party_id), total_bdt: existing.total_bdt },
        after: { party_id: view.party_id, total_bdt: view.total_bdt, line_count: view.lines.length },
      },
      session,
    );

    return view;
  });
}

/** Discard a draft. Only a draft: an issued bill is voided, never deleted,
 *  because a number the supplier may already have been given cannot be
 *  un-issued. */
export async function deleteBill(orgId: string, uid: string, id: string): Promise<void> {
  assertObjectId(id, "That bill does not exist.");

  const existing = await BillModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That bill does not exist.");
  if (existing.status !== "DRAFT") {
    throw new AppError(
      409,
      "BILL_NOT_DELETABLE",
      "Only a draft can be discarded. An issued bill is voided instead, so the number it claimed stays accounted for.",
    );
  }

  await inTransaction(async (session) => {
    await BillLineModel.deleteMany({ org_id: orgId, doc_type: "BILL", doc_id: id }, { session });
    await BillModel.deleteOne({ _id: id, org_id: orgId }, { session });

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.bill",
        entityId: id,
        action: "BILL_DRAFT_DISCARDED",
        before: { party_id: String(existing.party_id), total_bdt: existing.total_bdt },
      },
      session,
    );
  });
}

export interface IssueResult {
  bill: BillView;
  warnings: DocumentWarning[];
}

/**
 * Issue: claim a number, post the payable, mark the bill ISSUED.
 *
 * All three in one transaction. The due-date warnings are computed *after* the
 * posting and returned alongside it — they are advice, and a ledger that refused
 * to record a bill because it had already fallen due would be making the warning
 * the problem.
 */
export async function issueBill(
  orgId: string,
  uid: string,
  id: string,
  input: IssueBillInput,
  ip?: string,
): Promise<IssueResult> {
  assertObjectId(id, "That bill does not exist.");

  return inTransaction(async (session) => {
    const bill = await BillModel.findOne({ _id: id, org_id: orgId })
      .session(session)
      .lean();
    if (!bill) throw notFoundError("That bill does not exist.");
    if (bill.status === "VOID") {
      throw new AppError(409, "BILL_VOID", "That bill was voided and cannot be issued.");
    }
    if (bill.status !== "DRAFT") {
      throw new AppError(409, "ALREADY_ISSUED", "That bill has already been issued.");
    }

    const party = await resolveSupplier(orgId, String(bill.party_id));
    const lines = await loadLines(orgId, "BILL", id);
    if (lines.length === 0) {
      throw validationError("This bill has no lines. Add at least one before issuing it.");
    }

    const totals = totalsOf(lines);
    assertTotalsUsable(totals);
    if (money(totals.total_bdt).isZero()) {
      throw validationError(
        "This bill totals zero, so there is nothing to post. Add a line, or discard the draft.",
      );
    }

    // Phase 10: a prepayment may claim at most the bill's own total.
    const advance = money(input.advance_bdt ?? "0.00");
    const billTotal = money(totals.total_bdt);
    if (advance.greaterThan(billTotal)) {
      throw new AppError(
        422,
        "ADVANCE_EXCEEDS_DOCUMENT",
        `The prepayment of ${fmt(advance)} is more than the bill total of ${fmt(billTotal)}. A bill cannot be settled for more than it is for.`,
      );
    }

    const allocation = await allocateNumber(orgId, "bill", bill.date);
    const description = `Bill ${allocation.number} — ${party.name}`;

    const entry = await postJournal(
      {
        orgId,
        uid,
        date: bill.date,
        description,
        source: "BILL",
        source_id: id,
        lines: documentPostingLines(lines, {
          profile: PURCHASE,
          controlAccountCode: party.control_account_code,
          controlAccountName: "Accounts Payable",
          partyId: party.id,
          memo: description,
        }),
        ...(ip ? { ip } : {}),
      },
      session,
    );

    // What this bill put on the shelf. The debit to inventory is already in the
    // entry above — this is the stock ledger's copy of the same fact, written
    // from the same line, which is what makes `I5-STOCK` an equality to the
    // paisa rather than a comparison somebody hopes holds (plan §6 Phase 8).
    // A line billed straight to an expense account moves no stock, by design.
    await stockInFromBill(orgId, uid, { id, date: bill.date, docNo: allocation.number, lines }, session);

    // The DRAFT in the filter is optimistic concurrency: if another request
    // issued this bill a moment ago, no row matches and the whole transaction
    // (including the entry just written) rolls back rather than posting twice.
    const updated = await BillModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: "DRAFT" },
      {
        $set: {
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          status: "ISSUED",
          subtotal_bdt: totals.subtotal_bdt,
          discount_total_bdt: totals.discount_total_bdt,
          tax_total_bdt: totals.tax_total_bdt,
          total_bdt: totals.total_bdt,
          paid_bdt: "0.00",
          debited_bdt: "0.00",
          journal_entry_id: entry.id,
          issued_by: uid,
          issued_at: new Date(),
        },
      },
      { new: true, session },
    ).lean();

    if (!updated) {
      throw new AppError(409, "ALREADY_ISSUED", "That bill was issued by another request a moment ago.");
    }

    // Phase 10: claim the prepayment we are holding with this supplier, inside
    // this same transaction. The money left when our payment (or a manual
    // prepayment) posted; this only says which bill it settles, so it posts
    // nothing and the control account does not move (ADR 0004 §3).
    if (advance.greaterThan(ZERO)) {
      await allocateAdvance(
        orgId,
        uid,
        party,
        advance,
        { type: "BILL", id, no: allocation.number, date: bill.date },
        session,
      );
      // The claim settled part or all of this bill, so the cache and status are
      // rewritten before the view and any later allocation picker read them —
      // otherwise the bill would still offer its full total to the next payment.
      await recomputeBillSettlement(orgId, id, session);
    }

    const issued = advance.greaterThan(ZERO)
      ? ((await BillModel.findOne({ _id: id, org_id: orgId }).session(session).lean()) ?? updated)
      : updated;
    const view = billView(issued, lines, party, todayInLedgerZone());
    const warnings = issueWarnings(view);
    if (advance.greaterThan(ZERO)) {
      warnings.push({
        code: "ADVANCE_APPLIED",
        message: `${fmt(advance)} was claimed from the prepayment held with ${party.name}.`,
      });
    }

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.bill",
        entityId: view.id,
        action: "BILL_ISSUED",
        after: { doc_no: view.doc_no, total_bdt: view.total_bdt, journal_entry_id: view.journal_entry_id },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return { bill: view, warnings };
  });
}

/** Advice, never a refusal: this bill is ours to pay, and the person entering it
 *  should know if it was already late before it reached the ledger. */
function issueWarnings(bill: BillView): DocumentWarning[] {
  const warnings: DocumentWarning[] = [];
  const today = todayInLedgerZone();

  if (bill.due_date && bill.due_date < bill.date) {
    warnings.push({
      code: "DUE_BEFORE_ISSUE",
      message: `The due date (${bill.due_date}) is before the bill date (${bill.date}). Check which one you meant.`,
    });
  } else if (bill.due_date && bill.due_date < today) {
    warnings.push({
      code: "ALREADY_OVERDUE",
      message: `This bill is already past its due date of ${bill.due_date}. It will appear in the oldest aging bucket.`,
    });
  }

  return warnings;
}

/**
 * Void an issued bill.
 *
 * Refused while a payment is allocated to it. The money would have to be
 * un-paid, and a payment already made to a supplier cannot be undone by
 * correcting a bill — that is a refund or a credit, and a credit from a supplier
 * is a debit note.
 *
 * Also refused while an issued debit note corrects it: the debit note has
 * already reversed part of this bill's expense, and voiding the bill on top of
 * that would reverse it twice. Void the debit note first.
 */
export async function voidBill(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<BillView> {
  assertObjectId(id, "That bill does not exist.");

  return inTransaction(async (session) => {
    const bill = await BillModel.findOne({ _id: id, org_id: orgId })
      .session(session)
      .lean();
    if (!bill) throw notFoundError("That bill does not exist.");
    if (bill.status === "DRAFT") {
      throw new AppError(409, "BILL_IS_DRAFT", "That bill is still a draft — discard it instead of voiding it.");
    }
    if (bill.status === "VOID") {
      throw new AppError(409, "BILL_VOID", "That bill has already been voided.");
    }

    const [allocated, debited] = await Promise.all([
      PaymentAllocationModel.countDocuments({ org_id: orgId, bill_id: id }).session(session),
      DebitNoteModel.countDocuments({ org_id: orgId, bill_id: id, status: "ISSUED" }).session(session),
    ]);

    if (allocated > 0) {
      throw new AppError(
        409,
        "PAYMENTS_ALLOCATED",
        `A payment is allocated to ${bill.doc_no ?? "this bill"}. Clawing back money already paid to a supplier is a refund, not a correction — deal with the payment first.`,
      );
    }
    if (debited > 0) {
      throw new AppError(
        409,
        "DEBIT_NOTES_EXIST",
        `An issued debit note corrects ${bill.doc_no ?? "this bill"}. Void that debit note first, or the expense would be reversed twice.`,
      );
    }

    // Phase 10: any prepayment this bill claimed returns to the supplier's
    // balance. The engine deletes its adjustment rows transactionally and the
    // audit row keeps the history (ADR 0004 §4). A no-op when it claimed none.
    await reverseAdjustmentsFor(orgId, uid, "BILL", id, session);

    // Take the goods back off the shelf before the entry is reversed. If they
    // have already been sold this refuses the whole void: a bill cannot be
    // un-received once its stock has left, because the cost of that sale came
    // from goods that would then be imaginary (plan §6 Phase 8).
    await reverseStockForSource(orgId, uid, "BILL", id, reason, session);

    // The entry is voided (a reversal is written), not deleted, so the journal
    // shows what happened and why rather than a gap.
    if (bill.journal_entry_id) {
      await voidEntry(orgId, uid, String(bill.journal_entry_id), reason, ip, session);
    }

    const updated = await BillModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: { $ne: "VOID" } },
      { $set: { status: "VOID", void_reason: reason.trim(), paid_bdt: "0.00", debited_bdt: "0.00" } },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "BILL_VOID", "That bill was voided by another request a moment ago.");
    }

    const view = billView(
      updated,
      await loadLines(orgId, "BILL", id),
      await resolveSupplier(orgId, String(updated.party_id)),
      todayInLedgerZone(),
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.bill",
        entityId: view.id,
        action: "BILL_VOIDED",
        before: { status: bill.status, doc_no: bill.doc_no, total_bdt: bill.total_bdt },
        after: { status: "VOID", reason: reason.trim() },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}
