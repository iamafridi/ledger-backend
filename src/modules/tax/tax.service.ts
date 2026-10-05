/**
 * Tax — the VAT return, the withholding register, challans and certificates
 * (plan §6 Phase 7).
 *
 * A RETURN IS A READ, NOT A RECORD
 * There is no `vatReturns` collection, deliberately. The tax on a document is
 * already on the document's lines, snapshotted at the rate it was issued under
 * (§5.4), and a payment already carries what was withheld from it. So a return
 * is a *view* over those rows for one fiscal month, and there is nothing to
 * reconcile against a second copy of the same numbers — which is precisely the
 * failure a stored return invites: the ledger moves, the stored return does not,
 * and somebody has to work out which one the tax office was told.
 *
 * WHAT TIES THE RETURN TO THE BOOKS
 * The same lines that build the return are what the VAT control accounts hold
 * (`1300` input, `2100` output), because the posting engine puts them there from
 * the identical line snapshots. So the return's figure and the control account's
 * balance are two readings of one set of facts, and `RunIntegrityChecks`
 * asserts they agree — the `I5` obligation the phase exits on.
 *
 * A VOIDED DOCUMENT IS EXCLUDED, NOT REVERSED
 * Voiding writes a reversing journal entry, so the ledger nets to zero for a
 * voided invoice. The return matches that by skipping documents whose status is
 * `VOID` rather than by adding the reversal back in: the arithmetic then follows
 * the document, which is what a person reading the return expects to see.
 */
import { Types } from "mongoose";
import { Decimal } from "decimal.js";
import { z } from "zod";

import { TaxCertificateModel, TaxChallanModel } from "./tax.model.js";
import { BillLineModel, BillModel, DebitNoteModel, PaymentModel } from "../purchases/purchases.model.js";
import { CreditNoteModel, InvoiceLineModel, InvoiceModel } from "../sales/sales.model.js";
import { JournalLineModel } from "../journals/journal.model.js";
import { partyNamesFor, resolveSupplier } from "../purchases/purchases.support.js";
import {
  accumulateBands,
  finalizeBands,
  roundingNote,
  type BandAccumulator,
  type TaxBand,
  type TaxableLine,
} from "../../core/tax.js";
import { fmt, money, sub, sum, ZERO, type Money } from "../../core/money.js";
import { endOfMonth, formatMonthLong } from "../../core/calendar.js";
import { inTransaction, postJournal } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import { requireAccountByCode } from "../coa/coa.service.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput, MonthInput, ObjectIdInput } from "../../shared/validation/schemas.js";

/** Journal statuses that count in the books — the pair a void nets to zero over
 *  (see `core/integrity.ts`, where the same constant is stated). */
const IN_BOOKS = ["POSTED", "VOID"];

/* ── Input ───────────────────────────────────────────────────────────────── */

export const CreateChallanSchema = z.object({
  date: DateInput,
  amount_bdt: MoneyInput,
  /** Blank picks the conventional account money is deposited from (1010). */
  account_code: z.string().trim().max(24).default(""),
  /** The tax office's own reference for this deposit, as printed on their receipt. */
  challan_ref: z.string().trim().max(60).default(""),
  memo: z.string().trim().max(300).default(""),
});

export const CreateCertificateSchema = z.object({
  party_id: ObjectIdInput,
  /** The fiscal month the certificate covers. */
  month: MonthInput,
});

export const ListTaxDocumentsQuery = z.object({
  party_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const VatReturnQuery = z.object({
  month: MonthInput,
});

export type CreateChallanInput = z.output<typeof CreateChallanSchema>;
export type CreateCertificateInput = z.output<typeof CreateCertificateSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

/** One side of the return — output or input — as bands plus the three figures
 *  that matter: what the lines came to, and what the return declares. */
export interface VatSideReturn {
  bands: TaxBand[];
  net_bdt: string;
  /** The book figure: the tax as the lines recorded it, to the paisa. */
  tax_bdt: string;
  /** The declared figure: each band truncated to whole taka, then added. */
  declared_bdt: string;
}

export interface VatReturnView {
  month: string;
  month_label: string;
  from: string;
  to: string;
  output: VatSideReturn;
  input: VatSideReturn;
  /** Books: output tax − input tax, to the paisa. */
  net_payable_bdt: string;
  /** The return: truncated output − truncated input, in whole taka. */
  net_payable_declared_bdt: string;
  /** `net_payable − net_payable_declared`, shown rather than hidden. */
  rounding_difference_bdt: string;
  rounding_note: string;
  controls: {
    output_account_code: string;
    /** What 2100 holds, all time (credit-normal). */
    output_balance_bdt: string;
    input_account_code: string;
    /** What 1300 holds, all time (debit-normal). */
    input_balance_bdt: string;
    withholding_account_code: string;
    /** What 2200 holds, all time (credit-normal). */
    withholding_balance_bdt: string;
    withheld_to_date_bdt: string;
    deposited_to_date_bdt: string;
    withholding_outstanding_bdt: string;
  };
  documents: { invoices: number; credit_notes: number; bills: number; debit_notes: number };
}

export interface WithholdingRow {
  payment_id: string;
  doc_no: string;
  date: string;
  party_id: string;
  party_code: string;
  party_name: string;
  tax_code: string;
  tax_rate_snapshot: string;
  amount_bdt: string;
  payment_amount_bdt: string;
  /** Whether an issued certificate already covers this party and month. */
  certified: boolean;
}

export interface WithholdingRegisterView {
  rows: WithholdingRow[];
  totals: { tax_code: string; amount_bdt: string }[];
  total_bdt: string;
  /** What has been deposited with the tax office, from challans. */
  deposited_bdt: string;
  /** Withheld and not yet deposited — the liability 2200 still carries. */
  outstanding_bdt: string;
}

export interface ChallanView {
  id: string;
  doc_no: string;
  date: string;
  amount_bdt: string;
  account_code: string;
  account_name: string;
  challan_ref: string;
  memo: string;
  journal_entry_id: string | null;
}

export interface CertificateView {
  id: string;
  doc_no: string;
  party_id: string;
  party_code: string;
  party_name: string;
  date: string;
  period_key: string;
  amount_bdt: string;
  withholdings: { tax_code: string; tax_rate_snapshot: string; amount_bdt: string }[];
  status: "ISSUED" | "VOID";
}

/* ── Small shared reads ──────────────────────────────────────────────────── */

/** What a chart account holds right now, in the one sign its type implies. */
async function ledgerBalance(orgId: string, accountCode: string, debitNormal: boolean): Promise<Money> {
  const rows = await JournalLineModel.aggregate<{ debit: unknown; credit: unknown }>([
    { $match: { org_id: new Types.ObjectId(orgId), account_code: accountCode } },
    { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
    { $unwind: "$entry" },
    { $match: { "entry.status": { $in: IN_BOOKS } } },
    {
      $group: {
        _id: null,
        debit: { $sum: { $toDecimal: "$debit_bdt" } },
        credit: { $sum: { $toDecimal: "$credit_bdt" } },
      },
    },
    { $addFields: { debit: { $toString: "$debit" }, credit: { $toString: "$credit" } } },
  ]);

  const row = rows[0];
  if (!row) return ZERO;
  const debit = new Decimal(String(row.debit));
  const credit = new Decimal(String(row.credit));
  return debitNormal ? debit.minus(credit) : credit.minus(debit);
}

/** Sum one money field across a collection for this organisation, over
 *  Decimal128 — never a float, for the same reason money never is. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function totalOf(model: any, orgId: string, field: string): Promise<Money> {
  const rows = (await model.aggregate([
    { $match: { org_id: new Types.ObjectId(orgId) } },
    { $group: { _id: null, total: { $sum: { $toDecimal: `$${field}` } } } },
    { $addFields: { total: { $toString: "$total" } } },
  ])) as { total: unknown }[];
  return rows[0]?.total == null ? ZERO : new Decimal(String(rows[0].total));
}

/** Shape one side's bands into the wire view. */
function sideOf(bands: TaxBand[]): VatSideReturn {
  return {
    bands,
    net_bdt: fmt(sum(bands.map((band) => money(band.net_bdt)))),
    tax_bdt: fmt(sum(bands.map((band) => money(band.tax_bdt)))),
    declared_bdt: fmt(sum(bands.map((band) => money(band.declared_bdt)))),
  };
}

/** Ids of the documents a line query filters on, or an empty list. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const idsOf = (rows: any[]): unknown[] => rows.map((row) => row._id);

/* ── The VAT return ──────────────────────────────────────────────────────── */

/**
 * Build the VAT return for one fiscal month.
 *
 * Sales side from issued invoices less their credit notes; purchase side from
 * issued bills less their debit notes; both read from the immutable line
 * snapshots rather than from the documents' stored totals, so a return for a
 * month whose rate has since changed still reports what was actually charged.
 */
export async function vatReturn(orgId: string, month: string): Promise<VatReturnView> {
  const from = `${month}-01`;
  const to = endOfMonth(month);
  const window = { $gte: from, $lte: to };

  const [invoices, creditNotes, bills, debitNotes] = await Promise.all([
    InvoiceModel.find({ org_id: orgId, status: { $ne: "VOID" }, date: window }).select({ _id: 1 }).lean(),
    CreditNoteModel.find({ org_id: orgId, status: { $ne: "VOID" }, date: window }).select({ _id: 1 }).lean(),
    BillModel.find({ org_id: orgId, status: { $ne: "VOID" }, date: window }).select({ _id: 1 }).lean(),
    DebitNoteModel.find({ org_id: orgId, status: { $ne: "VOID" }, date: window }).select({ _id: 1 }).lean(),
  ]);

  const [invoiceLines, creditLines, billLines, debitLines] = await Promise.all([
    InvoiceLineModel.find({ org_id: orgId, doc_type: "INVOICE", doc_id: { $in: idsOf(invoices) } }).lean(),
    InvoiceLineModel.find({ org_id: orgId, doc_type: "CREDIT_NOTE", doc_id: { $in: idsOf(creditNotes) } }).lean(),
    BillLineModel.find({ org_id: orgId, doc_type: "BILL", doc_id: { $in: idsOf(bills) } }).lean(),
    BillLineModel.find({ org_id: orgId, doc_type: "DEBIT_NOTE", doc_id: { $in: idsOf(debitNotes) } }).lean(),
  ]);

  // Output: invoices add, credit notes subtract — one band per rate code across
  // both, so "output VAT at 15%" is a single figure rather than two to net.
  const outputAcc = new Map<string, BandAccumulator>();
  accumulateBands(outputAcc, invoiceLines as TaxableLine[], 1);
  accumulateBands(outputAcc, creditLines as TaxableLine[], -1);
  const output = sideOf(finalizeBands(outputAcc));

  const inputAcc = new Map<string, BandAccumulator>();
  accumulateBands(inputAcc, billLines as TaxableLine[], 1);
  accumulateBands(inputAcc, debitLines as TaxableLine[], -1);
  const input = sideOf(finalizeBands(inputAcc));

  const netPayable = sub(money(output.tax_bdt), money(input.tax_bdt));
  const declared = sub(money(output.declared_bdt), money(input.declared_bdt));

  const [outputBalance, inputBalance, withholdingBalance, withheld, deposited] = await Promise.all([
    ledgerBalance(orgId, CONTROL_ACCOUNT.VAT_OUTPUT, false),
    ledgerBalance(orgId, CONTROL_ACCOUNT.VAT_INPUT, true),
    ledgerBalance(orgId, CONTROL_ACCOUNT.WITHHOLDING, false),
    totalOf(PaymentModel, orgId, "withheld_bdt"),
    totalOf(TaxChallanModel, orgId, "amount_bdt"),
  ]);

  return {
    month,
    month_label: formatMonthLong(month),
    from,
    to,
    output,
    input,
    net_payable_bdt: fmt(netPayable),
    net_payable_declared_bdt: fmt(declared),
    rounding_difference_bdt: fmt(sub(netPayable, declared)),
    rounding_note: roundingNote(netPayable, declared),
    controls: {
      output_account_code: CONTROL_ACCOUNT.VAT_OUTPUT,
      output_balance_bdt: fmt(outputBalance),
      input_account_code: CONTROL_ACCOUNT.VAT_INPUT,
      input_balance_bdt: fmt(inputBalance),
      withholding_account_code: CONTROL_ACCOUNT.WITHHOLDING,
      withholding_balance_bdt: fmt(withholdingBalance),
      withheld_to_date_bdt: fmt(withheld),
      deposited_to_date_bdt: fmt(deposited),
      withholding_outstanding_bdt: fmt(sub(withheld, deposited)),
    },
    documents: {
      invoices: invoices.length,
      credit_notes: creditNotes.length,
      bills: bills.length,
      debit_notes: debitNotes.length,
    },
  };
}

/** The rows a return exports as CSV, in the order the screen shows them. */
export function vatReturnRows(view: VatReturnView): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const side = (label: string, part: VatSideReturn): void => {
    for (const band of part.bands) {
      rows.push({
        side: label,
        tax_code: band.tax_code,
        rate_percent: band.rate_percent,
        net_bdt: band.net_bdt,
        tax_bdt: band.tax_bdt,
        declared_bdt: band.declared_bdt,
      });
    }
    rows.push({
      side: `${label} total`,
      tax_code: "",
      rate_percent: "",
      net_bdt: part.net_bdt,
      tax_bdt: part.tax_bdt,
      declared_bdt: part.declared_bdt,
    });
  };

  side("Output VAT", view.output);
  side("Input VAT", view.input);
  rows.push({
    side: "Net payable (books)",
    tax_code: "",
    rate_percent: "",
    net_bdt: "",
    tax_bdt: view.net_payable_bdt,
    declared_bdt: view.net_payable_declared_bdt,
  });
  rows.push({
    side: "Truncation difference",
    tax_code: "",
    rate_percent: "",
    net_bdt: "",
    tax_bdt: view.rounding_difference_bdt,
    declared_bdt: "",
  });

  return rows;
}

/* ── Withholding register ────────────────────────────────────────────────── */

/**
 * Every withholding taken, one row per payment per rate.
 *
 * `certified` is derived by looking for an issued certificate covering the same
 * supplier and month, so the register answers the only question it is read for:
 * what is still uncertified and therefore still unclaimed by the supplier.
 */
export async function withholdingRegister(
  orgId: string,
  query: z.output<typeof ListTaxDocumentsQuery>,
): Promise<WithholdingRegisterView> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const payments = await PaymentModel.find(filter)
    .sort({ date: -1, doc_seq: -1 })
    .limit(query.limit)
    .lean();

  const [names, certificates, deposited] = await Promise.all([
    partyNamesFor(orgId, payments.map((row) => row.party_id)),
    TaxCertificateModel.find({ org_id: orgId, status: "ISSUED" }).select({ party_id: 1, period_key: 1 }).lean(),
    totalOf(TaxChallanModel, orgId, "amount_bdt"),
  ]);

  const certified = new Set(certificates.map((row) => `${String(row.party_id)}/${row.period_key}`));

  const rows: WithholdingRow[] = [];
  for (const payment of payments) {
    const entries = (payment.withholdings ?? []) as { tax_code: string; tax_rate_snapshot: string; amount_bdt: string }[];
    // Filtered here rather than in the query: a payment with no withholding has
    // no field at all on rows written before P7, and a comparison against a
    // missing field would quietly exclude nothing while looking like it did.
    if (entries.length === 0) continue;

    const label = names.get(String(payment.party_id));
    const key = `${String(payment.party_id)}/${String(payment.date).slice(0, 7)}`;

    for (const entry of entries) {
      rows.push({
        payment_id: String(payment._id),
        doc_no: payment.doc_no,
        date: payment.date,
        party_id: String(payment.party_id),
        party_code: label?.code ?? "",
        party_name: label?.name ?? "",
        tax_code: entry.tax_code,
        tax_rate_snapshot: entry.tax_rate_snapshot ?? "0.00",
        amount_bdt: entry.amount_bdt,
        payment_amount_bdt: payment.amount_bdt,
        certified: certified.has(key),
      });
    }
  }

  const byCode = new Map<string, Money>();
  for (const row of rows) {
    byCode.set(row.tax_code, (byCode.get(row.tax_code) ?? ZERO).plus(money(row.amount_bdt)));
  }
  const total = sum(rows.map((row) => money(row.amount_bdt)));

  return {
    rows,
    totals: [...byCode.entries()]
      .map(([taxCode, amount]) => ({ tax_code: taxCode, amount_bdt: fmt(amount) }))
      .sort((a, b) => a.tax_code.localeCompare(b.tax_code)),
    total_bdt: fmt(total),
    deposited_bdt: fmt(deposited),
    outstanding_bdt: fmt(sub(total, deposited)),
  };
}

/* ── Challans ────────────────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeChallan(doc: any): ChallanView {
  return {
    id: String(doc._id),
    doc_no: doc.doc_no,
    date: doc.date,
    amount_bdt: doc.amount_bdt,
    account_code: doc.account_code,
    account_name: doc.account_name ?? "",
    challan_ref: doc.challan_ref ?? "",
    memo: doc.memo ?? "",
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
  };
}

/**
 * Record a deposit of withheld tax: `DR 2200 / CR cash-bank`.
 *
 * This is the only thing that clears the withholding liability, and it is a
 * real bank movement rather than a marker — the money has gone to the government
 * and the ledger has to say so, which is why it posts through the same engine as
 * every other payment.
 */
export async function createChallan(
  orgId: string,
  uid: string,
  input: CreateChallanInput,
  ip?: string,
): Promise<ChallanView> {
  const amount = money(input.amount_bdt);
  if (!amount.greaterThan(ZERO)) {
    throw new AppError(422, "INVALID_AMOUNT", "A challan needs an amount greater than zero.");
  }

  const depositCode = input.account_code || CONTROL_ACCOUNT.BANK;
  const deposit = await requireAccountByCode(orgId, depositCode);
  if (deposit.type !== "ASSET") {
    throw new AppError(
      422,
      "ACCOUNT_NOT_ASSET",
      `${deposit.code} (${deposit.name}) is a ${deposit.type.toLowerCase()} account. Tax is deposited from an asset account such as ${CONTROL_ACCOUNT.BANK}.`,
    );
  }

  return inTransaction(async (session) => {
    const allocation = await allocateNumber(orgId, "challan", input.date);
    const description = `Tax challan ${allocation.number}`;

    const created = await TaxChallanModel.create(
      [
        {
          org_id: orgId,
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          date: input.date,
          amount_bdt: fmt(amount),
          account_code: deposit.code,
          account_name: deposit.name,
          challan_ref: input.challan_ref,
          memo: input.memo,
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description,
        source: "TAX_CHALLAN",
        source_id: String(created._id),
        lines: [
          {
            account_code: CONTROL_ACCOUNT.WITHHOLDING,
            debit_bdt: fmt(amount),
            memo: `${description} — withholding deposited`,
          },
          { account_code: deposit.code, credit_bdt: fmt(amount), memo: description },
        ],
        ...(ip ? { ip } : {}),
      },
      session,
    );

    const updated = await TaxChallanModel.findOneAndUpdate(
      { _id: created._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { new: true, session },
    ).lean();
    if (!updated) throw notFoundError("That challan does not exist.");

    const view = shapeChallan(updated);
    await writeAudit(
      {
        orgId,
        uid,
        entity: "tax.challan",
        entityId: view.id,
        action: "CHALLAN_RECORDED",
        after: {
          doc_no: view.doc_no,
          date: view.date,
          amount_bdt: view.amount_bdt,
          challan_ref: view.challan_ref,
          journal_entry_id: view.journal_entry_id,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}

export async function listChallans(
  orgId: string,
  query: z.output<typeof ListTaxDocumentsQuery>,
): Promise<ChallanView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await TaxChallanModel.find(filter).sort({ date: -1, doc_seq: -1 }).limit(query.limit).lean();
  return rows.map(shapeChallan);
}

/* ── Certificates ────────────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shapeCertificate(doc: any, label?: { code: string; name: string }): CertificateView {
  return {
    id: String(doc._id),
    doc_no: doc.doc_no,
    party_id: String(doc.party_id),
    party_code: label?.code ?? "",
    party_name: label?.name ?? "",
    date: doc.date,
    period_key: doc.period_key,
    amount_bdt: doc.amount_bdt,
    withholdings: (doc.withholdings ?? []).map(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (row: any) => ({
        tax_code: row.tax_code,
        tax_rate_snapshot: row.tax_rate_snapshot ?? "0.00",
        amount_bdt: row.amount_bdt,
      }),
    ),
    status: doc.status,
  };
}

/**
 * Issue the certificate a supplier is given for one month's withholding.
 *
 * It posts nothing — the tax was withheld when the payment was made — so what
 * this records is that the paper exists and carries a number. Issuing a second
 * one for the same supplier and month is refused, because two certificates for
 * one month is exactly how the same tax gets claimed twice.
 */
export async function issueCertificate(
  orgId: string,
  uid: string,
  input: CreateCertificateInput,
  ip?: string,
): Promise<CertificateView> {
  const party = await resolveSupplier(orgId, input.party_id);

  const existing = await TaxCertificateModel.findOne({
    org_id: orgId,
    party_id: party.id,
    period_key: input.month,
    status: "ISSUED",
  }).lean();
  if (existing) {
    throw new AppError(
      409,
      "CERTIFICATE_EXISTS",
      `A withholding certificate (${existing.doc_no}) has already been issued to ${party.name} for ${input.month}.`,
    );
  }

  const from = `${input.month}-01`;
  const to = endOfMonth(input.month);
  const payments = await PaymentModel.find({
    org_id: orgId,
    party_id: party.id,
    date: { $gte: from, $lte: to },
  }).lean();

  const byCode = new Map<string, { rate: string; amount: Money }>();
  for (const payment of payments) {
    for (const entry of (payment.withholdings ?? []) as {
      tax_code: string;
      tax_rate_snapshot: string;
      amount_bdt: string;
    }[]) {
      const found = byCode.get(entry.tax_code);
      byCode.set(entry.tax_code, {
        rate: found?.rate ?? entry.tax_rate_snapshot ?? "0.00",
        amount: (found?.amount ?? ZERO).plus(money(entry.amount_bdt)),
      });
    }
  }

  if (byCode.size === 0) {
    throw new AppError(
      422,
      "NOTHING_TO_CERTIFY",
      `No tax was withheld from ${party.name} in ${input.month}, so there is nothing to certify.`,
    );
  }

  const lines = [...byCode.entries()]
    .map(([taxCode, entry]) => ({
      tax_code: taxCode,
      tax_rate_snapshot: entry.rate,
      amount_bdt: fmt(entry.amount),
    }))
    .sort((a, b) => a.tax_code.localeCompare(b.tax_code));
  const total = sum(lines.map((line) => money(line.amount_bdt)));

  return inTransaction(async (session) => {
    const date = endOfMonth(input.month);
    const allocation = await allocateNumber(orgId, "tax_certificate", date);

    const created = await TaxCertificateModel.create(
      [
        {
          org_id: orgId,
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          party_id: party.id,
          date,
          period_key: input.month,
          amount_bdt: fmt(total),
          withholdings: lines,
          status: "ISSUED",
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    const view = shapeCertificate(created.toObject(), { code: party.code, name: party.name });

    await writeAudit(
      {
        orgId,
        uid,
        entity: "tax.certificate",
        entityId: view.id,
        action: "CERTIFICATE_ISSUED",
        after: {
          doc_no: view.doc_no,
          party_id: view.party_id,
          period_key: view.period_key,
          amount_bdt: view.amount_bdt,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}

export async function listCertificates(
  orgId: string,
  query: z.output<typeof ListTaxDocumentsQuery>,
): Promise<CertificateView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await TaxCertificateModel.find(filter).sort({ date: -1, doc_seq: -1 }).limit(query.limit).lean();
  if (rows.length === 0) return [];

  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));
  return rows.map((row) => shapeCertificate(row, names.get(String(row.party_id))));
}
