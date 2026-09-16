/**
 * Receipts — money arriving against a customer's account (plan §6, Phase 3).
 *
 * A receipt is not "a payment of an invoice". It is money received *from a
 * customer*, which is then **allocated** across whatever they owe. That
 * distinction does all the work in this file:
 *
 *   - a customer can pay three invoices with one transfer, and the allocation
 *     rows say which;
 *   - a customer can pay more than they owe, and the difference is parked as an
 *     **advance** against future invoices rather than being refused or silently
 *     absorbed (`unallocated_bdt`);
 *   - an invoice is never "paid" by a flag someone set, only by allocations that
 *     sum to it.
 *
 * The allocation default is oldest-first (plan §6), because that is what a
 * credit controller means by "clear the oldest debt" and it is the order that
 * minimises how much of a customer's balance is unnecessarily aged.
 *
 * A receipt has no draft state. The money has already arrived by the time anyone
 * types it in, so there is nothing to decide later — and the posting is the
 * record of that arrival.
 */
import type { ClientSession } from "mongoose";
import { z } from "zod";

import { InvoiceModel, ReceiptAllocationModel, ReceiptModel } from "./sales.model.js";
import {
  openInvoices,
  partyNamesFor,
  recomputeInvoiceSettlement,
  resolveCustomer,
  type OpenInvoiceRow,
} from "./sales.support.js";
import { inTransaction, postJournal } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, toPaisa, ZERO, type Money } from "../../core/money.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import { parkRemainder } from "../advances/advance.service.js";
import { requireAccountByCode } from "../coa/coa.service.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const ReceiptAllocationInput = z.object({
  invoice_id: ObjectIdInput,
  amount_bdt: MoneyInput,
});

export const CreateReceiptSchema = z.object({
  party_id: ObjectIdInput,
  date: DateInput,
  method: z.enum(["CASH", "BANK"]).default("CASH"),
  /** Blank picks the conventional account for the method (1000 cash / 1010 bank). */
  account_code: z.string().trim().max(24).default(""),
  amount_bdt: MoneyInput,
  memo: z.string().trim().max(300).default(""),
  /** Empty means "allocate oldest-first"; anything else is applied as given. */
  allocations: z.array(ReceiptAllocationInput).max(200).default([]),
});

export const ListReceiptQuery = z.object({
  party_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type CreateReceiptInput = z.output<typeof CreateReceiptSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface ReceiptAllocationView {
  id: string;
  invoice_id: string;
  invoice_no: string | null;
  amount_bdt: string;
}

export interface ReceiptView {
  id: string;
  doc_no: string;
  party_id: string;
  party_code: string;
  party_name: string;
  date: string;
  method: "CASH" | "BANK";
  account_code: string;
  account_name: string;
  amount_bdt: string;
  allocated_bdt: string;
  /** The customer's advance: paid, not yet claimed by an invoice. */
  unallocated_bdt: string;
  memo: string;
  journal_entry_id: string | null;
  allocations: ReceiptAllocationView[];
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

interface PlannedAllocation {
  invoice: OpenInvoiceRow;
  amount: Money;
}

/**
 * Decide what this receipt settles.
 *
 * Explicit allocations are validated against the invoice's **live** outstanding
 * rather than trusted: the outstanding shown to the user is a cached figure, and
 * a stale screen must not be able to over-settle an invoice. The oldest-first
 * default applies the money to the oldest debt first and simply stops when the
 * receipt runs out — whatever is left is the advance.
 */
function planAllocations(
  receiptAmount: Money,
  explicit: readonly { invoice_id: string; amount_bdt: string }[],
  open: readonly OpenInvoiceRow[],
): PlannedAllocation[] {
  const byId = new Map(open.map((row) => [row.id, row]));

  if (explicit.length > 0) {
    const plan: PlannedAllocation[] = [];
    let remaining = receiptAmount;

    for (const entry of explicit) {
      const invoice = byId.get(entry.invoice_id);
      if (!invoice) {
        throw new AppError(
          422,
          "INVOICE_NOT_OPEN",
          "One of the invoices you picked is not open — it may already be paid, or belong to another customer.",
        );
      }
      const amount = money(entry.amount_bdt);
      if (amount.isNegative()) {
        throw new AppError(422, "INVALID_AMOUNT", "An allocation cannot be negative.");
      }
      if (amount.isZero()) continue;
      if (amount.greaterThan(invoice.outstanding)) {
        throw new AppError(
          422,
          "ALLOCATION_EXCEEDS_BALANCE",
          `Invoice ${invoice.doc_no ?? invoice.id} only has ${fmt(invoice.outstanding)} outstanding, so ${fmt(amount)} cannot be applied to it.`,
        );
      }
      if (amount.greaterThan(remaining)) {
        throw new AppError(
          422,
          "ALLOCATION_EXCEEDS_RECEIPT",
          `The allocations total more than the ${fmt(receiptAmount)} received. Put the excess in a second receipt, or leave it as an advance.`,
        );
      }
      plan.push({ invoice, amount });
      remaining = remaining.minus(amount);
    }
    return plan;
  }

  const plan: PlannedAllocation[] = [];
  let remaining = receiptAmount;
  // `openInvoices` is already ordered oldest-first, so the default rule is the
  // iteration order rather than a sort here that could drift from it.
  for (const invoice of open) {
    // Same zero-trap as above: a receipt exactly consumed must stop here, not
    // trail 0.00 allocation rows across every remaining open invoice.
    if (!remaining.greaterThan(ZERO)) break;
    const amount = remaining.greaterThan(invoice.outstanding) ? invoice.outstanding : remaining;
    plan.push({ invoice, amount: toPaisa(amount) });
    remaining = remaining.minus(amount);
  }
  return plan;
}

export interface ReceiptResult {
  receipt: ReceiptView;
  warnings: { code: string; message: string }[];
}

export async function createReceipt(
  orgId: string,
  uid: string,
  input: CreateReceiptInput,
  ip?: string,
): Promise<ReceiptResult> {
  const party = await resolveCustomer(orgId, input.party_id);
  const amount = money(input.amount_bdt);
  // `greaterThan`, not `isPositive`: decimal.js reads "0.00" (a positive-signed
  // zero) as positive, so the old guard could never fire.
  if (!amount.greaterThan(ZERO)) {
    throw new AppError(422, "INVALID_AMOUNT", "A receipt needs an amount greater than zero.");
  }

  // The account the money landed in must be one the ledger can receive into.
  // A revenue account here would post a customer's payment as a sale.
  const depositCode = input.account_code || (input.method === "BANK" ? CONTROL_ACCOUNT.BANK : CONTROL_ACCOUNT.CASH);
  const deposit = await requireAccountByCode(orgId, depositCode);
  if (deposit.type !== "ASSET") {
    throw new AppError(
      422,
      "ACCOUNT_NOT_ASSET",
      `${deposit.code} (${deposit.name}) is a ${deposit.type.toLowerCase()} account. Money arrives in an asset account such as ${CONTROL_ACCOUNT.BANK}.`,
    );
  }

  return inTransaction(async (session) => {
    const open = await openInvoices(orgId, { partyId: party.id, session });
    const plan = planAllocations(amount, input.allocations, open);
    const allocated = toPaisa(plan.reduce((acc, entry) => acc.plus(entry.amount), money(0)));
    const unallocated = toPaisa(amount.minus(allocated));

    const allocation = await allocateNumber(orgId, "receipt", input.date);
    const description = `Receipt ${allocation.number} — ${party.name}`;

    // Every write here carries the session. `create` without it would commit the
    // receipt outside the transaction while its journal entry stayed inside — and
    // the transactional read just below would not even see the row it had just
    // written, because the transaction's snapshot predates it.
    const receipt = await ReceiptModel.create(
      [
        {
          org_id: orgId,
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          party_id: party.id,
          date: input.date,
          method: input.method,
          account_code: deposit.code,
          account_name: deposit.name,
          amount_bdt: fmt(amount),
          allocated_bdt: fmt(allocated),
          unallocated_bdt: fmt(unallocated),
          memo: input.memo,
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((created) => created[0]!);

    // Money in debits the account it landed in; the customer's balance falls by
    // the same amount. Two lines, always — the allocation split is a sub-ledger
    // fact, not a general-ledger one.
    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description,
        source: "RECEIPT",
        source_id: String(receipt._id),
        lines: [
          { account_code: deposit.code, debit_bdt: fmt(amount), memo: description },
          {
            account_code: party.control_account_code,
            credit_bdt: fmt(amount),
            memo: description,
            party_id: party.id,
          },
        ],
        ...(ip ? { ip } : {}),
      },
      session,
    );

    if (plan.length > 0) {
      await ReceiptAllocationModel.insertMany(
        plan.map((entryLine) => ({
          org_id: orgId,
          receipt_id: receipt._id,
          invoice_id: entryLine.invoice.id,
          party_id: party.id,
          amount_bdt: fmt(entryLine.amount),
        })),
        { session },
      );
    }

    // Each affected invoice's cache is rewritten from the allocation rows inside
    // this transaction. Two receipts racing on one invoice therefore both write
    // the invoice and MongoDB resolves the conflict by aborting one, so the
    // over-settlement check above cannot be defeated by timing.
    for (const touched of new Set(plan.map((entry) => entry.invoice.id))) {
      await recomputeInvoiceSettlement(orgId, touched, session);
    }

    await ReceiptModel.updateOne(
      { _id: receipt._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session },
    );

    // Phase 10: the part no invoice claimed is money the customer is holding
    // with us. Park it as an advance **in this same transaction** (ADR 0004 §6),
    // with no journal entry of its own — the movement is already in the receipt
    // entry above, so posting again would double the customer's credit.
    await parkRemainder(
      orgId,
      uid,
      {
        partyId: party.id,
        date: input.date,
        amount: unallocated,
        accountCode: deposit.code,
        accountName: deposit.name,
        source: "RECEIPT_REMAINDER",
        sourceDocNo: allocation.number,
        notes: input.memo,
      },
      session,
    );

    const view: ReceiptView = {
      ...(await receiptView(orgId, String(receipt._id), session)),
      party_code: party.code,
      party_name: party.name,
    };
    const warnings = receiptWarnings(plan, unallocated);

    await writeAudit(
      {
        orgId,
        uid,
        entity: "sales.receipt",
        entityId: view.id,
        action: "RECEIPT_RECORDED",
        after: {
          doc_no: view.doc_no,
          amount_bdt: view.amount_bdt,
          allocated_bdt: view.allocated_bdt,
          unallocated_bdt: view.unallocated_bdt,
          invoices: view.allocations.map((row) => row.invoice_id),
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return { receipt: view, warnings };
  });
}

/** Non-blocking advice about what this receipt settled. */
function receiptWarnings(
  plan: readonly PlannedAllocation[],
  unallocated: Money,
): { code: string; message: string }[] {
  const warnings: { code: string; message: string }[] = [];
  const today = todayInLedgerZone();

  const overdue = plan.filter((entry) => entry.invoice.due_date < today);
  if (overdue.length > 0) {
    warnings.push({
      code: "SETTLED_OVERDUE",
      message: `${overdue.length} of the invoices this receipt settles were already past due.`,
    });
  }

  // "0.00" is positive-signed, so `isPositive()` warned on every fully-allocated
  // receipt; only a real advance should warn.
  if (unallocated.greaterThan(ZERO)) {
    warnings.push({
      code: "ADVANCE_PARKED",
      message: `${fmt(unallocated)} is more than this customer owed. It is held as an advance and will settle their next invoice.`,
    });
  }

  return warnings;
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

async function receiptView(
  orgId: string,
  id: string,
  session?: ClientSession | null,
): Promise<ReceiptView> {
  const doc = await ReceiptModel.findOne({ _id: id, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!doc) throw notFoundError("That receipt does not exist.");

  return shapeReceipt(doc, await allocationsOf(orgId, id, session));
}

async function allocationsOf(
  orgId: string,
  receiptId: string,
  session?: ClientSession | null,
): Promise<ReceiptAllocationView[]> {
  const rows = await ReceiptAllocationModel.find({ org_id: orgId, receipt_id: receiptId })
    .session(session ?? null)
    .lean();
  if (rows.length === 0) return [];

  // The invoice numbers are what the allocation picker showed, so they are what
  // the receipt prints. Read from the invoice rather than snapshotted: an
  // invoice number never changes once issued, so there is nothing to drift.
  const invoices = await InvoiceModel.find({ org_id: orgId, _id: { $in: rows.map((row) => row.invoice_id) } })
    .select({ doc_no: 1 })
    .lean();
  const numbers = new Map(invoices.map((row) => [String(row._id), row.doc_no ?? null]));

  return rows.map((row) => ({
    id: String(row._id),
    invoice_id: String(row.invoice_id),
    invoice_no: numbers.get(String(row.invoice_id)) ?? null,
    amount_bdt: row.amount_bdt ?? "0.00",
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeReceipt(doc: any, allocations: readonly ReceiptAllocationView[]): ReceiptView {
  return {
    id: String(doc._id),
    doc_no: doc.doc_no,
    party_id: String(doc.party_id),
    party_code: "",
    party_name: "",
    date: doc.date,
    method: doc.method,
    account_code: doc.account_code,
    account_name: doc.account_name ?? "",
    amount_bdt: doc.amount_bdt,
    allocated_bdt: doc.allocated_bdt,
    unallocated_bdt: doc.unallocated_bdt,
    memo: doc.memo ?? "",
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    allocations: [...allocations],
  };
}

export async function getReceipt(orgId: string, id: string): Promise<ReceiptView> {
  assertObjectId(id, "That receipt does not exist.");
  const doc = await ReceiptModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That receipt does not exist.");

  const names = await partyNamesFor(orgId, [doc.party_id]);
  const label = names.get(String(doc.party_id));
  const view = shapeReceipt(doc, await allocationsOf(orgId, id));
  return { ...view, party_code: label?.code ?? "", party_name: label?.name ?? "" };
}

export async function listReceipts(
  orgId: string,
  query: z.output<typeof ListReceiptQuery>,
): Promise<ReceiptView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await ReceiptModel.find(filter).sort({ date: -1, doc_seq: -1 }).limit(query.limit).lean();
  if (rows.length === 0) return [];

  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));
  const allocations = await ReceiptAllocationModel.find({
    org_id: orgId,
    receipt_id: { $in: rows.map((row) => row._id) },
  }).lean();
  const invoices = await InvoiceModel.find({
    org_id: orgId,
    _id: { $in: allocations.map((row) => row.invoice_id) },
  })
    .select({ doc_no: 1 })
    .lean();
  const numbers = new Map(invoices.map((row) => [String(row._id), row.doc_no ?? null]));

  return rows.map((row) => {
    const label = names.get(String(row.party_id));
    const mine: ReceiptAllocationView[] = allocations
      .filter((allocation) => String(allocation.receipt_id) === String(row._id))
      .map((allocation) => ({
        id: String(allocation._id),
        invoice_id: String(allocation.invoice_id),
        invoice_no: numbers.get(String(allocation.invoice_id)) ?? null,
        amount_bdt: allocation.amount_bdt ?? "0.00",
      }));

    return {
      ...shapeReceipt(row, mine),
      party_code: label?.code ?? "",
      party_name: label?.name ?? "",
    };
  });
}
