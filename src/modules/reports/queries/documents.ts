/**
 * The document registers — journals, invoices, receipts, bills, payments.
 *
 * These reports read the same collections the document screens do, but they
 * report rather than operate: no status edits, no allocations, nothing but the
 * rows an accountant expects on paper. Money columns are printed straight from
 * the canonical strings the documents store — a register that re-derived a
 * total it could print verbatim would be a second chance to disagree with the
 * document it reports on.
 *
 * OUTSTANDING IS DERIVED, ONCE
 * An invoice's outstanding is `total − paid − credited`, computed here from the
 * same cached fields `settlementOf()` maintains. Voided documents print zero:
 * their reversal is posted, so their total no longer means anything owed, and
 * printing it as if it did would double the correction in every summary row
 * beneath the register.
 */
import mongoose from "mongoose";

import { PartyModel } from "../../masterdata/parties.model.js";
import { JournalEntryModel, JournalLineModel } from "../../journals/journal.model.js";
import { InvoiceModel, ReceiptModel } from "../../sales/sales.model.js";
import { BillModel, PaymentModel } from "../../purchases/purchases.model.js";
import { fmt, money } from "../../../core/money.js";
import type { ReportParams, ReportRow } from "../report-registry.js";
import { DATE_WINDOW_PARAMS, registerReport, dateRange } from "../report-registry.js";

const oid = (orgId: string) => new mongoose.Types.ObjectId(orgId);

/** Statuses that are or were in the books. Drafts claim no number and post
 *  nothing, so a register of documents leaves them out. */
const IN_BOOKS = ["ISSUED", "PARTIALLY_PAID", "PAID", "VOID"];
const ENTRY_STATUSES = ["POSTED", "VOID"];

/** Party labels for a page of documents, in one read. */
async function partyLabels(
  orgId: string,
  partyIds: unknown[],
): Promise<Map<string, { code: string; name: string }>> {
  if (partyIds.length === 0) return new Map();
  const parties = await PartyModel.find({ org_id: oid(orgId), _id: { $in: partyIds } })
    .select({ code: 1, name: 1 })
    .lean();
  return new Map(parties.map((party) => [String(party._id), { code: party.code, name: party.name }]));
}

/* ── Journal register ────────────────────────────────────────────────────── */

registerReport({
  code: "journal-register",
  name: "Journal Register",
  group: "GL",
  description: "Every entry in the window with its source, status and totals.",
  params: DATE_WINDOW_PARAMS,
  additive: ["debit_bdt", "credit_bdt"],
  columns: [
    { key: "entry_no", label: "Entry", type: "code" },
    { key: "date", label: "Date", type: "date" },
    { key: "description", label: "Description", type: "text" },
    { key: "source", label: "Source", type: "text" },
    { key: "status", label: "Status", type: "text" },
    { key: "lines", label: "Lines", type: "number" },
    { key: "debit_bdt", label: "Debit", type: "money" },
    { key: "credit_bdt", label: "Credit", type: "money" },
  ],
  query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
    const range = dateRange(params);
    const filter: Record<string, unknown> = {
      org_id: oid(orgId),
      status: { $in: ENTRY_STATUSES },
      ...(range.from || range.to
        ? { date: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } }
        : {}),
    };

    const entries = await JournalEntryModel.find(filter)
      .sort({ date: 1, entry_seq: 1 })
      .limit(2000)
      .lean();

    const totals = await JournalLineModel.aggregate<{ _id: unknown; debit: string; credit: string; n: number }>([
      { $match: { org_id: oid(orgId), entry_id: { $in: entries.map((entry) => entry._id) } } },
      {
        $group: {
          _id: "$entry_id",
          debit: { $sum: { $toDecimal: "$debit_bdt" } },
          credit: { $sum: { $toDecimal: "$credit_bdt" } },
          n: { $sum: 1 },
        },
      },
      { $addFields: { debit: { $toString: "$debit" }, credit: { $toString: "$credit" } } },
    ]);
    const byEntry = new Map(totals.map((row) => [String(row._id), row]));

    return entries.map((entry) => {
      const total = byEntry.get(String(entry._id));
      return {
        entry_no: entry.entry_no ?? "(draft)",
        date: entry.date,
        description: entry.description,
        source: entry.source,
        status: entry.status,
        lines: total?.n ?? 0,
        debit_bdt: fmt(money(String(total?.debit ?? "0"))),
        credit_bdt: fmt(money(String(total?.credit ?? "0"))),
      };
    });
  },
});

/* ── Shared shaping for the four document registers ──────────────────────── */

/** The outstanding a register prints: zero once voided, derived otherwise. */
function outstandingOf(doc: { status: string; total_bdt: string; paid_bdt: string; credited_bdt?: string; debited_bdt?: string }): string {
  if (doc.status === "VOID") return "0.00";
  const settled = money(doc.paid_bdt).plus(money(doc.credited_bdt ?? doc.debited_bdt ?? "0.00"));
  return fmt(money(doc.total_bdt).minus(settled));
}

type DocumentRow = {
  doc_no: string | null;
  date: string;
  due_date: string;
  party_code: string;
  party_name: string;
  status: string;
  subtotal_bdt: string;
  tax_total_bdt: string;
  total_bdt: string;
  paid_bdt: string;
  settled_bdt: string;
  outstanding_bdt: string;
};

const DOCUMENT_COLUMNS = [
  { key: "doc_no", label: "Document", type: "code" as const },
  { key: "date", label: "Date", type: "date" as const },
  { key: "due_date", label: "Due", type: "date" as const },
  { key: "party_code", label: "Party", type: "code" as const },
  { key: "party_name", label: "Name", type: "text" as const },
  { key: "status", label: "Status", type: "text" as const },
  { key: "subtotal_bdt", label: "Subtotal", type: "money" as const },
  { key: "tax_total_bdt", label: "Tax", type: "money" as const },
  { key: "total_bdt", label: "Total", type: "money" as const },
  { key: "paid_bdt", label: "Paid", type: "money" as const },
  { key: "settled_bdt", label: "Settled other", type: "money" as const },
  { key: "outstanding_bdt", label: "Outstanding", type: "money" as const },
];

const DOCUMENT_ADDITIVE = [
  "subtotal_bdt",
  "tax_total_bdt",
  "total_bdt",
  "paid_bdt",
  "settled_bdt",
  "outstanding_bdt",
];

function documentRow(
  doc: {
    doc_no: string | null;
    date: string;
    due_date: string;
    status: string;
    subtotal_bdt: string;
    tax_total_bdt: string;
    total_bdt: string;
    paid_bdt: string;
    credited_bdt?: string;
    debited_bdt?: string;
  },
  party_id: unknown,
  labels: Map<string, { code: string; name: string }>,
): DocumentRow {
  const label = labels.get(String(party_id));
  const settled = money(doc.credited_bdt ?? doc.debited_bdt ?? "0.00");
  return {
    doc_no: doc.doc_no,
    date: doc.date,
    due_date: doc.due_date,
    party_code: label?.code ?? "",
    party_name: label?.name ?? "",
    status: doc.status,
    subtotal_bdt: doc.subtotal_bdt,
    tax_total_bdt: doc.tax_total_bdt,
    total_bdt: doc.total_bdt,
    paid_bdt: doc.paid_bdt,
    settled_bdt: fmt(settled),
    outstanding_bdt: outstandingOf(doc),
  };
}

function registerReportForDocs(
  code: string,
  name: string,
  description: string,
  find: (orgId: string, range: { from?: string; to?: string }) => Promise<Array<{ doc: Record<string, unknown>; party_id: unknown }>>,
): void {
  registerReport({
    code,
    name,
    group: "Documents",
    description,
    params: DATE_WINDOW_PARAMS,
    additive: DOCUMENT_ADDITIVE,
    columns: DOCUMENT_COLUMNS,
    query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
      const rows = await find(orgId, dateRange(params));
      const labels = await partyLabels(orgId, rows.map((row) => row.party_id));
      return rows.map((row) => documentRow(row.doc as never, row.party_id, labels));
    },
  });
}

registerReportForDocs(
  "invoices",
  "Invoices",
  "Every invoice in the window with its settlement, voids included at zero.",
  async (orgId, range) => {
    const docs = await InvoiceModel.find({
      org_id: oid(orgId),
      status: { $in: IN_BOOKS },
      ...(range.from || range.to
        ? { date: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } }
        : {}),
    })
      .sort({ date: 1, doc_seq: 1 })
      .limit(2000)
      .lean();
    return docs.map((doc) => ({ doc: doc as unknown as Record<string, unknown>, party_id: doc.party_id }));
  },
);

registerReportForDocs(
  "bills",
  "Bills",
  "Every supplier bill in the window with its settlement, voids included at zero.",
  async (orgId, range) => {
    const docs = await BillModel.find({
      org_id: oid(orgId),
      status: { $in: IN_BOOKS },
      ...(range.from || range.to
        ? { date: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } }
        : {}),
    })
      .sort({ date: 1, doc_seq: 1 })
      .limit(2000)
      .lean();
    return docs.map((doc) => ({ doc: doc as unknown as Record<string, unknown>, party_id: doc.party_id }));
  },
);

/* ── Money registers ─────────────────────────────────────────────────────── */

interface MoneyRow {
  doc_no: string;
  date: string;
  party_code: string;
  party_name: string;
  method: string;
  account_code: string;
  amount_bdt: string;
  allocated_bdt: string;
  unallocated_bdt: string;
  memo: string;
}

const MONEY_COLUMNS = [
  { key: "doc_no", label: "Document", type: "code" as const },
  { key: "date", label: "Date", type: "date" as const },
  { key: "party_code", label: "Party", type: "code" as const },
  { key: "party_name", label: "Name", type: "text" as const },
  { key: "method", label: "Method", type: "text" as const },
  { key: "account_code", label: "Account", type: "code" as const },
  { key: "amount_bdt", label: "Amount", type: "money" as const },
  { key: "allocated_bdt", label: "Allocated", type: "money" as const },
  { key: "unallocated_bdt", label: "Unallocated", type: "money" as const },
  { key: "memo", label: "Memo", type: "text" as const },
];

function moneyRegister(
  code: string,
  name: string,
  description: string,
  find: (orgId: string, range: { from?: string; to?: string }) => Promise<Array<{ doc: Record<string, unknown>; party_id: unknown }>>,
): void {
  registerReport({
    code,
    name,
    group: "Documents",
    description,
    params: DATE_WINDOW_PARAMS,
    additive: ["amount_bdt", "allocated_bdt", "unallocated_bdt"],
    columns: MONEY_COLUMNS,
    query: async (orgId: string, params: ReportParams): Promise<ReportRow[]> => {
      const rows = await find(orgId, dateRange(params));
      const labels = await partyLabels(orgId, rows.map((row) => row.party_id));
      return rows.map(({ doc, party_id }) => {
        const label = labels.get(String(party_id));
        const row = doc as unknown as MoneyRow;
        return {
          doc_no: row.doc_no,
          date: row.date,
          party_code: label?.code ?? "",
          party_name: label?.name ?? "",
          method: row.method,
          account_code: row.account_code,
          amount_bdt: row.amount_bdt,
          allocated_bdt: row.allocated_bdt,
          unallocated_bdt: row.unallocated_bdt,
          memo: row.memo ?? "",
        };
      });
    },
  });
}

moneyRegister(
  "receipts",
  "Receipts",
  "Money received from customers, with what each receipt settled and what it left in advance.",
  async (orgId, range) => {
    const docs = await ReceiptModel.find({
      org_id: oid(orgId),
      ...(range.from || range.to
        ? { date: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } }
        : {}),
    })
      .sort({ date: 1, doc_seq: 1 })
      .limit(2000)
      .lean();
    return docs.map((doc) => ({ doc: doc as unknown as Record<string, unknown>, party_id: doc.party_id }));
  },
);

moneyRegister(
  "payments",
  "Payments",
  "Money paid to suppliers, with what each payment settled and what it left as a prepayment.",
  async (orgId, range) => {
    const docs = await PaymentModel.find({
      org_id: oid(orgId),
      ...(range.from || range.to
        ? { date: { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) } }
        : {}),
    })
      .sort({ date: 1, doc_seq: 1 })
      .limit(2000)
      .lean();
    return docs.map((doc) => ({ doc: doc as unknown as Record<string, unknown>, party_id: doc.party_id }));
  },
);
