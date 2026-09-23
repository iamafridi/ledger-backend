/**
 * Debit notes — giving part of a claim back to a supplier (plan §6, Phase 4).
 *
 * A debit note is the bill's arithmetic pointed the other way: the same
 * quantity, price, discount and tax, posting `DR AP / CR expense (+ input VAT)`
 * instead of its mirror. It is deliberately *not* a negative bill — nothing in
 * this codebase stores a negative amount (see `core/document-lines.ts`), and a
 * document with a negative total is indistinguishable in a report from a
 * data-entry mistake.
 *
 * IT ALWAYS NAMES THE BILL IT CORRECTS
 * A free-floating debit is a prepayment, which is what an unallocated payment
 * already is. Naming the bill is what lets the bill's settlement be recomputed
 * from facts rather than adjusted by hand, and what makes the `reason` field
 * land somewhere a human will read it.
 *
 * THE REASON IS MANDATORY
 * Same rule as voiding: the person who finds this number in a report a year from
 * now cannot reconstruct why it is there from the amounts alone. A return to a
 * supplier, a price correction and a rejected delivery look identical in the
 * ledger and are three different conversations.
 */
import { z } from "zod";

import { BillLineModel, BillModel, DebitNoteModel } from "./purchases.model.js";
import {
  DocumentLineInput,
  PURCHASE,
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
  recomputeBillSettlement,
  replaceLines,
  resolveSupplier,
  settlementOf,
} from "./purchases.support.js";
import { inTransaction, postJournal, voidEntry } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money } from "../../core/money.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { AppError, notFoundError, validationError } from "../../shared/errors/app-error.js";
import { DateInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const CreateDebitNoteSchema = z.object({
  bill_id: ObjectIdInput,
  date: DateInput,
  reason: z
    .string()
    .trim()
    .min(3, "Say why this debit is being raised — a return, a price correction, a rejected delivery.")
    .max(300),
  lines: z.array(DocumentLineInput).min(1, "A debit note needs at least one line.").max(200),
});

export const ListDebitNoteQuery = z.object({
  bill_id: ObjectIdInput.optional(),
  party_id: ObjectIdInput.optional(),
  status: z.enum(["ISSUED", "VOID"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const VoidDebitNoteSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason for voiding this debit note.").max(300),
});

export type CreateDebitNoteInput = z.output<typeof CreateDebitNoteSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface DebitNoteView {
  id: string;
  doc_no: string;
  bill_id: string;
  bill_no: string | null;
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
  billNo: string | null,
  party: { code: string; name: string },
): DebitNoteView {
  return {
    id: String(doc._id),
    doc_no: doc.doc_no,
    bill_id: String(doc.bill_id),
    bill_no: billNo,
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

async function billNumbers(orgId: string, ids: readonly unknown[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(ids.map((id) => String(id)))];
  if (unique.length === 0) return new Map();
  const rows = await BillModel.find({ org_id: orgId, _id: { $in: unique } })
    .select({ doc_no: 1 })
    .lean();
  return new Map(rows.map((row) => [String(row._id), row.doc_no ?? null]));
}

export async function getDebitNote(orgId: string, id: string): Promise<DebitNoteView> {
  assertObjectId(id, "That debit note does not exist.");

  const doc = await DebitNoteModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That debit note does not exist.");

  const [lines, numbers, names] = await Promise.all([
    loadLines(orgId, "DEBIT_NOTE", id),
    billNumbers(orgId, [doc.bill_id]),
    partyNamesFor(orgId, [doc.party_id]),
  ]);

  const label = names.get(String(doc.party_id));
  return toView(doc, lines, numbers.get(String(doc.bill_id)) ?? null, {
    code: label?.code ?? "",
    name: label?.name ?? "",
  });
}

export async function listDebitNotes(
  orgId: string,
  query: z.output<typeof ListDebitNoteQuery>,
): Promise<DebitNoteView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.bill_id) filter["bill_id"] = query.bill_id;
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.status) filter["status"] = query.status;

  const rows = await DebitNoteModel.find(filter).sort({ date: -1, doc_seq: -1 }).limit(query.limit).lean();
  if (rows.length === 0) return [];

  const [numbers, names] = await Promise.all([
    billNumbers(orgId, rows.map((row) => row.bill_id)),
    partyNamesFor(orgId, rows.map((row) => row.party_id)),
  ]);

  const lineRows = await BillLineModel.find({
    org_id: orgId,
    doc_type: "DEBIT_NOTE",
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
    return toView(row, byNote.get(String(row._id)) ?? [], numbers.get(String(row.bill_id)) ?? null, {
      code: label?.code ?? "",
      name: label?.name ?? "",
    });
  });
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

/**
 * Raise a debit note against a bill.
 *
 * The ceiling is the bill's **outstanding**, not its total: debiting more than
 * is still owed would leave the supplier with a balance owed *to* us on this
 * bill, which is a prepayment — and a prepayment is what an unallocated payment
 * is. Refusing here keeps one meaning for one number.
 */
export async function createDebitNote(
  orgId: string,
  uid: string,
  input: CreateDebitNoteInput,
  ip?: string,
): Promise<DebitNoteView> {
  return inTransaction(async (session) => {
    const bill = await BillModel.findOne({ _id: input.bill_id, org_id: orgId })
      .session(session)
      .lean();
    if (!bill) {
      throw new AppError(422, "BILL_NOT_FOUND", "That bill does not exist in this ledger.");
    }
    if (bill.status === "DRAFT" || bill.status === "VOID") {
      throw new AppError(
        422,
        "BILL_NOT_DEBITABLE",
        bill.status === "DRAFT"
          ? "That bill is still a draft. Issued bills are the ones a debit note corrects."
          : "That bill was voided, so there is nothing left to debit.",
      );
    }

    const party = await resolveSupplier(orgId, String(bill.party_id));
    const lines = await resolveLines(orgId, input.lines, PURCHASE);
    const totals = totalsOf(lines);
    assertTotalsUsable(totals);

    const total = money(totals.total_bdt);
    if (total.isZero()) {
      throw validationError("A debit note with nothing on it corrects nothing. Add a line.");
    }

    const { outstanding } = settlementOf(bill);
    if (total.greaterThan(outstanding)) {
      throw new AppError(
        422,
        "DEBIT_EXCEEDS_OUTSTANDING",
        `Bill ${bill.doc_no ?? ""} has ${fmt(outstanding)} left to settle, so ${fmt(total)} cannot be debited against it. Anything beyond that is a prepayment — record it as a payment instead.`,
      );
    }

    const allocation = await allocateNumber(orgId, "debit_note", input.date);
    const description = `Debit note ${allocation.number} — ${party.name}`;

    // Written inside the transaction, like the bill it corrects: a debit note
    // committed outside it while its reversal stayed inside would leave the
    // payable reduced with no entry behind the reduction.
    const created = await DebitNoteModel.create(
      [
        {
          org_id: orgId,
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          bill_id: bill._id,
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

    await replaceLines(orgId, "DEBIT_NOTE", String(created._id), lineDocs(lines), session);

    // `reverse: true` is the whole difference from a bill: the same grouped
    // expense and input-VAT lines land on the opposite side, and the control
    // account is debited instead of credited.
    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description,
        source: "DEBIT_NOTE",
        source_id: String(created._id),
        lines: documentPostingLines(lines, {
          profile: PURCHASE,
          controlAccountCode: party.control_account_code,
          controlAccountName: "Accounts Payable",
          partyId: party.id,
          reverse: true,
          memo: description,
        }),
        ...(ip ? { ip } : {}),
      },
      session,
    );

    await DebitNoteModel.updateOne(
      { _id: created._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session },
    );

    await recomputeBillSettlement(orgId, String(bill._id), session);

    const view = toView(
      { ...created.toObject(), journal_entry_id: entry.id },
      await loadLines(orgId, "DEBIT_NOTE", String(created._id), session),
      bill.doc_no ?? null,
      { code: party.code, name: party.name },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.debit_note",
        entityId: view.id,
        action: "DEBIT_NOTE_ISSUED",
        after: {
          doc_no: view.doc_no,
          bill_no: bill.doc_no,
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
 * Void a debit note — the reversal is itself reversed.
 *
 * There is no "unissue". The note's entry is voided (writing its mirror) and the
 * bill's settlement recomputed from what is then left, so the two documents stay
 * consistent by construction rather than by a compensating adjustment somebody
 * has to remember to make.
 */
export async function voidDebitNote(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<DebitNoteView> {
  assertObjectId(id, "That debit note does not exist.");

  return inTransaction(async (session) => {
    const doc = await DebitNoteModel.findOne({ _id: id, org_id: orgId })
      .session(session)
      .lean();
    if (!doc) throw notFoundError("That debit note does not exist.");
    if (doc.status === "VOID") {
      throw new AppError(409, "DEBIT_NOTE_VOID", "That debit note has already been voided.");
    }

    if (doc.journal_entry_id) {
      await voidEntry(orgId, uid, String(doc.journal_entry_id), reason, ip, session);
    }

    const updated = await DebitNoteModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: { $ne: "VOID" } },
      { $set: { status: "VOID", void_reason: reason.trim() } },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "DEBIT_NOTE_VOID", "That debit note was voided by another request a moment ago.");
    }

    await recomputeBillSettlement(orgId, String(doc.bill_id), session);

    const [lines, numbers, names] = await Promise.all([
      loadLines(orgId, "DEBIT_NOTE", id, session),
      billNumbers(orgId, [doc.bill_id]),
      partyNamesFor(orgId, [doc.party_id]),
    ]);
    const label = names.get(String(doc.party_id));
    const view = toView(updated, lines, numbers.get(String(doc.bill_id)) ?? null, {
      code: label?.code ?? "",
      name: label?.name ?? "",
    });

    await writeAudit(
      {
        orgId,
        uid,
        entity: "purchases.debit_note",
        entityId: view.id,
        action: "DEBIT_NOTE_VOIDED",
        before: { doc_no: doc.doc_no, total_bdt: doc.total_bdt, status: "ISSUED" },
        after: { status: "VOID", reason: reason.trim() },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}
