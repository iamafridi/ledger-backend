/**
 * Credit notes — giving part of a claim back (plan §6, Phase 3).
 *
 * A credit note is the invoice's arithmetic pointed the other way: the same
 * quantity, price, discount and tax, posting `DR revenue (+ VAT) / CR AR`
 * instead of its mirror. It is deliberately *not* a negative invoice — nothing
 * in this codebase stores a negative amount (see `lines.ts`), and a document
 * with a negative total is indistinguishable in a report from a data-entry
 * mistake.
 *
 * IT ALWAYS NAMES THE INVOICE IT CORRECTS
 * A free-floating credit is a customer advance, which is what an unallocated
 * receipt already is. Naming the invoice is what lets the invoice's settlement
 * be recomputed from facts rather than adjusted by hand, and what makes the
 * `reason` field land somewhere a human will read it.
 *
 * THE REASON IS MANDATORY
 * Same rule as voiding: the person who finds this number in a report a year from
 * now cannot reconstruct why it is there from the amounts alone. A return, a
 * price correction and a write-off look identical in the ledger and are three
 * different conversations with three different people.
 */
import { z } from "zod";

import { CreditNoteModel, InvoiceLineModel, InvoiceModel } from "./sales.model.js";
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
} from "../../core/document-lines.js";
import {
  loadLines,
  partyNamesFor,
  recomputeInvoiceSettlement,
  replaceLines,
  resolveCustomer,
  settlementOf,
} from "./sales.support.js";
import { inTransaction, postJournal, voidEntry } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money } from "../../core/money.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { AppError, notFoundError, validationError } from "../../shared/errors/app-error.js";
import { DateInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const CreateCreditNoteSchema = z.object({
  invoice_id: ObjectIdInput,
  date: DateInput,
  reason: z
    .string()
    .trim()
    .min(3, "Say why this credit is being given — a return, a price correction, a write-off.")
    .max(300),
  lines: z.array(DocumentLineInput).min(1, "A credit note needs at least one line.").max(200),
});

export const ListCreditNoteQuery = z.object({
  invoice_id: ObjectIdInput.optional(),
  party_id: ObjectIdInput.optional(),
  status: z.enum(["ISSUED", "VOID"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const VoidCreditNoteSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason for voiding this credit note.").max(300),
});

export type CreateCreditNoteInput = z.output<typeof CreateCreditNoteSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface CreditNoteView {
  id: string;
  doc_no: string;
  invoice_id: string;
  invoice_no: string | null;
  party_id: string;
  party_code: string;
  party_name: string;
  date: string;
  reason: string;
  status: "ISSUED" | "VOID";
  subtotal_bdt: string;
  tax_total_bdt: string;
  total_bdt: string;
  journal_entry_id: string | null;
  void_reason: string;
  lines: DocumentLineView[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(doc: any, lines: readonly unknown[],
  invoiceNo: string | null,
  party: { code: string; name: string },
): CreditNoteView {
  return {
    id: String(doc._id),
    doc_no: doc.doc_no,
    invoice_id: String(doc.invoice_id),
    invoice_no: invoiceNo,
    party_id: String(doc.party_id),
    party_code: party.code,
    party_name: party.name,
    date: doc.date,
    reason: doc.reason,
    status: doc.status,
    subtotal_bdt: doc.subtotal_bdt,
    tax_total_bdt: doc.tax_total_bdt,
    total_bdt: doc.total_bdt,
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    void_reason: doc.void_reason ?? "",
    lines: lines.map((line) => lineView(line)),
  };
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

async function invoiceNumbers(orgId: string, ids: readonly unknown[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.map((id) => String(id)))];
  if (unique.length === 0) return new Map();
  const rows = await InvoiceModel.find({ org_id: orgId, _id: { $in: unique } })
    .select({ doc_no: 1 })
    .lean();
  return new Map(rows.map((row) => [String(row._id), row.doc_no ?? null]));
}

export async function getCreditNote(orgId: string, id: string): Promise<CreditNoteView> {
  assertObjectId(id, "That credit note does not exist.");

  const doc = await CreditNoteModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That credit note does not exist.");

  const [lines, numbers, names] = await Promise.all([
    loadLines(orgId, "CREDIT_NOTE", id),
    invoiceNumbers(orgId, [doc.invoice_id]),
    partyNamesFor(orgId, [doc.party_id]),
  ]);

  const label = names.get(String(doc.party_id));
  return toView(
    doc,
    lines,
    numbers.get(String(doc.invoice_id)) ?? null,
    { code: label?.code ?? "", name: label?.name ?? "" },
  );
}

export async function listCreditNotes(
  orgId: string,
  query: z.output<typeof ListCreditNoteQuery>,
): Promise<CreditNoteView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.invoice_id) filter["invoice_id"] = query.invoice_id;
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.status) filter["status"] = query.status;

  const rows = await CreditNoteModel.find(filter).sort({ date: -1, doc_seq: -1 }).limit(query.limit).lean();
  if (rows.length === 0) return [];

  const [numbers, names] = await Promise.all([
    invoiceNumbers(orgId, rows.map((row) => row.invoice_id)),
    partyNamesFor(orgId, rows.map((row) => row.party_id)),
  ]);

  const lineRows = await InvoiceLineModel.find({
    org_id: orgId,
    doc_type: "CREDIT_NOTE",
    doc_id: { $in: rows.map((row) => row._id) },
  })
    .sort({ sort_order: 1 })
    .lean();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const byNote = new Map<string, any[]>();
  for (const line of lineRows) {
    const key = String(line.doc_id);
    const bucket = byNote.get(key);
    if (bucket) bucket.push(line);
    else byNote.set(key, [line]);
  }

  return rows.map((row) => {
    const label = names.get(String(row.party_id));
    return toView(row, byNote.get(String(row._id)) ?? [], numbers.get(String(row.invoice_id)) ?? null, {
      code: label?.code ?? "",
      name: label?.name ?? "",
    });
  });
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

/**
 * Raise a credit note against an invoice.
 *
 * The ceiling is the invoice's **outstanding**, not its total: crediting more
 * than is still owed would leave the customer with a balance owed *to* them on
 * this invoice, which is an advance — and an advance is what an unallocated
 * receipt is. Refusing here keeps one meaning for one number.
 */
export async function createCreditNote(
  orgId: string,
  uid: string,
  input: CreateCreditNoteInput,
  ip?: string,
): Promise<CreditNoteView> {
  return inTransaction(async (session) => {
    const invoice = await InvoiceModel.findOne({ _id: input.invoice_id, org_id: orgId })
      .session(session)
      .lean();
    if (!invoice) {
      throw new AppError(422, "INVOICE_NOT_FOUND", "That invoice does not exist in this ledger.");
    }
    if (invoice.status === "DRAFT" || invoice.status === "VOID") {
      throw new AppError(
        422,
        "INVOICE_NOT_CREDITABLE",
        invoice.status === "DRAFT"
          ? "That invoice is still a draft. Issued invoices are the ones a credit note corrects."
          : "That invoice was voided, so there is nothing left to credit.",
      );
    }

    const party = await resolveCustomer(orgId, String(invoice.party_id));
    const lines = await resolveLines(orgId, input.lines, SALE);
    const totals = totalsOf(lines);
    assertTotalsUsable(totals);

    const total = money(totals.total_bdt);
    if (total.isZero()) {
      throw validationError("A credit note with nothing on it corrects nothing. Add a line.");
    }

    const { outstanding } = settlementOf(invoice);
    if (total.greaterThan(outstanding)) {
      throw new AppError(
        422,
        "CREDIT_EXCEEDS_OUTSTANDING",
        `Invoice ${invoice.doc_no ?? ""} has ${fmt(outstanding)} left to settle, so ${fmt(total)} cannot be credited against it. Anything beyond that is a customer advance — record it as a receipt instead.`,
      );
    }

    const allocation = await allocateNumber(orgId, "credit_note", input.date);
    const description = `Credit note ${allocation.number} — ${party.name}`;

    // Written inside the transaction, like the invoice it corrects: a credit
    // note committed outside it while its reversal stayed inside would leave the
    // customer's balance reduced with no entry behind the reduction.
    const created = await CreditNoteModel.create(
      [
        {
          org_id: orgId,
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          invoice_id: invoice._id,
          party_id: party.id,
          date: input.date,
          reason: input.reason,
          status: "ISSUED",
          subtotal_bdt: totals.subtotal_bdt,
          tax_total_bdt: totals.tax_total_bdt,
          total_bdt: totals.total_bdt,
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    // The session matters twice over: without it the lines commit outside the
    // transaction that owns the note, and the read on the next line cannot even
    // see them, so the view returned to the caller would show zero lines.
    await replaceLines(orgId, "CREDIT_NOTE", String(created._id), lineDocs(lines), session);

    // `reverse: true` is the whole difference from an invoice: the same grouped
    // revenue and VAT lines land on the opposite side, and the control account
    // is credited instead of debited.
    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description,
        source: "CREDIT_NOTE",
        source_id: String(created._id),
        lines: documentPostingLines(lines, {
          profile: SALE,
          controlAccountCode: party.control_account_code,
          controlAccountName: "Accounts Receivable",
          partyId: party.id,
          reverse: true,
          memo: description,
        }),
        ...(ip ? { ip } : {}),
      },
      session,
    );

    await CreditNoteModel.updateOne(
      { _id: created._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session },
    );

    await recomputeInvoiceSettlement(orgId, String(invoice._id), session);

    const view = toView(
      { ...created.toObject(), journal_entry_id: entry.id },
      await loadLines(orgId, "CREDIT_NOTE", String(created._id), session),
      invoice.doc_no ?? null,
      { code: party.code, name: party.name },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.credit_note",
        entityId: view.id,
        action: "CREDIT_NOTE_ISSUED",
        after: {
          doc_no: view.doc_no,
          invoice_no: invoice.doc_no,
          reason: view.reason,
          total_bdt: view.total_bdt,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}

/**
 * Void a credit note — the reversal is itself reversed.
 *
 * There is no "unissue". The note's entry is voided (writing its mirror) and the
 * invoice's settlement recomputed from what is then left, so the two documents
 * stay consistent by construction rather than by a compensating adjustment
 * somebody has to remember to make.
 */
export async function voidCreditNote(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<CreditNoteView> {
  assertObjectId(id, "That credit note does not exist.");

  return inTransaction(async (session) => {
    const doc = await CreditNoteModel.findOne({ _id: id, org_id: orgId })
      .session(session)
      .lean();
    if (!doc) throw notFoundError("That credit note does not exist.");
    if (doc.status === "VOID") {
      throw new AppError(409, "CREDIT_NOTE_VOID", "That credit note has already been voided.");
    }

    if (doc.journal_entry_id) {
      await voidEntry(orgId, uid, String(doc.journal_entry_id), reason, ip, session);
    }

    const updated = await CreditNoteModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: { $ne: "VOID" } },
      { $set: { status: "VOID", void_reason: reason.trim() } },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "CREDIT_NOTE_VOID", "That credit note was voided by another request a moment ago.");
    }

    await recomputeInvoiceSettlement(orgId, String(doc.invoice_id), session);

    const [lines, numbers, names] = await Promise.all([
      loadLines(orgId, "CREDIT_NOTE", id),
      invoiceNumbers(orgId, [doc.invoice_id]),
      partyNamesFor(orgId, [doc.party_id]),
    ]);
    const label = names.get(String(doc.party_id));
    const view = toView(updated, lines, numbers.get(String(doc.invoice_id)) ?? null, {
      code: label?.code ?? "",
      name: label?.name ?? "",
    });

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.credit_note",
        entityId: view.id,
        action: "CREDIT_NOTE_VOIDED",
        before: { doc_no: doc.doc_no, total_bdt: doc.total_bdt, status: "ISSUED" },
        after: { status: "VOID", reason: reason.trim() },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}
