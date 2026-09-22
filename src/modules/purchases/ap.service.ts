/**
 * Accounts-payable reads: what we owe, how late it is, and how a supplier's
 * balance got where it is.
 *
 * These are all derived from the same rows the ledger is posted from — bills,
 * payments and their allocations, debit notes — and none of them keeps a total
 * of its own. A report that maintained its own running balance would eventually
 * disagree with the sub-ledger it summarises, and the disagreement would be
 * discovered by a supplier chasing a payment we believe we already made.
 *
 * ON BUCKETS
 * Aging is measured from the **due date**, falling back to the bill date when
 * none was given (plan §6). The fallback is not a convenience: a bill with no
 * due date is payable on receipt, and treating it as "never late" would hide
 * exactly the debts about to cost us a late charge.
 *
 * `daysBetween` is whole days between two calendar dates with no clock involved,
 * so a bill due yesterday is exactly one day late — not 0.958 days, which would
 * land in the wrong bucket roughly half the time a report is run.
 */
import { z } from "zod";

import { BillModel, DebitNoteModel, PaymentModel } from "./purchases.model.js";
import {
  openBills,
  partyApBalance,
  partyNamesFor,
  partyPrepayments,
  resolveSupplier,
  type OpenBillRow,
} from "./purchases.support.js";
import { add, fmt, money, sum, toPaisa, type Money } from "../../core/money.js";
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

export interface OutstandingBill {
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
  bills: OutstandingBill[];
}

/** Every open bill, oldest first — the payment picker and the "what do we pay
 *  this week" list. */
export async function listOutstanding(
  orgId: string,
  query: z.output<typeof OutstandingQuery>,
  asOf = todayInLedgerZone(),
): Promise<OutstandingResult> {
  const rows = await openBills(orgId, query.party_id ? { partyId: query.party_id } : {});
  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));

  return {
    as_of: asOf,
    total_bdt: fmt(sum(rows.map((row) => row.outstanding))),
    bills: rows.map((row) => shapeOutstanding(row, names, asOf)),
  };
}

function shapeOutstanding(
  row: OpenBillRow,
  names: Map<string, { code: string; name: string }>,
  asOf: string,
): OutstandingBill {
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
  bill_count: number;
}

export interface AgingReport {
  as_of: string;
  buckets: readonly { key: string; label: string }[];
  parties: AgingPartyRow[];
  totals: AgingPartyRow;
  /** The bill-level detail the party rows are summed from, so an exact total can
   *  be traced to the documents that make it rather than trusted. */
  bills: OutstandingBill[];
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

function blankRow(bill?: OutstandingBill): AgingPartyRow {
  return {
    party_id: bill?.party_id ?? "",
    party_code: bill?.party_code ?? "",
    party_name: bill?.party_name ?? "",
    current_bdt: "0.00",
    d1_30_bdt: "0.00",
    d31_60_bdt: "0.00",
    d61_90_bdt: "0.00",
    d90_plus_bdt: "0.00",
    total_bdt: "0.00",
    bill_count: 0,
  };
}

function accumulate(row: AgingPartyRow, bill: OutstandingBill): AgingPartyRow {
  const amount = money(bill.outstanding_bdt);
  const field = BUCKET_FIELD[bill.bucket];

  return {
    ...row,
    [field]: fmt(add(money(row[field]), amount)),
    total_bdt: fmt(add(money(row.total_bdt), amount)),
    bill_count: row.bill_count + 1,
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
    bill_count: rows.reduce((acc, row) => acc + row.bill_count, 0),
  };
}

/**
 * The AP aging report.
 *
 * Rows are per supplier, columns are the buckets, and both the totals line and
 * the bill-level detail are returned: a report whose figures cannot be traced
 * back to the documents that produced them is a report nobody can act on.
 */
export async function agingReport(
  orgId: string,
  query: z.output<typeof AgingQuery>,
  asOf = todayInLedgerZone(),
): Promise<AgingReport> {
  const rows = await openBills(orgId, query.party_id ? { partyId: query.party_id } : {});
  const names = await partyNamesFor(orgId, rows.map((row) => row.party_id));
  const bills = rows.map((row) => shapeOutstanding(row, names, asOf));

  const byParty = new Map<string, AgingPartyRow>();
  for (const bill of bills) {
    byParty.set(bill.party_id, accumulate(byParty.get(bill.party_id) ?? blankRow(bill), bill));
  }

  const parties = [...byParty.values()].sort((a, b) => a.party_code.localeCompare(b.party_code));

  return {
    as_of: asOf,
    buckets: AGING_BUCKETS,
    parties,
    totals: sumRows(parties),
    bills,
  };
}

/* ── Supplier statement ──────────────────────────────────────────────────── */

export interface StatementMovement {
  date: string;
  type: "BILL" | "PAYMENT" | "DEBIT_NOTE";
  doc_no: string | null;
  description: string;
  /** What we owe more of. A bill is a credit to payables; money paid and debit
   *  notes given back are debits. */
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
  prepaid_bdt: string;
}

/**
 * A supplier's statement: opening balance, everything that moved, closing
 * balance.
 *
 * Built from all three document kinds at once and split at `from`, rather than
 * querying only the window — the opening balance *is* the net of everything
 * before it, and computing it any other way is how a statement and a ledger
 * diverge.
 *
 * The sign convention is the ledger's, not the customer statement's: a bill
 * **credits** the payable and so lands in the credit column, while a payment and
 * a debit note debit it. `balance_bdt` is therefore the amount we owe, running
 * positively. Reading a payables statement with the columns the other way round
 * is the mistake this file exists to prevent.
 *
 * Voided documents are excluded, for the same reason the ledger excludes them:
 * their reversal is posted, so including the original would double-count the
 * correction.
 */
export async function supplierStatement(
  orgId: string,
  partyId: string,
  query: z.output<typeof StatementQuery>,
): Promise<StatementResult> {
  const party = await resolveSupplier(orgId, partyId);

  const [bills, payments, debitNotes] = await Promise.all([
    BillModel.find({
      org_id: orgId,
      party_id: party.id,
      status: { $in: ["ISSUED", "PARTIALLY_PAID", "PAID"] },
    })
      .sort({ date: 1, doc_seq: 1 })
      .lean(),
    PaymentModel.find({ org_id: orgId, party_id: party.id }).sort({ date: 1, doc_seq: 1 }).lean(),
    DebitNoteModel.find({ org_id: orgId, party_id: party.id, status: { $ne: "VOID" } })
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
    ...bills.map((row) => ({
      date: row.date,
      type: "BILL" as const,
      doc_no: row.doc_no ?? null,
      description: row.memo || "Bill",
      // The full document value: the statement tells the supplier what we were
      // billed, whether or not we have since paid it.
      amount: money(row.total_bdt),
    })),
    ...payments.map((row) => ({
      date: row.date,
      type: "PAYMENT" as const,
      doc_no: row.doc_no,
      description: row.memo || "Payment made",
      amount: money(row.amount_bdt).negated(),
    })),
    ...debitNotes.map((row) => ({
      date: row.date,
      type: "DEBIT_NOTE" as const,
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
      debit_bdt: positive ? "0.00" : fmt(event.amount.abs()),
      credit_bdt: positive ? fmt(event.amount) : "0.00",
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
    prepaid_bdt: fmt(await partyPrepayments(orgId, party.id)),
  };
}

/* ── Supplier position ───────────────────────────────────────────────────── */

export interface SupplierPosition {
  party_id: string;
  party_code: string;
  party_name: string;
  balance_bdt: string;
  overdue_bdt: string;
  oldest_overdue_days: number;
  open_bill_count: number;
  prepaid_bdt: string;
}

/** Where we stand with a supplier: what is owed, how much of it is late, and
 *  whether we are already ahead of them. */
export async function supplierPosition(
  orgId: string,
  partyId: string,
  asOf = todayInLedgerZone(),
): Promise<SupplierPosition> {
  const party = await resolveSupplier(orgId, partyId);
  const [balance, rows, prepaid] = await Promise.all([
    partyApBalance(orgId, party.id),
    openBills(orgId, { partyId: party.id }),
    partyPrepayments(orgId, party.id),
  ]);

  const overdueRows = rows.filter((row) => row.due_date < asOf);
  const overdue = sum(overdueRows.map((row) => row.outstanding));
  const oldest = overdueRows.reduce((acc, row) => Math.max(acc, daysBetween(row.due_date, asOf)), 0);

  return {
    party_id: party.id,
    party_code: party.code,
    party_name: party.name,
    balance_bdt: fmt(balance),
    overdue_bdt: fmt(overdue),
    oldest_overdue_days: oldest,
    open_bill_count: rows.length,
    prepaid_bdt: fmt(prepaid),
  };
}
