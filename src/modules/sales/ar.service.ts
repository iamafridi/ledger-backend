/**
 * Accounts-receivable reads: what is owed, how late it is, and how a customer's
 * balance got where it is.
 *
 * These are all derived from the same rows the ledger is posted from — invoices,
 * receipts and their allocations, credit notes — and none of them keeps a total
 * of its own. A report that maintained its own running balance would eventually
 * disagree with the sub-ledger it summarises, and the disagreement would be
 * discovered by a customer rather than by us.
 *
 * ON BUCKETS
 * Aging is measured from the **due date**, falling back to the invoice date when
 * none was given (plan §6). The fallback is not a convenience: an invoice with no
 * due date is due on receipt, and treating it as "never late" would hide the
 * debts most likely to go bad.
 *
 * `daysBetween` is whole days between two calendar dates with no clock involved,
 * so an invoice due yesterday is exactly one day late — not 0.958 days, which
 * would land in the wrong bucket roughly half the time a report is run.
 */
import { z } from "zod";

import { CreditNoteModel, InvoiceModel, ReceiptModel } from "./sales.model.js";
import {
  openInvoices,
  partyArBalance,
  partyNamesFor,
  resolveCustomer,
  type OpenInvoiceRow,
} from "./sales.support.js";
import { add, fmt, money, sub, sum, toPaisa, type Money } from "../../core/money.js";
import { daysBetween } from "../../shared/dates/shift.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";
import { DateInput, ObjectIdInput } from "../../shared/validation/schemas.js";

export const AgingQuery = z.object({
  as_of: DateInput.optional(),
  party_id: ObjectIdInput.optional(),
});

export const OutstandingQuery = z.object({
  party_id: ObjectIdInput.optional(),
});

export const StatementQuery = z.object({
  from: DateInput.optional(),
  to: DateInput.optional(),
});

/* ── Buckets ─────────────────────────────────────────────────────────────── */

export const AGING_BUCKETS = [
  { key: "current", label: "Not yet due" },
  { key: "d1_30", label: "1–30 days" },
  { key: "d31_60", label: "31–60 days" },
  { key: "d61_90", label: "61–90 days" },
  { key: "d90_plus", label: "Over 90 days" },
] as const;

export type AgingBucketKey = (typeof AGING_BUCKETS)[number]["key"];

/** Which bucket a balance falls into, given how many days late it is. Zero or
 *  fewer is not late at all — a due date today is not an arrear. */
export function bucketFor(daysOverdue: number): AgingBucketKey {
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "d1_30";
  if (daysOverdue <= 60) return "d31_60";
  if (daysOverdue <= 90) return "d61_90";
  return "d90_plus";
}

/* ── Outstanding ─────────────────────────────────────────────────────────── */

export interface OutstandingInvoice {
  id: string;
  doc_no: string | null;
  party_id: string;
  party_code: string;
  party_name: string;
  date: string;
  due_date: string;
  total_bdt: string;
  outstanding_bdt: string;
  days_overdue: number;
  bucket: AgingBucketKey;
}

export interface OutstandingResult {
  as_of: string;
  total_bdt: string;
  invoices: OutstandingInvoice[];
}

/** Every open invoice, oldest first — the allocation picker and the chase list. */
export async function listOutstanding(
  orgId: string,
  query: z.output<typeof OutstandingQuery>,
  asOf = todayInLedgerZone(),
): Promise<OutstandingResult> {
  const rows = await openInvoices(orgId, query.party_id ? { partyId: query.party_id } : {});
  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));

  return {
    as_of: asOf,
    total_bdt: fmt(sum(rows.map((row) => row.outstanding))),
    invoices: rows.map((row) => shapeOutstanding(row, names, asOf)),
  };
}

function shapeOutstanding(
  row: OpenInvoiceRow,
  names: Map<string, { code: string; name: string }>,
  asOf: string,
): OutstandingInvoice {
  const days = daysBetween(row.due_date, asOf);
  const label = names.get(row.party_id);
  return {
    id: row.id,
    doc_no: row.doc_no,
    party_id: row.party_id,
    party_code: label?.code ?? "",
    party_name: label?.name ?? "",
    date: row.date,
    due_date: row.due_date,
    total_bdt: fmt(row.total),
    outstanding_bdt: fmt(row.outstanding),
    days_overdue: days,
    bucket: bucketFor(days),
  };
}

/* ── Aging ───────────────────────────────────────────────────────────────── */

export interface AgingPartyRow {
  party_id: string;
  party_code: string;
  party_name: string;
  current_bdt: string;
  d1_30_bdt: string;
  d31_60_bdt: string;
  d61_90_bdt: string;
  d90_plus_bdt: string;
  total_bdt: string;
  invoice_count: number;
}

export interface AgingReport {
  as_of: string;
  buckets: readonly { key: string; label: string }[];
  parties: AgingPartyRow[];
  totals: AgingPartyRow;
  /** The invoice-level detail the party rows are summed from, so an exact total
   *  can be traced to the documents that make it rather than trusted. */
  invoices: OutstandingInvoice[];
}

/** The column each bucket writes into. One table, so a bucket can never be
 *  added to the report and forgotten in the accumulator. */
const BUCKET_FIELD: Record<AgingBucketKey, keyof AgingPartyRow> = {
  current: "current_bdt",
  d1_30: "d1_30_bdt",
  d31_60: "d31_60_bdt",
  d61_90: "d61_90_bdt",
  d90_plus: "d90_plus_bdt",
};

function blankRow(invoice?: OutstandingInvoice): AgingPartyRow {
  return {
    party_id: invoice?.party_id ?? "",
    party_code: invoice?.party_code ?? "",
    party_name: invoice?.party_name ?? "",
    current_bdt: "0.00",
    d1_30_bdt: "0.00",
    d31_60_bdt: "0.00",
    d61_90_bdt: "0.00",
    d90_plus_bdt: "0.00",
    total_bdt: "0.00",
    invoice_count: 0,
  };
}

function accumulate(row: AgingPartyRow, invoice: OutstandingInvoice): AgingPartyRow {
  const amount = money(invoice.outstanding_bdt);
  const field = BUCKET_FIELD[invoice.bucket];

  return {
    ...row,
    [field]: fmt(add(money(row[field]), amount)),
    total_bdt: fmt(add(money(row.total_bdt), amount)),
    invoice_count: row.invoice_count + 1,
  };
}

/** The totals line: every column of every party row, added up. */
function sumRows(rows: readonly AgingPartyRow[]): AgingPartyRow {
  const add2 = (field: keyof AgingPartyRow): string =>
    fmt(sum(rows.map((row) => money(row[field] as string))));

  return {
    party_id: "",
    party_code: "",
    party_name: "Total",
    current_bdt: add2("current_bdt"),
    d1_30_bdt: add2("d1_30_bdt"),
    d31_60_bdt: add2("d31_60_bdt"),
    d61_90_bdt: add2("d61_90_bdt"),
    d90_plus_bdt: add2("d90_plus_bdt"),
    total_bdt: add2("total_bdt"),
    invoice_count: rows.reduce((acc, row) => acc + row.invoice_count, 0),
  };
}

/**
 * The AR aging report.
 *
 * Rows are per customer, columns are the buckets, and both the totals line and
 * the invoice-level detail are returned: a report whose figures cannot be traced
 * back to the documents that produced them is a report nobody can act on.
 */
export async function agingReport(
  orgId: string,
  query: z.output<typeof AgingQuery>,
  asOf = todayInLedgerZone(),
): Promise<AgingReport> {
  const rows = await openInvoices(orgId, query.party_id ? { partyId: query.party_id } : {});
  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));
  const invoices = rows.map((row) => shapeOutstanding(row, names, asOf));

  const byParty = new Map<string, AgingPartyRow>();
  for (const invoice of invoices) {
    byParty.set(invoice.party_id, accumulate(byParty.get(invoice.party_id) ?? blankRow(invoice), invoice));
  }

  const parties = [...byParty.values()].sort((a, b) => a.party_code.localeCompare(b.party_code));

  return {
    as_of: asOf,
    buckets: AGING_BUCKETS,
    parties,
    totals: sumRows(parties),
    invoices,
  };
}

/* ── Customer statement ──────────────────────────────────────────────────── */

export interface StatementMovement {
  date: string;
  type: "INVOICE" | "RECEIPT" | "CREDIT_NOTE";
  doc_no: string | null;
  description: string;
  /** What the customer owes more of. An invoice is a debit; money received and
   *  credit given are credits. */
  debit_bdt: string;
  credit_bdt: string;
  /** The balance after this movement, so the statement reads down the page. */
  balance_bdt: string;
}

export interface StatementResult {
  party_id: string;
  party_code: string;
  party_name: string;
  from: string | null;
  to: string | null;
  opening_bdt: string;
  closing_bdt: string;
  movements: StatementMovement[];
  advance_bdt: string;
}

/**
 * A customer's statement: opening balance, everything that moved, closing
 * balance.
 *
 * Built from all three document kinds at once and split at `from`, rather than
 * querying only the window — the opening balance *is* the net of everything
 * before it, and computing it any other way is how a statement and a ledger
 * diverge.
 *
 * Voided documents are excluded, for the same reason the ledger excludes them:
 * their reversal is posted, so including the original would double-count the
 * correction.
 */
export async function customerStatement(
  orgId: string,
  partyId: string,
  query: z.output<typeof StatementQuery>,
): Promise<StatementResult> {
  const party = await resolveCustomer(orgId, partyId);

  const [invoices, receipts, creditNotes] = await Promise.all([
    InvoiceModel.find({
      org_id: orgId,
      party_id: party.id,
      status: { $in: ["ISSUED", "PARTIALLY_PAID", "PAID"] },
    })
      .sort({ date: 1, doc_seq: 1 })
      .lean(),
    ReceiptModel.find({ org_id: orgId, party_id: party.id }).sort({ date: 1, doc_seq: 1 }).lean(),
    CreditNoteModel.find({ org_id: orgId, party_id: party.id, status: { $ne: "VOID" } })
      .sort({ date: 1, doc_seq: 1 })
      .lean(),
  ]);

  const events: {
    date: string;
    type: StatementMovement["type"];
    doc_no: string | null;
    description: string;
    amount: Money;
  }[] = [
    ...invoices.map((row) => ({
      date: row.date,
      type: "INVOICE" as const,
      doc_no: row.doc_no ?? null,
      description: row.memo || "Invoice",
      // The full document value: the statement tells the customer what they were
      // billed, whether or not they have since paid it.
      amount: money(row.total_bdt),
    })),
    ...receipts.map((row) => ({
      date: row.date,
      type: "RECEIPT" as const,
      doc_no: row.doc_no,
      description: row.memo || "Payment received",
      amount: money(row.amount_bdt).negated(),
    })),
    ...creditNotes.map((row) => ({
      date: row.date,
      type: "CREDIT_NOTE" as const,
      doc_no: row.doc_no,
      description: row.reason,
      amount: money(row.total_bdt).negated(),
    })),
  ].sort((a, b) =>
    a.date === b.date ? (a.doc_no ?? "").localeCompare(b.doc_no ?? "") : a.date.localeCompare(b.date),
  );

  const opening = toPaisa(
    sum(
      events
        .filter((event) => query.from !== undefined && event.date < query.from)
        .map((event) => event.amount),
    ),
  );

  let running = opening;
  const movements: StatementMovement[] = [];

  for (const event of events) {
    if (query.from !== undefined && event.date < query.from) continue;
    if (query.to !== undefined && event.date > query.to) continue;

    running = add(running, event.amount);
    const positive = event.amount.isPositive();
    movements.push({
      date: event.date,
      type: event.type,
      doc_no: event.doc_no,
      description: event.description,
      debit_bdt: positive ? fmt(event.amount) : "0.00",
      credit_bdt: positive ? "0.00" : fmt(event.amount.abs()),
      balance_bdt: fmt(running),
    });
  }

  return {
    party_id: party.id,
    party_code: party.code,
    party_name: party.name,
    from: query.from ?? null,
    to: query.to ?? null,
    opening_bdt: fmt(opening),
    closing_bdt: fmt(running),
    movements,
    advance_bdt: await partyAdvances(orgId, party.id),
  };
}

/* ── Credit status ───────────────────────────────────────────────────────── */

export interface CreditStatus {
  party_id: string;
  party_code: string;
  party_name: string;
  balance_bdt: string;
  credit_limit_bdt: string;
  /** Limit minus balance; negative when the customer is over it. */
  available_bdt: string;
  over_limit: boolean;
  overdue_bdt: string;
  oldest_overdue_days: number;
  open_invoice_count: number;
  advance_bdt: string;
}

/** Where a customer stands against their limit, and how late they are — the same
 *  figures the issue-time warning is built from, exposed so the screen can show
 *  them before somebody has to be warned. */
export async function creditStatus(
  orgId: string,
  partyId: string,
  asOf = todayInLedgerZone(),
): Promise<CreditStatus> {
  const party = await resolveCustomer(orgId, partyId);
  const [balance, rows, advance] = await Promise.all([
    partyArBalance(orgId, party.id),
    openInvoices(orgId, { partyId: party.id }),
    partyAdvances(orgId, party.id),
  ]);

  const overdueRows = rows.filter((row) => row.due_date < asOf);
  const overdue = sum(overdueRows.map((row) => row.outstanding));
  const oldest = overdueRows.reduce((acc, row) => Math.max(acc, daysBetween(row.due_date, asOf)), 0);
  const limit = money(party.credit_limit_bdt);

  return {
    party_id: party.id,
    party_code: party.code,
    party_name: party.name,
    balance_bdt: fmt(balance),
    credit_limit_bdt: fmt(limit),
    available_bdt: fmt(sub(limit, balance)),
    over_limit: limit.isPositive() && balance.greaterThan(limit),
    overdue_bdt: fmt(overdue),
    oldest_overdue_days: oldest,
    open_invoice_count: rows.length,
    advance_bdt: advance,
  };
}

/** The unallocated part of every receipt for a party — their advance, shown
 *  separately from the balance it already reduces. */
export async function partyAdvances(orgId: string, partyId: string): Promise<string> {
  const rows = await ReceiptModel.find({ org_id: orgId, party_id: partyId })
    .select({ unallocated_bdt: 1 })
    .lean();
  return fmt(sum(rows.map((row) => money(row.unallocated_bdt))));
}
