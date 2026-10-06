/**
 * The advance engine (plan §6, Phase 10; ADR 0004 re-derived for MongoDB).
 *
 * This file has exactly one job, and it is worth stating in one sentence: when a
 * document claims money a party has already paid, take that money out of their
 * open advance balance — atomically, never more than exists, oldest money first
 * — and put it back when the document is cancelled or amended.
 *
 * THE ENGINE HAS NO JOURNAL OF ITS OWN
 * Applying an advance posts nothing, and that is the design rather than an
 * omission. The advance arrived as a real receipt or payment, which already
 * posted `DR cash / CR <control account>` for the whole amount; the control
 * account is in credit by the unused advance. Claiming the advance against an
 * invoice is a **sub-ledger** event: it reduces the invoice's outstanding and
 * the advance's unused balance by the same amount, so the control account — the
 * general ledger's view — never moves. That is what makes `I5-ADVANCES` and
 * `I6` answerable from these two collections alone.
 *
 * FIFO, ALWAYS
 * Candidates are read `date ASC, _id ASC`: the oldest money settles first, with
 * the document id breaking a same-day tie. One order, used by the allocation,
 * the list and the ledger, so no screen can be showing a different queue from
 * the one the engine drains.
 *
 * THE INVARIANT NEVER GOES NEGATIVE
 * `Σ amounts − Σ adjustments ≥ 0` per party, checked before any row is written
 * and asserted by the integrity run afterwards. The over-adjustment refusal is
 * verbatim from the ADR — the message a user will paste into a support ticket is
 * not the place to be creative.
 */
import type { ClientSession } from "mongoose";
import { z } from "zod";

import { AdvanceAdjustmentModel, AdvanceModel, type AdvanceStatus } from "./advances.model.js";
import { InvoiceModel } from "../sales/sales.model.js";
import { BillModel } from "../purchases/purchases.model.js";
import { PartyModel } from "../masterdata/parties.model.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import { inTransaction, postJournal } from "../../core/posting.js";
import { recomputeInvoiceSettlement } from "../sales/sales.support.js";
import { recomputeBillSettlement } from "../purchases/purchases.support.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, toPaisa, ZERO, type Money } from "../../core/money.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const CreateAdvanceSchema = z.object({
  party_id: ObjectIdInput,
  date: DateInput,
  amount_bdt: MoneyInput,
  /** Blank picks 1000 Cash on Hand; a customer's money landed here, a supplier's
   *  left from here. */
  account_code: z.string().trim().max(24).default(""),
  reference: z.string().trim().max(120).default(""),
  notes: z.string().trim().max(500).default(""),
});

export const ListAdvanceQuery = z.object({
  party_id: ObjectIdInput.optional(),
  status: z.enum(["OPEN", "PARTIALLY_ADJUSTED", "FULLY_ADJUSTED"]).optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const LedgerQuery = z.object({
  party_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
});

/**
 * An explicit claim against an already-issued document, for the case where the
 * advance is known only after the invoice or bill went out. Issuing the document
 * takes the same amount in its own request body instead — and runs it inside the
 * issuing transaction — but this is the path for everything already in the books.
 */
export const ApplyAdvanceSchema = z.object({
  document_type: z.enum(["INVOICE", "BILL"]),
  document_id: ObjectIdInput,
  amount_bdt: MoneyInput,
  /** Blank uses the document's own date. */
  date: z.union([DateInput, z.literal("")]).optional(),
});

export const UndoAdvanceSchema = z.object({
  document_type: z.enum(["INVOICE", "BILL"]),
  document_id: ObjectIdInput,
});

export type CreateAdvanceInput = z.output<typeof CreateAdvanceSchema>;
export type ApplyAdvanceInput = z.output<typeof ApplyAdvanceSchema>;
export type UndoAdvanceInput = z.output<typeof UndoAdvanceSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface AdvanceView {
  id: string;
  party_id: string;
  party_code: string;
  party_name: string;
  date: string;
  amount_bdt: string;
  /** Σ adjustments against this advance, and what is left of it. */
  adjusted_bdt: string;
  outstanding_bdt: string;
  account_code: string;
  account_name: string;
  reference: string;
  notes: string;
  status: AdvanceStatus;
  source: string;
  source_doc_no: string;
  journal_entry_id: string | null;
}

export interface AdvanceAdjustmentView {
  id: string;
  advance_id: string;
  document_type: string;
  document_id: string;
  document_no: string;
  amount_bdt: string;
  adjusted_on: string;
}

export interface AdvanceDetail extends AdvanceView {
  adjustments: AdvanceAdjustmentView[];
}

export interface OutstandingView {
  party_id: string;
  party_code: string;
  party_name: string;
  advances_bdt: string;
  adjusted_bdt: string;
  outstanding_bdt: string;
  open_count: number;
}

export interface LedgerEntry {
  date: string;
  kind: "ADVANCE" | "ADJUSTMENT";
  reference: string;
  party_id: string;
  party_name: string;
  advance_bdt: string;
  adjustment_bdt: string;
  running_balance_bdt: string;
  document_type: string;
  document_id: string;
  document_no: string;
  age_days: number;
}

export interface LedgerResult {
  entries: LedgerEntry[];
  closing_bdt: string;
  as_of: string | null;
}

/* ── Party resolution ────────────────────────────────────────────────────── */

interface AdvanceParty {
  id: string;
  code: string;
  name: string;
  /** True when money arrives (a customer advance); false when money leaves (a
   *  supplier prepayment). Decided by the party's own control account, because
   *  that account is what the posting actually touches. */
  inbound: boolean;
  control_account_code: string;
}

function directionOf(kind: string, controlAccountCode: string): boolean {
  if (controlAccountCode === CONTROL_ACCOUNT.AP) return false;
  if (controlAccountCode === CONTROL_ACCOUNT.AR) return true;
  return kind !== "SUPPLIER";
}

async function resolveParty(orgId: string, partyId: string): Promise<AdvanceParty> {
  assertObjectId(partyId, "That party does not exist.");
  const party = await PartyModel.findOne({ _id: partyId, org_id: orgId }).lean();
  if (!party) throw new AppError(422, "PARTY_NOT_FOUND", "That party does not exist in this ledger.");
  if (party.is_active === false) {
    throw new AppError(422, "PARTY_INACTIVE", `${party.name} is inactive, so no advance can be recorded for them.`);
  }
  return {
    id: String(party._id),
    code: party.code,
    name: party.name,
    inbound: directionOf(party.kind, party.control_account_code),
    control_account_code: party.control_account_code,
  };
}

/* ── Status derivation (ADR 0004 §1) ─────────────────────────────────────── */

function deriveStatus(amount: Money, adjusted: Money): AdvanceStatus {
  if (!adjusted.greaterThan(ZERO)) return "OPEN";
  // The over-adjustment guard makes adjusted > amount impossible, so `>=` and
  // `=` are the same test — stated as `>=` so a corrupt row is FULLY rather than
  // a state that does not exist.
  return adjusted.greaterThanOrEqualTo(amount) ? "FULLY_ADJUSTED" : "PARTIALLY_ADJUSTED";
}

/* ── The core: allocate (ADR 0004 §3) ────────────────────────────────────── */

export interface AllocationLine {
  advance_id: string;
  amount: Money;
}

/**
 * Claim `amount` of `partyId`'s open advances for one document, **inside the
 * caller's transaction**. It never opens its own: a later failure in the caller
 * rolls the allocation back with everything else, so a half-applied advance is
 * structurally impossible (ADR 0004 §3).
 */
export async function allocateAdvance(
  orgId: string,
  uid: string,
  party: Pick<AdvanceParty, "id" | "name">,
  amount: Money,
  document: { type: "INVOICE" | "BILL"; id: string; no: string; date: string },
  session: ClientSession,
): Promise<AllocationLine[]> {
  if (!amount.greaterThan(ZERO)) {
    throw new AppError(422, "ADVANCE_AMOUNT_INVALID", "Adjustment amounts must be more than 0.");
  }

  const partyId = party.id;
  // The FIFO candidate order, and the only order ever used (ADR §1). Read in
  // the caller's session so a document with two adjustments sees its own first.
  const candidates = await AdvanceModel.find({
    org_id: orgId,
    party_id: partyId,
    status: { $in: ["OPEN", "PARTIALLY_ADJUSTED"] },
  })
    .sort({ date: 1, _id: 1 })
    .session(session)
    .lean();

  // The party's whole advance ledger, not just the candidates, so the
  // outstanding figure the refusal quotes is the real one.
  const [allAdvances, allAdjustments] = await Promise.all([
    AdvanceModel.find({ org_id: orgId, party_id: partyId }).session(session).lean(),
    AdvanceAdjustmentModel.find({ org_id: orgId, party_id: partyId }).session(session).lean(),
  ]);

  const adjustedByAdvance = new Map<string, Money>();
  for (const row of allAdjustments) {
    const key = String(row.advance_id);
    const value = money(row.amount_bdt ?? "0.00");
    adjustedByAdvance.set(key, (adjustedByAdvance.get(key) ?? ZERO).plus(value));
  }

  const advancesTotal = allAdvances.reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00")), ZERO);
  const adjustedScope = allAdvances.reduce(
    (acc, row) => acc.plus(adjustedByAdvance.get(String(row._id)) ?? ZERO),
    ZERO,
  );
  const outstanding = toPaisa(advancesTotal.minus(adjustedScope));

  if (amount.greaterThan(outstanding)) {
    throw new AppError(
      422,
      "ADVANCE_OVER_ADJUSTED",
      `Adjustment of ${fmt(amount)} exceeds ${party.name}'s unadjusted advance for this party (${fmt(outstanding)}). ` +
        "Reduce the adjustment or record a new advance first.",
    );
  }

  // FIFO walk. The candidates' total capacity equals the outstanding figure just
  // computed, so `remaining` cannot survive the loop — and if it ever does, that
  // is data corruption and the whole transaction must roll back rather than a
  // partial claim be written (ADR §3.2).
  const rows: AllocationLine[] = [];
  let remaining: Money = toPaisa(amount);
  for (const advance of candidates) {
    if (!remaining.greaterThan(ZERO)) break;
    const used = adjustedByAdvance.get(String(advance._id)) ?? ZERO;
    const available = money(advance.amount_bdt ?? "0.00").minus(used);
    if (!available.greaterThan(ZERO)) continue;
    const take = remaining.greaterThan(available) ? available : remaining;
    rows.push({ advance_id: String(advance._id), amount: toPaisa(take) });
    remaining = remaining.minus(take);
  }

  if (remaining.greaterThan(ZERO)) {
    throw new AppError(
      409,
      "ADVANCE_LEDGER_INCONSISTENT",
      "The advance ledger is inconsistent — contact the administrator.",
    );
  }

  await AdvanceAdjustmentModel.insertMany(
    rows.map((row) => ({
      org_id: orgId,
      advance_id: row.advance_id,
      party_id: partyId,
      document_type: document.type,
      document_id: document.id,
      document_no: document.no,
      amount_bdt: fmt(row.amount),
      adjusted_on: document.date,
      created_by: uid,
    })),
    { session },
  );

  // The statuses, recomputed from the locked snapshot plus what was just
  // written — never set by the caller (ADR §1).
  const takenByAdvance = new Map<string, Money>();
  for (const row of rows) {
    takenByAdvance.set(row.advance_id, (takenByAdvance.get(row.advance_id) ?? ZERO).plus(row.amount));
  }
  for (const [advanceId, taken] of takenByAdvance) {
    const advance = allAdvances.find((row) => String(row._id) === advanceId);
    if (!advance) continue;
    const newStatus = deriveStatus(
      money(advance.amount_bdt ?? "0.00"),
      (adjustedByAdvance.get(advanceId) ?? ZERO).plus(taken),
    );
    // Written even when the status is unchanged. MongoDB has no row locks, so
    // the concurrent-overdraw guard is the write conflict on the advance row
    // itself: two allocations racing for the same money both touch it, one
    // aborts, and no sequence of them can push Σ adjustments past Σ advances.
    await AdvanceModel.updateOne(
      { _id: advanceId, org_id: orgId },
      { $set: { status: newStatus, updatedAt: new Date() } },
      { session, runValidators: true },
    );
  }

  await writeAudit(
    {
      orgId,
      uid,
      entity: "advance_adjustment",
      entityId: document.id,
      action: "ADVANCE_ALLOCATED",
      after: {
        document_type: document.type,
        document_no: document.no,
        rows: rows.map((row) => ({ advance_id: row.advance_id, amount: fmt(row.amount) })),
      },
    },
    session,
  );

  return rows;
}

/* ── The core: reverse (ADR 0004 §4) ─────────────────────────────────────── */

/**
 * Undo every advance claim a document made, **inside the caller's transaction**.
 * A document with no adjustment rows reverses to a no-op — zero deletes, zero
 * status changes, zero audit rows — which is what makes a double reversal safe
 * by construction rather than by a caller remembering to check.
 */
export async function reverseAdjustmentsFor(
  orgId: string,
  uid: string,
  documentType: "INVOICE" | "BILL",
  documentId: string,
  session: ClientSession,
): Promise<number> {
  const rows = await AdvanceAdjustmentModel.find({
    org_id: orgId,
    document_type: documentType,
    document_id: documentId,
  })
    .session(session)
    .lean();
  if (rows.length === 0) return 0;

  const affected = [...new Set(rows.map((row) => String(row.advance_id)))];

  await AdvanceAdjustmentModel.deleteMany(
    { org_id: orgId, document_type: documentType, document_id: documentId },
    { session },
  );

  // Each affected advance's status is restored from its **remaining** rows — an
  // adjustment from another document stays (ADR §4).
  for (const advanceId of affected) {
    const advance = await AdvanceModel.findOne({ _id: advanceId, org_id: orgId }).session(session).lean();
    if (!advance) continue;
    const remaining = await AdvanceAdjustmentModel.find({ org_id: orgId, advance_id: advanceId })
      .session(session)
      .lean();
    const adjusted = remaining.reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00")), ZERO);
    const newStatus = deriveStatus(money(advance.amount_bdt ?? "0.00"), adjusted);
    // Always written, for the same write-conflict reason as the allocation path.
    await AdvanceModel.updateOne(
      { _id: advanceId, org_id: orgId },
      { $set: { status: newStatus, updatedAt: new Date() } },
      { session, runValidators: true },
    );
  }

  await writeAudit(
    {
      orgId,
      uid,
      entity: "advance_adjustment",
      entityId: documentId,
      action: "ADVANCE_REVERSED",
      before: { document_type: documentType, rows: rows.map((row) => ({ advance_id: row.advance_id, amount: row.amount_bdt })) },
    },
    session,
  );

  return rows.length;
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

async function adjustedTotalsByAdvance(orgId: string): Promise<Map<string, Money>> {
  const rows = await AdvanceAdjustmentModel.find({ org_id: orgId }).select({ advance_id: 1, amount_bdt: 1 }).lean();
  const totals = new Map<string, Money>();
  for (const row of rows) {
    const key = String(row.advance_id);
    totals.set(key, (totals.get(key) ?? ZERO).plus(money(row.amount_bdt ?? "0.00")));
  }
  return totals;
}

async function partyLabels(orgId: string, partyIds: readonly unknown[]): Promise<Map<string, { code: string; name: string }>> {
  const unique = [...new Set(partyIds.map(String))].filter(Boolean);
  if (unique.length === 0) return new Map();
  const rows = await PartyModel.find({ org_id: orgId, _id: { $in: unique } })
    .select({ code: 1, name: 1 })
    .lean();
  return new Map(rows.map((row) => [String(row._id), { code: row.code, name: row.name }]));
}

function shapeAdvance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  doc: any,
  adjusted: Money,
  label: { code: string; name: string } | undefined,
): AdvanceView {
  return {
    id: String(doc._id),
    party_id: String(doc.party_id),
    party_code: label?.code ?? "",
    party_name: label?.name ?? "",
    date: doc.date,
    amount_bdt: doc.amount_bdt,
    adjusted_bdt: fmt(adjusted),
    outstanding_bdt: fmt(money(doc.amount_bdt).minus(adjusted)),
    account_code: doc.account_code,
    account_name: doc.account_name ?? "",
    reference: doc.reference ?? "",
    notes: doc.notes ?? "",
    status: doc.status,
    source: doc.source ?? "MANUAL",
    source_doc_no: doc.source_doc_no ?? "",
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
  };
}

export async function listAdvances(orgId: string, query: z.output<typeof ListAdvanceQuery>): Promise<AdvanceView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.party_id) filter["party_id"] = query.party_id;
  if (query.status) filter["status"] = query.status;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  // The FIFO order, so the list is the queue the engine would drain.
  const rows = await AdvanceModel.find(filter).sort({ date: 1, _id: 1 }).limit(query.limit).lean();
  if (rows.length === 0) return [];

  const [totals, labels] = await Promise.all([
    adjustedTotalsByAdvance(orgId),
    partyLabels(orgId, rows.map((row) => row.party_id)),
  ]);

  return rows.map((row) =>
    shapeAdvance(row, totals.get(String(row._id)) ?? ZERO, labels.get(String(row.party_id))),
  );
}

export async function getAdvance(
  orgId: string,
  id: string,
  // Optional so the same view serves the plain GET route and the create path:
  // `createAdvance` builds its response *inside* the creating transaction, and
  // a read outside that transaction cannot see the uncommitted row — it would
  // find nothing and 404, rolling the whole advance back (found by the P10
  // smoke on its first run).
  session?: ClientSession,
): Promise<AdvanceDetail> {
  assertObjectId(id, "That advance does not exist.");
  const doc = await AdvanceModel.findOne({ _id: id, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!doc) throw notFoundError("That advance does not exist.");

  const [adjustments, labels] = await Promise.all([
    AdvanceAdjustmentModel.find({ org_id: orgId, advance_id: id })
      .session(session ?? null)
      .sort({ adjusted_on: 1 })
      .lean(),
    partyLabels(orgId, [doc.party_id]),
  ]);

  const adjusted = adjustments.reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00")), ZERO);
  const base = shapeAdvance(doc, adjusted, labels.get(String(doc.party_id)));

  return {
    ...base,
    adjustments: adjustments.map((row) => ({
      id: String(row._id),
      advance_id: String(row.advance_id),
      document_type: row.document_type,
      document_id: String(row.document_id),
      document_no: row.document_no ?? "",
      amount_bdt: row.amount_bdt,
      adjusted_on: row.adjusted_on,
    })),
  };
}

/**
 * What a party's advance balance is, or was on a date.
 *
 * The as-of formula is the ADR's (§5): advances restricted by `date ≤ asOf`,
 * adjustments restricted by `adjusted_on ≤ asOf`. It is the honest chronological
 * reading, and it is deliberately **not** asserted non-negative in tests — a
 * post-dated advance can open a gap that shows a temporary negative snapshot
 * without the full-range invariant being breached (ADR §8).
 */
export async function outstandingFor(
  orgId: string,
  partyId: string,
  asOf?: string,
): Promise<string> {
  const advances = await AdvanceModel.find({ org_id: orgId, party_id: partyId }).lean();
  const adjustments = await AdvanceAdjustmentModel.find({ org_id: orgId, party_id: partyId }).lean();

  const advancesTotal = advances
    .filter((row) => !asOf || row.date <= asOf)
    .reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00")), ZERO);
  const adjustmentsTotal = adjustments
    .filter((row) => !asOf || row.adjusted_on <= asOf)
    .reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00")), ZERO);

  return fmt(advancesTotal.minus(adjustmentsTotal));
}

export async function listOutstanding(orgId: string): Promise<OutstandingView[]> {
  const [advances, adjustments, parties] = await Promise.all([
    AdvanceModel.find({ org_id: orgId }).lean(),
    AdvanceAdjustmentModel.find({ org_id: orgId }).lean(),
    PartyModel.find({ org_id: orgId }).select({ code: 1, name: 1 }).lean(),
  ]);
  const labels = new Map(parties.map((row) => [String(row._id), row]));

  const advancesByParty = new Map<string, Money>();
  const adjustedByParty = new Map<string, Money>();
  const openCount = new Map<string, number>();

  for (const row of advances) {
    const key = String(row.party_id);
    advancesByParty.set(key, (advancesByParty.get(key) ?? ZERO).plus(money(row.amount_bdt ?? "0.00")));
    if (row.status !== "FULLY_ADJUSTED") openCount.set(key, (openCount.get(key) ?? 0) + 1);
  }
  for (const row of adjustments) {
    const key = String(row.party_id);
    adjustedByParty.set(key, (adjustedByParty.get(key) ?? ZERO).plus(money(row.amount_bdt ?? "0.00")));
  }

  const result: OutstandingView[] = [];
  for (const key of new Set([...advancesByParty.keys(), ...adjustedByParty.keys()])) {
    const total = advancesByParty.get(key) ?? ZERO;
    const adjusted = adjustedByParty.get(key) ?? ZERO;
    const outstanding = total.minus(adjusted);
    // A party whose advances are all claimed has nothing to show, and listing
    // them at 0.00 would fill the screen with settled history.
    if (!outstanding.greaterThan(ZERO) && (openCount.get(key) ?? 0) === 0) continue;
    const label = labels.get(key);
    result.push({
      party_id: key,
      party_code: label?.code ?? "",
      party_name: label?.name ?? "(deleted party)",
      advances_bdt: fmt(total),
      adjusted_bdt: fmt(adjusted),
      outstanding_bdt: fmt(outstanding),
      open_count: openCount.get(key) ?? 0,
    });
  }

  // Largest balance first: the reason to open this screen is to find who is
  // holding money with us, and the largest is the one to see.
  return result.sort((a, b) => money(b.outstanding_bdt).comparedTo(money(a.outstanding_bdt)));
}

/**
 * The advance ledger: advances as positive rows dated their own day, adjustments
 * as negative rows dated the day they were applied, merged into one running
 * balance. The closing figure must equal `outstandingFor` — the two are the same
 * formula read two ways (ADR §5).
 */
export async function advanceLedger(orgId: string, query: z.output<typeof LedgerQuery>): Promise<LedgerResult> {
  const advanceFilter: Record<string, unknown> = { org_id: orgId };
  if (query.party_id) advanceFilter["party_id"] = query.party_id;
  const adjustments = await AdvanceAdjustmentModel.find(advanceFilter).lean();
  const advances = await AdvanceModel.find(advanceFilter).lean();

  const labels = await partyLabels(orgId, [
    ...advances.map((row) => row.party_id),
    ...adjustments.map((row) => row.party_id),
  ]);

  const asOf = query.to ?? null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type Raw = { date: string; kind: "ADVANCE" | "ADJUSTMENT"; doc: any };
  const merged: Raw[] = [];
  for (const row of advances) {
    if (query.from && row.date < query.from) continue;
    if (query.to && row.date > query.to) continue;
    merged.push({ date: row.date, kind: "ADVANCE", doc: row });
  }
  for (const row of adjustments) {
    if (query.from && row.adjusted_on < query.from) continue;
    if (query.to && row.adjusted_on > query.to) continue;
    merged.push({ date: row.adjusted_on, kind: "ADJUSTMENT", doc: row });
  }
  merged.sort((a, b) => (a.date === b.date ? (a.kind === "ADVANCE" ? -1 : 1) : a.date < b.date ? -1 : 1));

  let running: Money = ZERO;
  const ageOf = (date: string): number => {
    const end = asOf ?? new Date().toISOString().slice(0, 10);
    return Math.max(0, Math.round((Date.parse(end) - Date.parse(date)) / 86_400_000));
  };

  const entries: LedgerEntry[] = merged.map((row) => {
    const isAdvance = row.kind === "ADVANCE";
    const amount = money(row.doc.amount_bdt ?? "0.00");
    running = isAdvance ? running.plus(amount) : running.minus(amount);
    const label = labels.get(String(row.doc.party_id));
    return {
      date: row.date,
      kind: row.kind,
      reference: isAdvance ? row.doc.reference ?? "" : `${row.doc.document_type} ${row.doc.document_no ?? ""}`.trim(),
      party_id: String(row.doc.party_id),
      party_name: label?.name ?? "",
      advance_bdt: isAdvance ? fmt(amount) : "0.00",
      adjustment_bdt: isAdvance ? "0.00" : fmt(amount),
      running_balance_bdt: fmt(running),
      document_type: isAdvance ? "" : row.doc.document_type,
      document_id: isAdvance ? "" : String(row.doc.document_id),
      document_no: isAdvance ? "" : row.doc.document_no ?? "",
      age_days: isAdvance ? ageOf(row.date) : 0,
    };
  });

  return {
    entries,
    closing_bdt: fmt(entries.length > 0 ? money(entries[entries.length - 1]!.running_balance_bdt) : ZERO),
    as_of: asOf,
  };
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

async function requireAssetAccount(orgId: string, code: string): Promise<{ code: string; name: string }> {
  const account = await CoaAccountModel.findOne({ org_id: orgId, code }).lean();
  if (!account) {
    throw new AppError(422, "ACCOUNT_NOT_FOUND", `No account with code ${code} exists in this ledger.`);
  }
  if (account.is_active === false) {
    throw new AppError(422, "ACCOUNT_INACTIVE", `Account ${code} (${account.name}) is inactive.`);
  }
  if (account.type !== "ASSET") {
    throw new AppError(
      422,
      "ACCOUNT_NOT_ASSET",
      `${account.code} (${account.name}) is a ${account.type.toLowerCase()} account. An advance moves money through an asset account such as ${CONTROL_ACCOUNT.CASH}.`,
    );
  }
  return { code: account.code, name: account.name };
}

/**
 * Record an advance by hand: money that arrived (or left) with no document
 * behind it.
 *
 * This is the one creation path that posts, because there is no receipt or
 * payment entry to carry the movement: a customer advance is
 * `DR cash / CR their control account`, a supplier prepayment the mirror. A
 * receipt-remainder advance posts nothing of its own — its money is already in
 * the receipt's entry (see `parkRemainder`).
 */
export async function createAdvance(
  orgId: string,
  uid: string,
  input: CreateAdvanceInput,
  ip?: string,
): Promise<AdvanceDetail> {
  const party = await resolveParty(orgId, input.party_id);
  const amount = money(input.amount_bdt);
  if (!amount.greaterThan(ZERO)) {
    throw new AppError(422, "ADVANCE_AMOUNT_INVALID", "An advance needs an amount greater than zero.");
  }

  const accountCode = input.account_code || CONTROL_ACCOUNT.CASH;
  const account = await requireAssetAccount(orgId, accountCode);

  return inTransaction(async (session) => {
    const created = await AdvanceModel.create(
      [
        {
          org_id: orgId,
          party_id: party.id,
          date: input.date,
          amount_bdt: fmt(amount),
          account_code: account.code,
          account_name: account.name,
          reference: input.reference,
          notes: input.notes,
          status: "OPEN",
          source: "MANUAL",
          source_doc_no: "",
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    const description = `${party.inbound ? "Advance" : "Prepayment"} from ${party.name} — ${fmt(amount)}`;
    const lines = party.inbound
      ? [
          { account_code: account.code, debit_bdt: fmt(amount), memo: description },
          {
            account_code: party.control_account_code,
            credit_bdt: fmt(amount),
            memo: description,
            party_id: party.id,
          },
        ]
      : [
          {
            account_code: party.control_account_code,
            debit_bdt: fmt(amount),
            memo: description,
            party_id: party.id,
          },
          { account_code: account.code, credit_bdt: fmt(amount), memo: description },
        ];

    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description,
        source: "ADVANCE",
        source_id: String(created._id),
        lines,
        ...(ip ? { ip } : {}),
      },
      session,
    );

    await AdvanceModel.updateOne(
      { _id: created._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session, runValidators: true },
    );      await writeAudit(
        {
          orgId,
          uid,
          entity: "advance",
          entityId: String(created._id),
          action: "ADVANCE_CREATED",
          after: { party_id: party.id, amount_bdt: fmt(amount), account_code: account.code, source: "MANUAL" },
          ...(ip ? { ip } : {}),
        },
        session,
      );

    return getAdvance(orgId, String(created._id), session);
  });
}

/**
 * Park the unclaimed remainder of a receipt or payment as an advance,
 * **inside the caller's transaction** and with no journal entry of its own —
 * the money's movement is already in the receipt's or payment's entry
 * (ADR 0004 §6). Returns null when there is nothing to park, so a caller need
 * not branch.
 */
export async function parkRemainder(
  orgId: string,
  uid: string,
  input: {
    partyId: string;
    date: string;
    amount: Money;
    accountCode: string;
    accountName: string;
    source: "RECEIPT_REMAINDER" | "PAYMENT_PREPAYMENT";
    sourceDocNo: string;
    notes: string;
  },
  session: ClientSession,
): Promise<string | null> {
  if (!input.amount.greaterThan(ZERO)) return null;

  const created = await AdvanceModel.create(
    [
      {
        org_id: orgId,
        party_id: input.partyId,
        date: input.date,
        amount_bdt: fmt(input.amount),
        account_code: input.accountCode,
        account_name: input.accountName,
        reference: `Receipt ${input.sourceDocNo} remainder`,
        notes: input.notes,
        status: "OPEN",
        source: input.source,
        source_doc_no: input.sourceDocNo,
        journal_entry_id: null,
        created_by: uid,
      },
    ],
    { session },
  ).then((rows) => rows[0]!);

  await writeAudit(
    {
      orgId,
      uid,
      entity: "advance",
      entityId: String(created._id),
      action: "ADVANCE_PARKED",
      after: { party_id: input.partyId, amount_bdt: fmt(input.amount), source: input.source, doc_no: input.sourceDocNo },
    },
    session,
  );

  return String(created._id);
}

/* ── Applying to an already-issued document ──────────────────────────────── */

interface ClaimableDocument {
  doc_no: string;
  date: string;
  status: string;
  party_id: string;
  total_bdt: string;
  paid_bdt: string;
  /** `credited_bdt` on an invoice, `debited_bdt` on a bill — the same column by
   *  the other name, and only ever the one that applies. */
  settled_by_note_bdt: string;
}

/**
 * Load the invoice or bill an explicit claim is against, as the few fields the
 * engine needs. A draft has not been posted and a void one is history, so
 * neither can have an advance claimed against it.
 */
async function loadClaimableDocument(
  orgId: string,
  documentType: "INVOICE" | "BILL",
  documentId: string,
  session: ClientSession,
): Promise<ClaimableDocument> {
  assertObjectId(documentId, "That document does not exist.");

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any =
    documentType === "INVOICE"
      ? await InvoiceModel.findOne({ _id: documentId, org_id: orgId }).session(session).lean()
      : await BillModel.findOne({ _id: documentId, org_id: orgId }).session(session).lean();

  if (!doc) {
    throw notFoundError(
      documentType === "INVOICE" ? "That invoice does not exist." : "That bill does not exist.",
    );
  }
  if (doc.status === "DRAFT") {
    throw new AppError(
      409,
      "DOCUMENT_NOT_ISSUED",
      `${doc.doc_no ?? "That document"} is still a draft — issue it before an advance can settle it.`,
    );
  }
  if (doc.status === "VOID") {
    throw new AppError(
      409,
      "DOCUMENT_VOID",
      `${doc.doc_no ?? "That document"} was voided, so no advance can settle it.`,
    );
  }

  return {
    doc_no: doc.doc_no ?? "",
    date: doc.date,
    status: doc.status,
    party_id: String(doc.party_id),
    total_bdt: doc.total_bdt ?? "0.00",
    paid_bdt: doc.paid_bdt ?? "0.00",
    settled_by_note_bdt: (documentType === "INVOICE" ? doc.credited_bdt : doc.debited_bdt) ?? "0.00",
  };
}

/**
 * How much of a document an advance may still claim: its total, less what
 * receipts/payments and notes have settled, less advances already claimed.
 *
 * `paid_bdt` already carries the earlier claims — the settlement recompute
 * writes receipt allocations and advance adjustments into the same cache — so
 * the adjustment rows are deliberately **not** read here again; doing so would
 * count every previous claim twice and refuse valid claims against a
 * part-claimed document. A pure read of the loaded document, with nothing else
 * to keep in step.
 */
function claimableRemainder(document: ClaimableDocument): Money {
  return money(document.total_bdt)
    .minus(money(document.paid_bdt))
    .minus(money(document.settled_by_note_bdt));
}

/**
 * Claim an advance against a document already in the books.
 *
 * This is the explicit twin of the amount an issue request carries: same
 * transaction rule, same FIFO order, same refusal — the only difference is which
 * side of the issue it runs on. It posts nothing; the money was already posted
 * when the receipt or payment (or the manual advance) moved it (ADR 0004 §3).
 */
export async function applyAdvance(
  orgId: string,
  uid: string,
  input: ApplyAdvanceInput,
): Promise<{ document_type: string; document_id: string; document_no: string; rows: AllocationLine[] }> {
  const amount = money(input.amount_bdt);
  if (!amount.greaterThan(ZERO)) {
    throw new AppError(422, "ADVANCE_AMOUNT_INVALID", "Adjustment amounts must be more than 0.");
  }

  return inTransaction(async (session) => {
    const document = await loadClaimableDocument(orgId, input.document_type, input.document_id, session);
    const party = await resolveParty(orgId, document.party_id);
    const remainder = claimableRemainder(document);

    if (amount.greaterThan(remainder)) {
      throw new AppError(
        422,
        "ADVANCE_EXCEEDS_DOCUMENT",
        `The adjustment of ${fmt(amount)} is more than the ${fmt(remainder)} still outstanding on ${document.doc_no || "this document"}.`,
      );
    }

    const rows = await allocateAdvance(
      orgId,
      uid,
      party,
      amount,
      {
        type: input.document_type,
        id: input.document_id,
        no: document.doc_no,
        date: input.date || document.date,
      },
      session,
    );

    // The claim settles part or all of the document, so its settlement cache
    // and the status derived from it are rewritten inside the same transaction
    // before anything downstream reads them — the same rule every receipt
    // allocation and credit note follows (ADR 0004 §5). Without this the
    // document would keep showing the amount as outstanding and could be
    // settled a second time by a receipt.
    if (input.document_type === "INVOICE") {
      await recomputeInvoiceSettlement(orgId, input.document_id, session);
    } else {
      await recomputeBillSettlement(orgId, input.document_id, session);
    }

    return {
      document_type: input.document_type,
      document_id: input.document_id,
      document_no: document.doc_no,
      rows,
    };
  });
}

/**
 * Undo an explicit claim, for repair. Voiding the document already reverses its
 * adjustments, so this is only meaningful on a document that is already void —
 * and repeating it is a no-op by construction (ADR 0004 §4).
 */
export async function undoAdvanceForDocument(
  orgId: string,
  uid: string,
  input: UndoAdvanceInput,
): Promise<{ document_type: string; document_id: string; reversed: number }> {
  return inTransaction(async (session) => {
    // Reuse the loader's status guards, but allow VOID here: the whole point is
    // to clean up after a void whose reversal did not run.
    assertObjectId(input.document_id, "That document does not exist.");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc: any =
      input.document_type === "INVOICE"
        ? await InvoiceModel.findOne({ _id: input.document_id, org_id: orgId }).session(session).lean()
        : await BillModel.findOne({ _id: input.document_id, org_id: orgId }).session(session).lean();
    if (!doc) {
      throw notFoundError(
        input.document_type === "INVOICE" ? "That invoice does not exist." : "That bill does not exist.",
      );
    }
    if (doc.status !== "VOID") {
      throw new AppError(
        409,
        "DOCUMENT_NOT_VOID",
        `${doc.doc_no ?? "That document"} is not void. Void it first — that already returns any advance it claimed.`,
      );
    }

    const reversed = await reverseAdjustmentsFor(orgId, uid, input.document_type, input.document_id, session);
    return { document_type: input.document_type, document_id: input.document_id, reversed };
  });
}
