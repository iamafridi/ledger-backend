/**
 * Invoices — the claim side of Accounts Receivable (plan §6, Phase 3).
 *
 * THE DRAFT IS THE POINT
 * An invoice is built as a draft, edited as many times as it takes, and only
 * then issued. Nothing about a draft touches the ledger: no number, no posting,
 * no balance. That is what makes "an abandoned draft leaves no hole in the
 * sequence" true, and it is why `POST /invoices/:id/issue` is a separate act from
 * `POST /invoices` rather than a flag on it. A user who has ten half-finished
 * invoices on a Monday has not put ten numbers into the books.
 *
 * ISSUING IS ONE TRANSACTION
 * The number, the journal entry and the invoice's own status are written
 * together. Half of that — a posted entry behind an invoice still marked DRAFT,
 * or a number claimed for an invoice that never posted — is worse than neither,
 * so the whole act runs in a transaction and rolls back as one.
 *
 * WHAT AN ISSUED INVOICE WILL NOT DO
 * It will not be edited (the lines are immutable once a customer holds it), and
 * it will not be voided while a receipt is allocated to it (plan §6) — unwinding
 * somebody's payment is a business event of its own, not a side effect of
 * correcting an invoice. Both refusals exist so that a number a customer has
 * seen keeps meaning exactly one thing.
 */
import type { ClientSession } from "mongoose";
import { z } from "zod";

import { CreditNoteModel, InvoiceLineModel, InvoiceModel, ReceiptAllocationModel } from "./sales.model.js";
import {
  DocumentLineInput,
  SALE,
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
  partyArBalance,
  partyNamesFor,
  recomputeInvoiceSettlement,
  replaceLines,
  resolveCustomer,
  settlementOf,
  type SalesParty,
} from "./sales.support.js";
import { allocateAdvance, reverseAdjustmentsFor } from "../advances/advance.service.js";
import { inTransaction, postJournal, voidEntry } from "../../core/posting.js";
import { reverseStockForSource, stockOutForInvoice } from "../inventory/stock.service.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, ZERO } from "../../core/money.js";
import { daysBetween } from "../../shared/dates/shift.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { AppError, notFoundError, validationError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

/** Blank, or a real calendar date — and blank means "same as the invoice date",
 *  which is the fallback the aging report reads (plan §6). */
const DueDateInput = z.union([DateInput, z.literal("")]).default("");

export const CreateInvoiceSchema = z.object({
  party_id: ObjectIdInput,
  date: DateInput,
  due_date: DueDateInput,
  memo: z.string().trim().max(500).default(""),
  lines: z.array(DocumentLineInput).min(1, "An invoice needs at least one line.").max(200),
});

export const UpdateInvoiceSchema = z.object({
  party_id: ObjectIdInput.optional(),
  date: DateInput.optional(),
  due_date: DueDateInput.optional(),
  memo: z.string().trim().max(500).optional(),
  lines: z.array(DocumentLineInput).min(1).max(200).optional(),
});

export const ListInvoiceQuery = z.object({
  status: z.enum(["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"]).optional(),
  party_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const VoidInvoiceSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason for voiding this invoice.").max(300),
});

/**
 * The issue request (Phase 10). An invoice may claim part of an advance the
 * customer already holds with us; the amount is supplied at issue because the
 * allocation has to run inside the issuing transaction (plan §6 Phase 10).
 * Nothing else about issuing an invoice takes a body.
 */
export const IssueInvoiceSchema = z.object({
  advance_bdt: MoneyInput.default("0.00"),
});

export type CreateInvoiceInput = z.output<typeof CreateInvoiceSchema>;
export type UpdateInvoiceInput = z.output<typeof UpdateInvoiceSchema>;
export type IssueInvoiceInput = z.output<typeof IssueInvoiceSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface InvoiceView {
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
  credited_bdt: string;
  outstanding_bdt: string;
  /** Days past the due date, or 0. Shown so a list can be sorted by what is
   *  actually late rather than by date and hoped about. */
  days_overdue: number;
  is_overdue: boolean;
  journal_entry_id: string | null;
  void_reason: string;
  lines: DocumentLineView[];
}

/** The party fields `invoiceView` needs, for the list path where the party is
 *  looked up in bulk and only its label is known. */
function labelOnly(partyId: unknown, label: { code: string; name: string } | undefined): SalesParty {
  return {
    id: String(partyId),
    code: label?.code ?? "",
    name: label?.name ?? "",
    control_account_code: "",
    credit_limit_bdt: "0.00",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invoiceView(doc: any, lines: any[], party: SalesParty, today: string): InvoiceView {
  const { paid, credited, outstanding } = settlementOf(doc);
  const dueDate = doc.due_date || doc.date;
  // A voided or fully paid invoice is not overdue — nothing is chasing it — so
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
    credited_bdt: fmt(credited),
    outstanding_bdt: fmt(outstanding),
    days_overdue: overdueDays,
    is_overdue: overdueDays > 0 && outstanding.isPositive(),
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    void_reason: doc.void_reason ?? "",
    lines: lines.map(lineView),
  };
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listInvoices(
  orgId: string,
  query: z.output<typeof ListInvoiceQuery>,
): Promise<InvoiceView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.status) filter["status"] = query.status;
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await InvoiceModel.find(filter)
    .sort({ date: -1, doc_seq: -1, createdAt: -1 })
    .limit(query.limit)
    .lean();
  if (rows.length === 0) return [];

  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));
  const today = todayInLedgerZone();

  // Lines for the whole page in one read, grouped in memory: the list shows
  // every line, and a query per invoice would make a 100-row page 101 queries.
  const lineRows = await InvoiceLineModel.find({
    org_id: orgId,
    doc_type: "INVOICE",
    doc_id: { $in: rows.map((row) => row._id) },
  })
    .sort({ sort_order: 1 })
    .lean();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byInvoice = new Map<string, any[]>();
  for (const line of lineRows) {
    const key = String(line.doc_id);
    const bucket = byInvoice.get(key);
    if (bucket) bucket.push(line);
    else byInvoice.set(key, [line]);
  }

  return rows.map((row) =>
    invoiceView(
      row,
      byInvoice.get(String(row._id)) ?? [],
      labelOnly(row.party_id, names.get(String(row.party_id))),
      today,
    ),
  );
}

/** One invoice with its lines and its live settlement. */
export async function getInvoice(orgId: string, id: string): Promise<InvoiceView> {
  assertObjectId(id, "That invoice does not exist.");

  const doc = await InvoiceModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That invoice does not exist.");

  const [lines, party] = await Promise.all([
    loadLines(orgId, "INVOICE", id),
    resolveCustomer(orgId, String(doc.party_id)),
  ]);

  return invoiceView(doc, lines, party, todayInLedgerZone());
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export async function createInvoice(
  orgId: string,
  uid: string,
  input: CreateInvoiceInput,
): Promise<InvoiceView> {
  const party = await resolveCustomer(orgId, input.party_id);

  // Resolved before anything is written: a document that fails validation must
  // leave no rows behind, and a draft holding unresolvable lines would fail
  // later, at issue, when somebody senior is watching.
  const lines = await resolveLines(orgId, input.lines, SALE);
  const totals = totalsOf(lines);
  assertTotalsUsable(totals);

  return inTransaction(async (session) => {
    const created = await InvoiceModel.create(
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
          credited_bdt: "0.00",
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    await replaceLines(orgId, "INVOICE", String(created._id), lineDocs(lines), session);

    const view = invoiceView(
      created.toObject(),
      await loadLines(orgId, "INVOICE", String(created._id), session),
      party,
      todayInLedgerZone(),
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.invoice",
        entityId: view.id,
        action: "INVOICE_DRAFTED",
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
 * Only a draft: an issued invoice is a document somebody has been given, and the
 * only way to change one is to void it and issue another — which is what makes
 * the number on the customer's copy trustworthy. The line set and the totals
 * derived from it are rewritten together.
 */
export async function updateInvoice(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceView> {
  assertObjectId(id, "That invoice does not exist.");

  const existing = await InvoiceModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That invoice does not exist.");
  if (existing.status !== "DRAFT") {
    throw new AppError(
      409,
      "INVOICE_NOT_EDITABLE",
      existing.status === "VOID"
        ? "That invoice was voided and cannot be edited."
        : "That invoice has been issued. Void it and raise a corrected invoice — the number on the customer's copy must keep meaning what it says.",
    );
  }

  const patch: Record<string, unknown> = {};
  if (input.party_id !== undefined) patch["party_id"] = (await resolveCustomer(orgId, input.party_id)).id;
  if (input.date !== undefined) patch["date"] = input.date;
  if (input.due_date !== undefined) patch["due_date"] = input.due_date;
  if (input.memo !== undefined) patch["memo"] = input.memo;

  const replacement = input.lines !== undefined ? await resolveLines(orgId, input.lines, SALE) : null;
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
      await replaceLines(orgId, "INVOICE", id, lineDocs(replacement), session);
    }

    const updated = await InvoiceModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: "DRAFT" },
      { $set: patch },
      { new: true, runValidators: true, session },
    ).lean();
    if (!updated) throw notFoundError("That invoice does not exist.");

    const view = invoiceView(
      updated,
      await loadLines(orgId, "INVOICE", id, session),
      await resolveCustomer(orgId, String(updated.party_id)),
      todayInLedgerZone(),
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.invoice",
        entityId: view.id,
        action: "INVOICE_UPDATED",
        before: { party_id: String(existing.party_id), total_bdt: existing.total_bdt },
        after: { party_id: view.party_id, total_bdt: view.total_bdt, line_count: view.lines.length },
      },
      session,
    );

    return view;
  });
}

/** Discard a draft. Only a draft: an issued invoice is voided, never deleted,
 *  because a number a customer may already hold cannot be un-issued. */
export async function deleteInvoice(orgId: string, uid: string, id: string): Promise<void> {
  assertObjectId(id, "That invoice does not exist.");

  const existing = await InvoiceModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That invoice does not exist.");
  if (existing.status !== "DRAFT") {
    throw new AppError(
      409,
      "INVOICE_NOT_DELETABLE",
      "Only a draft can be discarded. An issued invoice is voided instead, so the number it claimed stays accounted for.",
    );
  }

  await inTransaction(async (session) => {
    await InvoiceLineModel.deleteMany({ org_id: orgId, doc_type: "INVOICE", doc_id: id }, { session });
    await InvoiceModel.deleteOne({ _id: id, org_id: orgId }, { session });

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.invoice",
        entityId: id,
        action: "INVOICE_DRAFT_DISCARDED",
        before: { party_id: String(existing.party_id), total_bdt: existing.total_bdt },
      },
      session,
    );
  });
}

export interface IssueResult {
  invoice: InvoiceView;
  warnings: DocumentWarning[];
}

/**
 * Issue: claim a number, post the receivable, mark the invoice ISSUED.
 *
 * All three in one transaction. The credit-limit and due-date warnings are
 * computed *after* the posting and returned alongside it — they are advice, and
 * a ledger that refused a sale because somebody had not set a limit would be
 * making the warning the problem.
 */
export async function issueInvoice(
  orgId: string,
  uid: string,
  id: string,
  input: IssueInvoiceInput,
  ip?: string,
): Promise<IssueResult> {
  assertObjectId(id, "That invoice does not exist.");

  return inTransaction(async (session) => {
    const invoice = await InvoiceModel.findOne({ _id: id, org_id: orgId })
      .session(session)
      .lean();
    if (!invoice) throw notFoundError("That invoice does not exist.");
    if (invoice.status === "VOID") {
      throw new AppError(409, "INVOICE_VOID", "That invoice was voided and cannot be issued.");
    }
    if (invoice.status !== "DRAFT") {
      throw new AppError(409, "ALREADY_ISSUED", "That invoice has already been issued.");
    }

    const party = await resolveCustomer(orgId, String(invoice.party_id));
    const lines = await loadLines(orgId, "INVOICE", id);
    if (lines.length === 0) {
      throw validationError("This invoice has no lines. Add at least one before issuing it.");
    }

    const totals = totalsOf(lines);
    assertTotalsUsable(totals);
    if (money(totals.total_bdt).isZero()) {
      throw validationError(
        "This invoice totals zero, so there is nothing to post. Add a line, or discard the draft.",
      );
    }

    // Phase 10: an advance may claim at most the invoice's own total. An
    // invoice settled for more than it is for would leave the customer's
    // balance negative on this document, which no report expects.
    const advance = money(input.advance_bdt ?? "0.00");
    const invoiceTotal = money(totals.total_bdt);
    if (advance.greaterThan(invoiceTotal)) {
      throw new AppError(
        422,
        "ADVANCE_EXCEEDS_DOCUMENT",
        `The advance of ${fmt(advance)} is more than the invoice total of ${fmt(invoiceTotal)}. An invoice cannot be settled for more than it is for.`,
      );
    }

    const allocation = await allocateNumber(orgId, "invoice", invoice.date);
    const description = `Invoice ${allocation.number} — ${party.name}`;

    // The cost of the goods leaving the shelf, appended to the same entry as the
    // revenue they earned. One sale, one entry: an invoice that posted its
    // revenue and its COGS separately would be two figures a reader has to join
    // up by hand to see the margin on it (plan §6 Phase 8).
    //
    // A line for an item that is not stock-tracked contributes nothing, and a
    // sale that leaves the shelf empty is refused here — before the entry, so
    // the refusal costs nothing.
    const cost = await stockOutForInvoice(
      orgId,
      uid,
      { id, date: invoice.date, docNo: allocation.number, lines },
      session,
    );

    const entry = await postJournal(
      {
        orgId,
        uid,
        date: invoice.date,
        description,
        source: "INVOICE",
        source_id: id,
        lines: [
          ...documentPostingLines(lines, {
            profile: SALE,
            controlAccountCode: party.control_account_code,
            controlAccountName: "Accounts Receivable",
            partyId: party.id,
            memo: description,
          }),
          ...cost,
        ],
        ...(ip ? { ip } : {}),
      },
      session,
    );

    // The DRAFT in the filter is optimistic concurrency: if another request
    // issued this invoice a moment ago, no row matches and the whole transaction
    // (including the entry just written) rolls back rather than posting twice.
    const updated = await InvoiceModel.findOneAndUpdate(
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
          credited_bdt: "0.00",
          journal_entry_id: entry.id,
          issued_by: uid,
          issued_at: new Date(),
        },
      },
      { new: true, session },
    ).lean();

    if (!updated) {
      throw new AppError(409, "ALREADY_ISSUED", "That invoice was issued by another request a moment ago.");
    }

    // Phase 10: claim the advance the customer is holding with us, inside this
    // same transaction. The money arrived when their receipt (or a manual
    // advance) posted; this only says which invoice it settles, so it posts
    // nothing and the control account does not move. A later failure rolls the
    // claim back with everything else (ADR 0004 §3).
    if (advance.greaterThan(ZERO)) {
      await allocateAdvance(
        orgId,
        uid,
        party,
        advance,
        { type: "INVOICE", id, no: allocation.number, date: invoice.date },
        session,
      );
      // The claim settled part or all of this invoice, so the cache and status
      // are rewritten before the view, the credit-limit warning and any later
      // allocation picker read them — otherwise the invoice would still offer
      // its full total to the next receipt.
      await recomputeInvoiceSettlement(orgId, id, session);
    }

    const issued = advance.greaterThan(ZERO)
      ? ((await InvoiceModel.findOne({ _id: id, org_id: orgId }).session(session).lean()) ?? updated)
      : updated;
    const view = invoiceView(issued, lines, party, todayInLedgerZone());
    const warnings = await issueWarnings(orgId, party, view, session);
    if (advance.greaterThan(ZERO)) {
      warnings.push({
        code: "ADVANCE_APPLIED",
        message: `${fmt(advance)} was claimed from ${party.name}'s advance held with us.`,
      });
    }

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.invoice",
        entityId: view.id,
        action: "INVOICE_ISSUED",
        after: { doc_no: view.doc_no, total_bdt: view.total_bdt, journal_entry_id: view.journal_entry_id },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return { invoice: view, warnings };
  });
}

/** Advice, never a refusal: this sale has happened, and the person should know
 *  what it did to the customer's exposure and whether it was already late. */
async function issueWarnings(
  orgId: string,
  party: SalesParty,
  invoice: InvoiceView,
  session: ClientSession,
): Promise<DocumentWarning[]> {
  const warnings: DocumentWarning[] = [];
  const today = todayInLedgerZone();

  if (invoice.due_date && invoice.due_date < invoice.date) {
    warnings.push({
      code: "DUE_BEFORE_ISSUE",
      message: `The due date (${invoice.due_date}) is before the invoice date (${invoice.date}). Check which one you meant.`,
    });
  } else if (invoice.due_date && invoice.due_date < today) {
    warnings.push({
      code: "ALREADY_OVERDUE",
      message: `This invoice is already past its due date of ${invoice.due_date}.`,
    });
  }

  const limit = money(party.credit_limit_bdt);
  if (limit.isPositive()) {
    const balance = await partyArBalance(orgId, party.id, session);
    if (balance.greaterThan(limit)) {
      warnings.push({
        code: "CREDIT_LIMIT",
        message: `${party.name} now owes ${fmt(balance)} against a credit limit of ${fmt(limit)}.`,
      });
    }
  }

  return warnings;
}

/**
 * Void an issued invoice.
 *
 * Refused while a receipt is allocated to it (plan §6). The money would have to
 * be un-received, and a receipt that has already been banked cannot be undone by
 * correcting an invoice — that is a refund, and a refund is its own document.
 *
 * Also refused while an issued credit note corrects it: the credit note has
 * already reversed part of this invoice's revenue, and voiding the invoice on
 * top of that would reverse it twice. Void the credit note first.
 */
export async function voidInvoice(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<InvoiceView> {
  assertObjectId(id, "That invoice does not exist.");

  return inTransaction(async (session) => {
    const invoice = await InvoiceModel.findOne({ _id: id, org_id: orgId })
      .session(session)
      .lean();
    if (!invoice) throw notFoundError("That invoice does not exist.");
    if (invoice.status === "DRAFT") {
      throw new AppError(
        409,
        "INVOICE_IS_DRAFT",
        "That invoice is still a draft — discard it instead of voiding it.",
      );
    }
    if (invoice.status === "VOID") {
      throw new AppError(409, "INVOICE_VOID", "That invoice has already been voided.");
    }

    const [allocated, credited] = await Promise.all([
      ReceiptAllocationModel.countDocuments({ org_id: orgId, invoice_id: id }).session(session),
      CreditNoteModel.countDocuments({ org_id: orgId, invoice_id: id, status: "ISSUED" }).session(session),
    ]);

    if (allocated > 0) {
      throw new AppError(
        409,
        "RECEIPTS_ALLOCATED",
        `A receipt is allocated to ${invoice.doc_no ?? "this invoice"}. Unwinding a customer's payment is a refund, not a correction — deal with the receipt first.`,
      );
    }
    if (credited > 0) {
      throw new AppError(
        409,
        "CREDIT_NOTES_EXIST",
        `An issued credit note corrects ${invoice.doc_no ?? "this invoice"}. Void that credit note first, or the revenue would be reversed twice.`,
      );
    }

    // Phase 10: any advance this invoice claimed goes back to the customer's
    // balance. The engine deletes its adjustment rows transactionally and the
    // audit row keeps the history, so cancelling an invoice restores exactly the
    // advances it had consumed (ADR 0004 §4). A no-op when it claimed none.
    await reverseAdjustmentsFor(orgId, uid, "INVOICE", id, session);

    // The goods go back on the shelf first, as the mirror of the movement the
    // sale made — the same quantity and the same value, so the reversal of the
    // COGS posting and the stock movement agree to the paisa (plan §6 Phase 8).
    await reverseStockForSource(orgId, uid, "INVOICE", id, reason, session);

    // The entry is voided (a reversal is written), not deleted, so the journal
    // shows what happened and why rather than a gap.
    if (invoice.journal_entry_id) {
      await voidEntry(orgId, uid, String(invoice.journal_entry_id), reason, ip, session);
    }

    const updated = await InvoiceModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: { $ne: "VOID" } },
      { $set: { status: "VOID", void_reason: reason.trim(), paid_bdt: "0.00", credited_bdt: "0.00" } },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "INVOICE_VOID", "That invoice was voided by another request a moment ago.");
    }

    const view = invoiceView(
      updated,
      await loadLines(orgId, "INVOICE", id),
      await resolveCustomer(orgId, String(updated.party_id)),
      todayInLedgerZone(),
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.invoice",
        entityId: view.id,
        action: "INVOICE_VOIDED",
        before: { status: invoice.status, doc_no: invoice.doc_no, total_bdt: invoice.total_bdt },
        after: { status: "VOID", reason: reason.trim() },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}
