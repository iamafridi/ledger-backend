/**
 * Shared purchases helpers — the small set of reads and rewrites that bills,
 * payments and debit notes all have to agree on.
 *
 * The one that matters is `recomputeBillSettlement`.
 *
 * WHERE "HOW MUCH DO WE STILL OWE" LIVES
 * A bill's `paid_bdt` and `debited_bdt` are a **cache**, and this file is the
 * only writer of them. The truth is the payment allocations, the prepayment
 * claims (Phase 10) and the issued debit notes pointed at the bill; the cache
 * exists because an aging report reads hundreds of bills and must not run a
 * sub-query per row.
 *
 * A cache with more than one writer is how two screens end up disagreeing, so
 * there is exactly one: every function that moves money against a bill calls
 * this, inside its own transaction, and nothing anywhere else touches those two
 * fields. Recomputing from the rows rather than incrementing means a retried or
 * duplicated allocation cannot double-count — the worst case is a wasted read.
 *
 * The same rule decides the status: `ISSUED → PARTIALLY_PAID → PAID` is not a
 * state machine anybody advances by hand, it is a read of how much has settled.
 * A DRAFT or VOID bill is left alone — a draft has no settlement to speak of and
 * a voided one is history.
 */
import type { ClientSession } from "mongoose";

import {
  BillLineModel,
  BillModel,
  DebitNoteModel,
  PaymentAllocationModel,
} from "./purchases.model.js";
import { AdvanceAdjustmentModel, AdvanceModel } from "../advances/advances.model.js";
import { PartyModel } from "../masterdata/parties.model.js";
import { money, sub, sum, toPaisa, ZERO, type Money } from "../../core/money.js";
import { AppError } from "../../shared/errors/app-error.js";

/** The party fields a document or a journal line needs. Structural rather than
 *  a full mongoose document, so callers can pass a `.lean()` row. */
export interface PurchasesParty {
  id: string;
  name: string;
  code: string;
  /** The chart account this supplier's balance sits on (2000 by default). */
  control_account_code: string;
}

/**
 * Resolve a party as a **supplier**, for the purchasing side of the ledger.
 *
 * A CUSTOMER is refused, and it is the exact mirror of `resolveCustomer` in
 * `sales.support.ts`: raising a bill against a customer would credit their
 * receivables account, and while the entry would still balance, the sub-ledger
 * it touches belongs to the other side of the business. Catching it here costs
 * one comparison; catching it later costs a reconciliation.
 *
 * `BOTH` is the third kind and is deliberately allowed on either side — the
 * only parties refused outright are the ones recorded as exclusively the other
 * thing.
 */
export async function resolveSupplier(orgId: string, partyId: string): Promise<PurchasesParty> {
  if (!/^[0-9a-fA-F]{24}$/.test(partyId)) throw new AppError(404, "NOT_FOUND", "That supplier does not exist.");

  const party = await PartyModel.findOne({ _id: partyId, org_id: orgId }).lean();
  if (!party) throw new AppError(422, "PARTY_NOT_FOUND", "That supplier does not exist in this ledger.");
  if (party.is_active === false) {
    throw new AppError(422, "PARTY_INACTIVE", `${party.name} is inactive, so nothing new can be raised for them.`);
  }
  if (party.kind === "CUSTOMER") {
    throw new AppError(
      422,
      "PARTY_NOT_SUPPLIER",
      `${party.name} is recorded as a customer. Raise an invoice for them instead of a bill.`,
    );
  }

  return {
    id: String(party._id),
    name: party.name,
    code: party.code,
    control_account_code: party.control_account_code,
  };
}

/** How much of a bill is settled, and how much is left. */
export interface Settlement {
  total: Money;
  paid: Money;
  debited: Money;
  outstanding: Money;
}

export function settlementOf(doc: {
  total_bdt?: string | null;
  paid_bdt?: string | null;
  debited_bdt?: string | null;
}): Settlement {
  const total = money(doc.total_bdt ?? "0.00");
  const paid = money(doc.paid_bdt ?? "0.00");
  const debited = money(doc.debited_bdt ?? "0.00");
  return { total, paid, debited, outstanding: sub(sub(total, paid), debited) };
}

/**
 * Rewrite a bill's settlement cache from the rows that actually settled it.
 *
 * Reads are taken inside the caller's session when there is one, so a payment
 * that is mid-transaction sees its own allocations and no other writer's — the
 * point of doing this at all rather than accumulating.
 */
export async function recomputeBillSettlement(
  orgId: string,
  billId: string,
  session?: ClientSession | null,
): Promise<void> {
  const bill = await BillModel.findOne({ _id: billId, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!bill) return;
  // A draft has claimed no number and moved no balance; a voided one is history.
  // Neither has a settlement to recompute, and writing to a void would destroy
  // the record of what the bill was worth when it was cancelled.
  if (bill.status === "DRAFT" || bill.status === "VOID") return;

  const [allocations, debitNotes, claims] = await Promise.all([
    PaymentAllocationModel.find({ org_id: orgId, bill_id: bill._id })
      .session(session ?? null)
      .lean(),
    DebitNoteModel.find({ org_id: orgId, bill_id: bill._id, status: "ISSUED" })
      .session(session ?? null)
      .lean(),
    // A prepayment claimed against this bill settles it exactly as a payment
    // allocation does — the money was posted when the payment (or the manual
    // prepayment) went out — so `paid` is the sum of both kinds of row, read
    // from the adjustment rows themselves (ADR 0004 §5).
    AdvanceAdjustmentModel.find({ org_id: orgId, document_type: "BILL", document_id: String(bill._id) })
      .session(session ?? null)
      .lean(),
  ]);

  const paid = toPaisa(sum([...allocations, ...claims].map((row) => money(row.amount_bdt))));
  const debited = toPaisa(sum(debitNotes.map((row) => money(row.total_bdt))));
  const total = money(bill.total_bdt);
  const settled = paid.plus(debited);

  // Equality, not `>=`: an over-settlement is a defect the write guards refuse,
  // and treating it as PAID here would hide it rather than let it be noticed.
  const status = settled.equals(total) ? "PAID" : settled.isZero() ? "ISSUED" : "PARTIALLY_PAID";

  await BillModel.updateOne(
    { _id: bill._id, org_id: orgId },
    { $set: { paid_bdt: paid.toFixed(2), debited_bdt: debited.toFixed(2), status } },
    session ? { session } : {},
  );
}

/** The stored lines of a document, in the order they were written. */
export async function loadLines(orgId: string, docType: string, docId: string, session?: ClientSession | null) {
  return BillLineModel.find({ org_id: orgId, doc_type: docType, doc_id: docId })
    .sort({ sort_order: 1 })
    .session(session ?? null)
    .lean();
}

/**
 * Replace a document's lines wholesale.
 *
 * Lines are derived data — they only mean anything as a complete document — so
 * an edit rewrites the set rather than diffing it. Stored totals are derived
 * from the same resolved set at the same moment, which is what keeps a saved
 * document's arithmetic consistent with the lines somebody can read on it.
 */
export async function replaceLines(
  orgId: string,
  docType: "BILL" | "DEBIT_NOTE",
  docId: string,
  lines: readonly Record<string, unknown>[],
  session?: ClientSession | null,
): Promise<void> {
  await BillLineModel.deleteMany(
    { org_id: orgId, doc_type: docType, doc_id: docId },
    session ? { session } : {},
  );
  await BillLineModel.insertMany(
    lines.map((line) => ({ ...line, org_id: orgId, doc_type: docType, doc_id: docId })),
    session ? { session } : {},
  );
}

/** One open (part-settled) bill, as the payment picker and the aging report
 *  both need it. `outstanding` is derived, never stored stale. */
export interface OpenBillRow {
  id: string;
  doc_no: string | null;
  date: string;
  due_date: string;
  party_id: string;
  total: Money;
  outstanding: Money;
}

/**
 * The bills still owed on, oldest first.
 *
 * **Oldest first is the default allocation order** (plan §6), and it is decided
 * here rather than at each call site: the intent of the rule is that a payment
 * always clears the debt that has been outstanding longest — the one most likely
 * to attract a late-payment charge or a supplier's phone call — and a sort
 * somebody could forget to pass is a rule that would quietly stop being true.
 * Ordering falls back to the document number for same-day bills, so two bills
 * raised on one day clear in the order they were issued.
 */
export async function openBills(
  orgId: string,
  options: { partyId?: string; session?: ClientSession | null } = {},
): Promise<OpenBillRow[]> {
  const filter: Record<string, unknown> = {
    org_id: orgId,
    status: { $in: ["ISSUED", "PARTIALLY_PAID"] },
  };
  if (options.partyId) filter["party_id"] = options.partyId;

  const rows = await BillModel.find(filter)
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
    // A bill settled to the paisa is not an open bill, whatever its status cache
    // still says, so the filter is on the amount rather than the status alone.
    .filter((row) => row.outstanding.isPositive());
}

/**
 * Money we hold with this supplier ahead of any bill — their unclaimed advance
 * balance. A payment remainder is parked as a prepayment the moment the payment
 * is written (Phase 10), and a manual prepayment is recorded the same way, so
 * the advances and their adjustments are the one place the figure lives. It is
 * a debit balance with the supplier and reduces what we owe them overall.
 */
export async function partyPrepayments(
  orgId: string,
  partyId: string,
  session?: ClientSession | null,
): Promise<Money> {
  const [advances, adjustments] = await Promise.all([
    AdvanceModel.find({ org_id: orgId, party_id: partyId })
      .session(session ?? null)
      .lean(),
    AdvanceAdjustmentModel.find({ org_id: orgId, party_id: partyId })
      .session(session ?? null)
      .lean(),
  ]);

  const held = sum(advances.map((row) => money(row.amount_bdt ?? "0.00"))).minus(
    sum(adjustments.map((row) => money(row.amount_bdt ?? "0.00"))),
  );
  return held.isNegative() ? ZERO : held;
}

/**
 * What we currently owe this supplier, net of any prepayment they are holding
 * from us.
 *
 * A prepayment subtracts because money paid in advance *is* the settlement of a
 * bill not yet raised; ignoring it would overstate the payable.
 */
export async function partyApBalance(
  orgId: string,
  partyId: string,
  session?: ClientSession | null,
): Promise<Money> {
  const [bills, prepayments] = await Promise.all([
    openBills(orgId, { partyId, ...(session ? { session } : {}) }),
    partyPrepayments(orgId, partyId, session),
  ]);

  const outstanding = sum(bills.map((row) => row.outstanding));
  return outstanding.minus(prepayments);
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
