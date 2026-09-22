/**
 * Payments — money leaving against a supplier's account (plan §6, Phase 4).
 *
 * A payment is not "a payment of a bill". It is money paid *to a supplier*,
 * which is then **allocated** across whatever we owe them. That distinction does
 * all the work in this file:
 *
 *   - one transfer can settle three bills, and the allocation rows say which;
 *   - we can pay more than we owe, and the difference is parked as a
 *     **prepayment** against future bills rather than being refused or silently
 *     absorbed (`unallocated_bdt`);
 *   - a bill is never "paid" by a flag someone set, only by allocations that sum
 *     to it.
 *
 * The allocation default is oldest-first (plan §6), because that is the order
 * that keeps a supplier relationship out of trouble: the oldest debt is the one
 * about to attract a late-payment charge or a phone call.
 *
 * A payment has no draft state. The money has already gone by the time anyone
 * types it in, so there is nothing to decide later — and the posting is the
 * record of that departure.
 */
import type { ClientSession } from "mongoose";
import { z } from "zod";

import { BillModel, PaymentAllocationModel, PaymentModel } from "./purchases.model.js";
import { TaxRateModel } from "../masterdata/catalogs.model.js";
import {
  openBills,
  partyNamesFor,
  recomputeBillSettlement,
  resolveSupplier,
  type OpenBillRow,
} from "./purchases.support.js";
import { inTransaction, postJournal, type JournalLineInput } from "../../core/posting.js";
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

export const PaymentAllocationInput = z.object({
  bill_id: ObjectIdInput,
  amount_bdt: MoneyInput,
});

/**
 * One tax withheld from this payment (plan §6 Phase 7).
 *
 * The amount is stated by the payer rather than computed from the rate, because
 * a withholding is a legal obligation with its own exemptions and thresholds —
 * the rate is recorded so the certificate and the register can state it, not so
 * the ledger can decide what was owed.
 */
export const PaymentWithholdingInput = z.object({
  tax_code: z.string().trim().min(1, "Name the withholding rate.").max(24),
  amount_bdt: MoneyInput,
});

export const CreatePaymentSchema = z.object({
  party_id: ObjectIdInput,
  date: DateInput,
  method: z.enum(["CASH", "BANK"]).default("BANK"),
  /** Blank picks the conventional account for the method (1010 bank / 1000 cash). */
  account_code: z.string().trim().max(24).default(""),
  /** What the payment *settles* on the supplier's account, before withholding. */
  amount_bdt: MoneyInput,
  /**
   * Tax deducted from this payment and owed to the tax office instead of the
   * supplier: `DR AP amount / CR cash (amount − withheld) / CR source tax payable`.
   */
  withholdings: z.array(PaymentWithholdingInput).max(10).default([]),
  memo: z.string().trim().max(300).default(""),
  /** Empty means "allocate oldest-first"; anything else is applied as given. */
  allocations: z.array(PaymentAllocationInput).max(200).default([]),
});

export const ListPaymentQuery = z.object({
  party_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export type CreatePaymentInput = z.output<typeof CreatePaymentSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface PaymentAllocationView {
  id: string;
  bill_id: string;
  bill_no: string | null;
  amount_bdt: string;
}

export interface PaymentWithholdingView {
  tax_code: string;
  tax_rate_snapshot: string;
  amount_bdt: string;
}

export interface PaymentView {
  id: string;
  doc_no: string;
  party_id: string;
  party_code: string;
  party_name: string;
  date: string;
  method: "CASH" | "BANK";
  account_code: string;
  account_name: string;
  /** What the payment settles on the supplier's account, before withholding. */
  amount_bdt: string;
  allocated_bdt: string;
  /** The prepayment: paid, not yet claimed by a bill. */
  unallocated_bdt: string;
  /** Withheld from this payment and owed to the tax office instead (P7). */
  withheld_bdt: string;
  /** What actually left the bank: `amount − withheld`. */
  cash_bdt: string;
  withholdings: PaymentWithholdingView[];
  memo: string;
  journal_entry_id: string | null;
  allocations: PaymentAllocationView[];
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

interface PlannedAllocation {
  bill: OpenBillRow;
  amount: Money;
}

/**
 * Decide what this payment settles.
 *
 * Explicit allocations are validated against the bill's **live** outstanding
 * rather than trusted: the outstanding shown to the user is a cached figure, and
 * a stale screen must not be able to over-settle a bill. The oldest-first
 * default applies the money to the oldest debt first and simply stops when the
 * payment runs out — whatever is left is the prepayment.
 */
function planAllocations(
  paymentAmount: Money,
  explicit: readonly { bill_id: string; amount_bdt: string }[],
  open: readonly OpenBillRow[],
): PlannedAllocation[] {
  const byId = new Map(open.map((row) => [row.id, row]));

  if (explicit.length > 0) {
    const plan: PlannedAllocation[] = [];
    let remaining = paymentAmount;

    for (const entry of explicit) {
      const bill = byId.get(entry.bill_id);
      if (!bill) {
        throw new AppError(
          422,
          "BILL_NOT_OPEN",
          "One of the bills you picked is not open — it may already be settled, or belong to another supplier.",
        );
      }
      const amount = money(entry.amount_bdt);
      if (amount.isNegative()) {
        throw new AppError(422, "INVALID_AMOUNT", "An allocation cannot be negative.");
      }
      if (amount.isZero()) continue;
      if (amount.greaterThan(bill.outstanding)) {
        throw new AppError(
          422,
          "ALLOCATION_EXCEEDS_BALANCE",
          `Bill ${bill.doc_no ?? bill.id} only has ${fmt(bill.outstanding)} outstanding, so ${fmt(amount)} cannot be applied to it.`,
        );
      }
      if (amount.greaterThan(remaining)) {
        throw new AppError(
          422,
          "ALLOCATION_EXCEEDS_PAYMENT",
          `The allocations total more than the ${fmt(paymentAmount)} paid. Record the excess as a second payment, or leave it as a prepayment.`,
        );
      }
      plan.push({ bill, amount });
      remaining = remaining.minus(amount);
    }
    return plan;
  }

  const plan: PlannedAllocation[] = [];
  let remaining = paymentAmount;
  // `openBills` is already ordered oldest-first, so the default rule is the
  // iteration order rather than a sort here that could drift from it.
  for (const bill of open) {
    // Same zero-trap as above: a payment exactly consumed must stop here, not
    // trail 0.00 allocation rows across every remaining open bill.
    if (!remaining.greaterThan(ZERO)) break;
    const amount = remaining.greaterThan(bill.outstanding) ? bill.outstanding : remaining;
    plan.push({ bill, amount: toPaisa(amount) });
    remaining = remaining.minus(amount);
  }
  return plan;
}

/** A withholding resolved against the catalog, with the rate it was taken at. */
interface ResolvedWithholding {
  tax_code: string;
  tax_rate_snapshot: string;
  amount_bdt: string;
  amount: Money;
}

/**
 * Resolve the withholding rates a payment names.
 *
 * The *kind* is checked, not merely the code: withholding and VAT post to
 * different control accounts, and letting a VAT code be deducted here would put
 * output VAT into the source-tax liability and break the I5 tie-out on both
 * sides at once. A VAT code on a payment is a mistake worth a clear refusal.
 *
 * The amount is taken as given rather than computed from the rate, because a
 * withholding has exemptions and thresholds of its own — the rate is recorded so
 * the register and the certificate can state it, not so the ledger can overrule
 * whoever answered the tax question.
 */
async function resolveWithholdings(
  orgId: string,
  entries: readonly { tax_code: string; amount_bdt: string }[],
): Promise<ResolvedWithholding[]> {
  if (entries.length === 0) return [];

  const codes = [...new Set(entries.map((entry) => entry.tax_code))];
  const rates = await TaxRateModel.find({ org_id: orgId, code: { $in: codes }, is_active: true }).lean();
  const byCode = new Map(rates.map((rate) => [rate.code, rate]));

  const out: ResolvedWithholding[] = [];
  for (const entry of entries) {
    const rate = byCode.get(entry.tax_code);
    if (!rate) {
      throw new AppError(
        422,
        "TAX_RATE_NOT_FOUND",
        `No active tax rate with code ${entry.tax_code} exists in this ledger.`,
      );
    }
    if (rate.kind !== "WITHHOLDING") {
      throw new AppError(
        422,
        "TAX_CODE_NOT_APPLICABLE",
        `${entry.tax_code} (${rate.name}) is a VAT rate. Only a withholding rate can be deducted from a payment — the two post to different control accounts.`,
      );
    }
    const amount = toPaisa(money(entry.amount_bdt));
    if (amount.isNegative()) {
      throw new AppError(422, "INVALID_AMOUNT", "A withholding cannot be negative.");
    }
    if (amount.isZero()) continue;
    out.push({
      tax_code: rate.code,
      tax_rate_snapshot: rate.rate_percent,
      amount_bdt: fmt(amount),
      amount,
    });
  }
  return out;
}

export interface PaymentResult {
  payment: PaymentView;
  warnings: { code: string; message: string }[];
}

export async function createPayment(
  orgId: string,
  uid: string,
  input: CreatePaymentInput,
  ip?: string,
): Promise<PaymentResult> {
  const party = await resolveSupplier(orgId, input.party_id);
  const amount = money(input.amount_bdt);
  // `greaterThan`, not `isPositive`: decimal.js reads "0.00" (a positive-signed
  // zero) as positive, so the old guard could never fire.
  if (!amount.greaterThan(ZERO)) {
    throw new AppError(422, "INVALID_AMOUNT", "A payment needs an amount greater than zero.");
  }

  // The account the money left must be one the ledger can pay from. A revenue
  // account here would post a supplier payment as a sale.
  const depositCode = input.account_code || (input.method === "BANK" ? CONTROL_ACCOUNT.BANK : CONTROL_ACCOUNT.CASH);
  const deposit = await requireAccountByCode(orgId, depositCode);
  if (deposit.type !== "ASSET") {
    throw new AppError(
      422,
      "ACCOUNT_NOT_ASSET",
      `${deposit.code} (${deposit.name}) is a ${deposit.type.toLowerCase()} account. Money leaves an asset account such as ${CONTROL_ACCOUNT.BANK}.`,
    );
  }

  // P7: what is withheld goes to the tax office instead of the supplier. The
  // supplier's account still settles in full — that is what a withholding *is* —
  // and only the cash that leaves the bank is smaller.
  const withholdings = await resolveWithholdings(orgId, input.withholdings);
  const withheld = toPaisa(withholdings.reduce((acc, entry) => acc.plus(entry.amount), money(0)));
  if (withheld.greaterThan(amount)) {
    throw new AppError(
      422,
      "WITHHOLDING_EXCEEDS_PAYMENT",
      `Withholding ${fmt(withheld)} is more than the ${fmt(amount)} this payment settles.`,
    );
  }
  const cash = toPaisa(amount.minus(withheld));
  if (!cash.greaterThan(ZERO)) {
    throw new AppError(
      422,
      "NOTHING_TO_PAY",
      "Withholding covers the whole payment, so no money would move. Reduce the withholding or the amount.",
    );
  }

  return inTransaction(async (session) => {
    const open = await openBills(orgId, { partyId: party.id, session });
    const plan = planAllocations(amount, input.allocations, open);
    const allocated = toPaisa(plan.reduce((acc, entry) => acc.plus(entry.amount), money(0)));
    const unallocated = toPaisa(amount.minus(allocated));

    const allocation = await allocateNumber(orgId, "payment", input.date);
    const description = `Payment ${allocation.number} — ${party.name}`;

    // Every write here carries the session. `create` without it would commit the
    // payment outside the transaction while its journal entry stayed inside — and
    // the transactional read just below would not even see the row it had just
    // written, because the transaction's snapshot predates it.
    const payment = await PaymentModel.create(
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
          withheld_bdt: fmt(withheld),
          cash_bdt: fmt(cash),
          withholdings: withholdings.map((entry) => ({
            tax_code: entry.tax_code,
            tax_rate_snapshot: entry.tax_rate_snapshot,
            amount_bdt: entry.amount_bdt,
          })),
          memo: input.memo,
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((created) => created[0]!);

    // The supplier's balance falls by what the payment settles; the money leaves
    // the account; and anything withheld is owed to the tax office rather than
    // to the supplier. With no withholding this is exactly the two lines it
    // always was — the allocation split is a sub-ledger fact, not a
    // general-ledger one.
    const lines: JournalLineInput[] = [
      {
        account_code: party.control_account_code,
        debit_bdt: fmt(amount),
        memo: description,
        party_id: party.id,
      },
    ];
    if (cash.greaterThan(ZERO)) {
      lines.push({ account_code: deposit.code, credit_bdt: fmt(cash), memo: description });
    }
    for (const entry of withholdings) {
      lines.push({
        account_code: CONTROL_ACCOUNT.WITHHOLDING,
        credit_bdt: entry.amount_bdt,
        memo: `${description} — ${entry.tax_code} withheld`,
      });
    }

    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description,
        source: "PAYMENT",
        source_id: String(payment._id),
        lines,
        ...(ip ? { ip } : {}),
      },
      session,
    );

    if (plan.length > 0) {
      await PaymentAllocationModel.insertMany(
        plan.map((entryLine) => ({
          org_id: orgId,
          payment_id: payment._id,
          bill_id: entryLine.bill.id,
          party_id: party.id,
          amount_bdt: fmt(entryLine.amount),
        })),
        { session },
      );
    }

    // Each affected bill's cache is rewritten from the allocation rows inside
    // this transaction. Two payments racing on one bill therefore both write the
    // bill and MongoDB resolves the conflict by aborting one, so the
    // over-settlement check above cannot be defeated by timing.
    for (const touched of new Set(plan.map((entry) => entry.bill.id))) {
      await recomputeBillSettlement(orgId, touched, session);
    }

    await PaymentModel.updateOne(
      { _id: payment._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session },
    );

    // Phase 10: the part no bill claimed is money the supplier is holding from
    // us. Park it as a prepayment **in this same transaction** (ADR 0004 §6),
    // with no journal entry of its own — the movement is already in the payment
    // entry above, so posting again would double the debit on their account.
    await parkRemainder(
      orgId,
      uid,
      {
        partyId: party.id,
        date: input.date,
        amount: unallocated,
        accountCode: deposit.code,
        accountName: deposit.name,
        source: "PAYMENT_PREPAYMENT",
        sourceDocNo: allocation.number,
        notes: input.memo,
      },
      session,
    );

    const view: PaymentView = {
      ...(await paymentView(orgId, String(payment._id), session)),
      party_code: party.code,
      party_name: party.name,
    };
    const warnings = paymentWarnings(plan, unallocated, withheld);

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.payment",
        entityId: view.id,
        action: "PAYMENT_RECORDED",
        after: {
          doc_no: view.doc_no,
          amount_bdt: view.amount_bdt,
          allocated_bdt: view.allocated_bdt,
          unallocated_bdt: view.unallocated_bdt,
          withheld_bdt: view.withheld_bdt,
          cash_bdt: view.cash_bdt,
          bills: view.allocations.map((row) => row.bill_id),
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return { payment: view, warnings };
  });
}

/** Non-blocking advice about what this payment settled. */
function paymentWarnings(
  plan: readonly PlannedAllocation[],
  unallocated: Money,
  withheld: Money = ZERO,
): { code: string; message: string }[] {
  const warnings: { code: string; message: string }[] = [];
  const today = todayInLedgerZone();

  const overdue = plan.filter((entry) => entry.bill.due_date < today);
  if (overdue.length > 0) {
    warnings.push({
      code: "SETTLED_OVERDUE",
      message: `${overdue.length} of the bills this payment settles were already past due.`,
    });
  }

  // "0.00" is positive-signed, so `isPositive()` warned on every fully-allocated
  // payment; only a real prepayment should warn.
  if (unallocated.greaterThan(ZERO)) {
    warnings.push({
      code: "PREPAYMENT_PARKED",
      message: `${fmt(unallocated)} is more than we owed this supplier. It is held as a prepayment and will settle their next bill.`,
    });
  }

  // Advice, not a refusal: the withholding is already posted, and the person
  // should be told that the money is now a liability with a deadline rather
  // than a payment that failed to leave.
  if (withheld.greaterThan(ZERO)) {
    warnings.push({
      code: "TAX_WITHHELD",
      message: `${fmt(withheld)} was withheld and is owed to the tax office, not the supplier. Deposit it with a tax challan to clear the liability.`,
    });
  }

  return warnings;
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

async function paymentView(
  orgId: string,
  id: string,
  session?: ClientSession | null,
): Promise<PaymentView> {
  const doc = await PaymentModel.findOne({ _id: id, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!doc) throw notFoundError("That payment does not exist.");

  return shapePayment(doc, await allocationsOf(orgId, id, session));
}

async function allocationsOf(
  orgId: string,
  paymentId: string,
  session?: ClientSession | null,
): Promise<PaymentAllocationView[]> {
  const rows = await PaymentAllocationModel.find({ org_id: orgId, payment_id: paymentId })
    .session(session ?? null)
    .lean();
  if (rows.length === 0) return [];

  // The bill numbers are what the allocation picker showed, so they are what the
  // payment prints. Read from the bill rather than snapshotted: a bill number
  // never changes once issued, so there is nothing to drift.
  const bills = await BillModel.find({ org_id: orgId, _id: { $in: rows.map((row) => row.bill_id) } })
    .select({ doc_no: 1 })
    .lean();
  const numbers = new Map(bills.map((row) => [String(row._id), row.doc_no ?? null]));

  return rows.map((row) => ({
    id: String(row._id),
    bill_id: String(row.bill_id),
    bill_no: numbers.get(String(row.bill_id)) ?? null,
    amount_bdt: row.amount_bdt ?? "0.00",
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapePayment(doc: any, allocations: readonly PaymentAllocationView[]): PaymentView {
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
    withheld_bdt: doc.withheld_bdt ?? "0.00",
    cash_bdt: doc.cash_bdt ?? doc.amount_bdt,
    withholdings: (doc.withholdings ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row: any): PaymentWithholdingView => ({
        tax_code: row.tax_code,
        tax_rate_snapshot: row.tax_rate_snapshot ?? "0.00",
        amount_bdt: row.amount_bdt,
      }),
    ),
    memo: doc.memo ?? "",
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    allocations: [...allocations],
  };
}

export async function getPayment(orgId: string, id: string): Promise<PaymentView> {
  assertObjectId(id, "That payment does not exist.");
  const doc = await PaymentModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That payment does not exist.");

  const names = await partyNamesFor(orgId, [doc.party_id]);
  const label = names.get(String(doc.party_id));
  const view = shapePayment(doc, await allocationsOf(orgId, id));
  return { ...view, party_code: label?.code ?? "", party_name: label?.name ?? "" };
}

export async function listPayments(
  orgId: string,
  query: z.output<typeof ListPaymentQuery>,
): Promise<PaymentView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await PaymentModel.find(filter).sort({ date: -1, doc_seq: -1 }).limit(query.limit).lean();
  if (rows.length === 0) return [];

  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));
  const allocations = await PaymentAllocationModel.find({
    org_id: orgId,
    payment_id: { $in: rows.map((row) => row._id) },
  }).lean();
  const bills = await BillModel.find({
    org_id: orgId,
    _id: { $in: allocations.map((row) => row.bill_id) },
  })
    .select({ doc_no: 1 })
    .lean();
  const numbers = new Map(bills.map((row) => [String(row._id), row.doc_no ?? null]));

  return rows.map((row) => {
    const label = names.get(String(row.party_id));
    const mine: PaymentAllocationView[] = allocations
      .filter((allocation) => String(allocation.payment_id) === String(row._id))
      .map((allocation) => ({
        id: String(allocation._id),
        bill_id: String(allocation.bill_id),
        bill_no: numbers.get(String(allocation.bill_id)) ?? null,
        amount_bdt: allocation.amount_bdt ?? "0.00",
      }));

    return {
      ...shapePayment(row, mine),
      party_code: label?.code ?? "",
      party_name: label?.name ?? "",
    };
  });
}
