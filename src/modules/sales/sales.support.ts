/**
 * Shared sales helpers — the small set of reads and rewrites that invoices,
 * receipts and credit notes all have to agree on.
 *
 * The one that matters is `recomputeInvoiceSettlement`.
 *
 * WHERE "HOW MUCH IS STILL OWED" LIVES
 * An invoice's `paid_bdt` and `credited_bdt` are a **cache**, and this file is
 * the only writer of them. The truth is the receipt allocations, the advance
 * claims (Phase 10) and the issued credit notes pointed at the invoice; the
 * cache exists because an aging report reads hundreds of invoices and must not
 * run a sub-query per row.
 *
 * A cache with more than one writer is how two screens end up disagreeing, so
 * there is exactly one: every function that moves money against an invoice calls
 * this, inside its own transaction, and nothing anywhere else touches those two
 * fields. Recomputing from the rows rather than incrementing means a retried or
 * duplicated allocation cannot double-count — the worst case is a wasted read.
 *
 * The same rule decides the status: `ISSUED → PARTIALLY_PAID → PAID` is not a
 * state machine anybody advances by hand, it is a read of how much has settled.
 * A DRAFT or VOID invoice is left alone — a draft has no settlement to speak of
 * and a voided one is history.
 */
import type { ClientSession } from "mongoose";

import {
  CreditNoteModel,
  InvoiceLineModel,
  InvoiceModel,
  ReceiptAllocationModel,
} from "./sales.model.js";
import { AdvanceAdjustmentModel, AdvanceModel } from "../advances/advances.model.js";
import { PartyModel } from "../masterdata/parties.model.js";
import { money, sub, sum, toPaisa, ZERO, type Money } from "../../core/money.js";
import { AppError } from "../../shared/errors/app-error.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/** The party fields a document or a journal line needs. Structural rather than
 *  a full mongoose document, so callers can pass a `.lean()` row. */
export interface SalesParty {
  id: string;
  name: string;
  code: string;
  /** The chart account this customer's balance sits on (1100 by default). */
  control_account_code: string;
  credit_limit_bdt: string;
}

/**
 * Resolve a party as a **customer**, for the sales side of the ledger.
 *
 * A SUPPLIER is refused: issuing an invoice to a supplier would debit their
 * payables account, and while the entry would still balance, the sub-ledger it
 * touches belongs to the other side of the business. Catching it here costs one
 * comparison; catching it later costs a reconciliation.
 */
export async function resolveCustomer(orgId: string, partyId: string): Promise<SalesParty> {
  assertObjectId(partyId, "That customer does not exist.");

  const party = await PartyModel.findOne({ _id: partyId, org_id: orgId }).lean();
  if (!party) throw new AppError(422, "PARTY_NOT_FOUND", "That customer does not exist in this ledger.");
  if (party.is_active === false) {
    throw new AppError(422, "PARTY_INACTIVE", `${party.name} is inactive, so nothing new can be raised for them.`);
  }
  if (party.kind === "SUPPLIER") {
    throw new AppError(
      422,
      "PARTY_NOT_CUSTOMER",
      `${party.name} is recorded as a supplier. Raise a bill for them instead of an invoice.`,
    );
  }

  return {
    id: String(party._id),
    name: party.name,
    code: party.code,
    control_account_code: party.control_account_code,
    credit_limit_bdt: party.credit_limit_bdt ?? "0.00",
  };
}

/** How much of an invoice is settled, and how much is left. */
export interface Settlement {
  total: Money;
  paid: Money;
  credited: Money;
  outstanding: Money;
}

export function settlementOf(doc: {
  total_bdt?: string | null;
  paid_bdt?: string | null;
  credited_bdt?: string | null;
}): Settlement {
  const total = money(doc.total_bdt ?? "0.00");
  const paid = money(doc.paid_bdt ?? "0.00");
  const credited = money(doc.credited_bdt ?? "0.00");
  return { total, paid, credited, outstanding: sub(sub(total, paid), credited) };
}

/**
 * Rewrite an invoice's settlement cache from the rows that actually settled it.
 *
 * Reads are taken inside the caller's session when there is one, so a receipt
 * that is mid-transaction sees its own allocations and no other writer's — the
 * point of doing this at all rather than accumulating.
 */
export async function recomputeInvoiceSettlement(
  orgId: string,
  invoiceId: string,
  session?: ClientSession | null,
): Promise<void> {
  const invoice = await InvoiceModel.findOne({ _id: invoiceId, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!invoice) return;
  // A draft has claimed no number and moved no balance; a voided one is history.
  // Neither has a settlement to recompute, and writing to a void would destroy
  // the record of what the invoice was worth when it was cancelled.
  if (invoice.status === "DRAFT" || invoice.status === "VOID") return;

  const [allocations, creditNotes, claims] = await Promise.all([
    ReceiptAllocationModel.find({ org_id: orgId, invoice_id: invoice._id })
      .session(session ?? null)
      .lean(),
    CreditNoteModel.find({ org_id: orgId, invoice_id: invoice._id, status: "ISSUED" })
      .session(session ?? null)
      .lean(),
    // An advance claimed against this invoice is settlement, exactly as a
    // receipt allocation is: the money was posted when the receipt (or the
    // manual advance) arrived, and the claim only says which invoice it clears
    // (ADR 0004 §5). Read from the adjustment rows themselves — never from the
    // advances' cached balance — so this stays a recompute from the truth and a
    // retried claim cannot double-count.
    AdvanceAdjustmentModel.find({ org_id: orgId, document_type: "INVOICE", document_id: String(invoice._id) })
      .session(session ?? null)
      .lean(),
  ]);

  const paid = toPaisa(sum([...allocations, ...claims].map((row) => money(row.amount_bdt))));
  const credited = toPaisa(sum(creditNotes.map((row) => money(row.total_bdt))));
  const total = money(invoice.total_bdt);
  const settled = paid.plus(credited);

  // Equality, not `>=`: an over-settlement is a defect the write guards refuse,
  // and treating it as PAID here would hide it rather than let it be noticed.
  const status = settled.equals(total) ? "PAID" : settled.isZero() ? "ISSUED" : "PARTIALLY_PAID";

  await InvoiceModel.updateOne(
    { _id: invoice._id, org_id: orgId },
    { $set: { paid_bdt: paid.toFixed(2), credited_bdt: credited.toFixed(2), status } },
    session ? { session } : {},
  );
}

/** The stored lines of a document, in the order they were written. */
export async function loadLines(orgId: string, docType: string, docId: string, session?: ClientSession | null) {
  return InvoiceLineModel.find({ org_id: orgId, doc_type: docType, doc_id: docId })
    .sort({ sort_order: 1 })
    .session(session ?? null)
    .lean();
}

/** Replace a document's lines wholesale.
 *
 *  Lines are derived data — they only mean anything as a complete document — so
 *  an edit rewrites the set rather than diffing it. Stored totals are derived
 *  from the same resolved set at the same moment, which is what keeps a saved
 *  document's arithmetic consistent with the lines somebody can read on it. */
export async function replaceLines(
  orgId: string,
  docType: "INVOICE" | "CREDIT_NOTE",
  docId: string,
  lines: readonly Record<string, unknown>[],
  session?: ClientSession | null,
): Promise<void> {
  await InvoiceLineModel.deleteMany(
    { org_id: orgId, doc_type: docType, doc_id: docId },
    session ? { session } : {},
  );
  await InvoiceLineModel.insertMany(
    lines.map((line) => ({ ...line, org_id: orgId, doc_type: docType, doc_id: docId })),
    session ? { session } : {},
  );
}

/** One open (part-settled) invoice, as the allocation picker and the aging
 *  report both need it. `outstanding` is derived, never stored stale. */
export interface OpenInvoiceRow {
  id: string;
  doc_no: string | null;
  date: string;
  due_date: string;
  party_id: string;
  total: Money;
  outstanding: Money;
}

/**
 * The invoices still owed on, oldest first.
 *
 * **Oldest first is the default allocation order** (plan §6), and it is decided
 * here rather than at each call site: the intent of the rule is that a customer's
 * money always clears the debt that has been outstanding longest, and a sort
 * somebody could forget to pass is a rule that would quietly stop being true.
 * Ordering falls back to the document number for same-day invoices, so two
 * invoices raised on one day clear in the order they were issued.
 */
export async function openInvoices(
  orgId: string,
  options: { partyId?: string; session?: ClientSession | null } = {},
): Promise<OpenInvoiceRow[]> {
  const filter: Record<string, unknown> = {
    org_id: orgId,
    status: { $in: ["ISSUED", "PARTIALLY_PAID"] },
  };
  if (options.partyId) filter["party_id"] = options.partyId;

  const rows = await InvoiceModel.find(filter)
    .sort({ date: 1, doc_seq: 1 })
    .session(options.session ?? null)
    .lean();

  return rows
    .map((row) => {
      const { total, outstanding } = settlementOf(row);
      return {
        id: String(row._id),
        doc_no: row.doc_no ?? null,
        date: row.date,
        due_date: row.due_date || row.date,
        party_id: String(row.party_id),
        total,
        outstanding,
      };
    })
    // An invoice settled to the paisa is not an open invoice, whatever its
    // status cache still says, so the filter is on the amount rather than the
    // status alone.
    .filter((row) => row.outstanding.isPositive());
}

/**
 * What this customer currently owes, net of any advance they are holding with
 * us. This is the figure the credit-limit warning compares against a limit.
 *
 * An advance subtracts because money paid in advance *is* the settlement of an
 * invoice not yet raised; ignoring it would warn about a limit the customer has
 * already covered. Two halves, each counted exactly once: the open invoices are
 * already net of the claims they carry (`paid_bdt` includes them), so only the
 * **unclaimed** advance balance — every advance of theirs less every adjustment
 * ever made against one — is subtracted here. That is the same figure the
 * advance screen shows as outstanding.
 */
export async function partyArBalance(
  orgId: string,
  partyId: string,
  session?: ClientSession | null,
): Promise<Money> {
  const [invoices, advances, adjustments] = await Promise.all([
    openInvoices(orgId, { partyId, ...(session ? { session } : {}) }),
    AdvanceModel.find({ org_id: orgId, party_id: partyId })
      .session(session ?? null)
      .lean(),
    AdvanceAdjustmentModel.find({ org_id: orgId, party_id: partyId })
      .session(session ?? null)
      .lean(),
  ]);

  const outstanding = sum(invoices.map((row) => row.outstanding));
  const held = sum(advances.map((row) => money(row.amount_bdt ?? "0.00"))).minus(
    sum(adjustments.map((row) => money(row.amount_bdt ?? "0.00"))),
  );
  return outstanding.minus(held.isNegative() ? ZERO : held);
}

/** Party name lookups for a page of documents, in one read instead of one per
 *  row — the difference between a list screen that opens and one that does not. */
export async function partyNamesFor(
  orgId: string,
  partyIds: readonly unknown[],
): Promise<Map<string, { code: string; name: string }>> {
  const unique = [...new Set(partyIds.map((id) => String(id)))].filter(Boolean);
  if (unique.length === 0) return new Map();

  const rows = await PartyModel.find({ org_id: orgId, _id: { $in: unique } })
    .select({ code: 1, name: 1 })
    .lean();
  return new Map(rows.map((row) => [String(row._id), { code: row.code, name: row.name }]));
}
