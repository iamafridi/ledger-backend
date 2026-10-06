/**
 * Advances — money a party has paid that no document has claimed yet
 * (plan §6, Phase 10; ADR 0004 re-derived for MongoDB).
 *
 * THE ONE IDEA
 * An advance is a **credit balance a party holds with us**. When a customer pays
 * more than they owe, or pays before anything is owed, the difference is not an
 * error and is not absorbed: it is money we hold on their behalf until a future
 * invoice claims it. The general ledger already says so — the receipt posted
 * `DR cash / CR <their control account>` for the whole amount, so their control
 * account is in credit. These two collections are the **sub-ledger breakdown**
 * of that credit: which advances make it up, and which document has since
 * claimed each one.
 *
 * WHY THAT MATTERS FOR THE INVARIANT
 * Because applying an advance to an invoice does **not** post anything. The
 * control account was already reduced when the money arrived; claiming the
 * advance against an invoice only says *which* invoice that credit settles. So
 * the adjustment is a sub-ledger row that reduces both the invoice's outstanding
 * and the advance's unused balance by the same amount — and the control account,
 * which knows about neither, stays exactly where it was. The tie to the ledger
 * is therefore structural rather than something two writers have to keep in
 * step.
 *
 * STATUS IS DERIVED, NEVER SUPPLIED
 * `status` is recomputed from the advance's own adjustment rows after every
 * allocation or reversal (ADR 0004 §1): no adjustments → `OPEN`; some →
 * `PARTIALLY_ADJUSTED`; all → `FULLY_ADJUSTED`. The over-adjustment guard makes
 * "more than the whole" impossible, so `≥` and `=` are the same test. A caller
 * never sets a status, exactly as an invoice is never marked PAID by hand.
 *
 * THE INVARIANT (I6)
 *   for every party:  Σ advances.amount − Σ advance_adjustments.amount ≥ 0
 * It holds at every commit and is asserted by the integrity run. If it ever goes
 * negative that is a blocking defect, not a warning.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField, DATE_PATTERN } from "../../shared/db/money-field.js";

/* ── Advances ────────────────────────────────────────────────────────────── */

/**
 * How an advance came to exist. A manual advance is money recorded with no
 * document behind it; a receipt or payment remainder is the overpayment of a
 * settlement that has already been posted. The distinction is kept because it
 * tells a reader where to look for the original money.
 */
export const ADVANCE_SOURCES = ["MANUAL", "RECEIPT_REMAINDER", "PAYMENT_PREPAYMENT"] as const;
export type AdvanceSource = (typeof ADVANCE_SOURCES)[number];

export const ADVANCE_STATUSES = ["OPEN", "PARTIALLY_ADJUSTED", "FULLY_ADJUSTED"] as const;
export type AdvanceStatus = (typeof ADVANCE_STATUSES)[number];

const advanceSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    party_id: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },

    /** The business date the money changed hands. FIFO order reads on this. */
    date: { type: String, required: true, match: DATE_PATTERN, index: true },
    amount_bdt: moneyField(),

    /** Where the money landed (a customer advance) or left from (a supplier
     *  prepayment). Snapshotted by code and name, like every other posting. */
    account_code: { type: String, required: true, trim: true, maxlength: 24 },
    account_name: { type: String, trim: true, maxlength: 120, default: "" },

    reference: { type: String, trim: true, maxlength: 120, default: "" },
    notes: { type: String, trim: true, maxlength: 500, default: "" },

    /** Derived from the adjustment rows — see `deriveStatus` in the service.
     *  Stored so the list screen and the FIFO filter need no sub-query. */
    status: { type: String, enum: ADVANCE_STATUSES, default: "OPEN", index: true },

    source: { type: String, enum: ADVANCE_SOURCES, default: "MANUAL" },
    /** The receipt/bill number this advance came out of, when it came out of
     *  one. Free text on purpose: it labels history, it does not join. */
    source_doc_no: { type: String, trim: true, maxlength: 32, default: "" },

    /** The entry that created the advance, when it has one. A receipt-remainder
     *  advance has none of its own — its entry is the receipt's — which is
     *  exactly the point made at the top of this file. */
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

/** The FIFO read: this party's candidates, oldest money first, `_id` breaking a
 *  same-day tie — the same order everywhere (ADR 0004 §1). */
advanceSchema.index({ org_id: 1, party_id: 1, status: 1, date: 1, _id: 1 });
advanceSchema.index({ org_id: 1, date: -1 });

/* ── Adjustments ─────────────────────────────────────────────────────────── */

export const ADJUSTMENT_DOCUMENT_TYPES = ["INVOICE", "BILL"] as const;
export type AdjustmentDocumentType = (typeof ADJUSTMENT_DOCUMENT_TYPES)[number];

/**
 * One advance claimed by one document, for one amount.
 *
 * This row is the **only** thing that reduces an advance's unused balance, which
 * is what lets the invariant be answerable by a sum rather than by replaying
 * every allocation. It is also the one row in the engine that may be **deleted**
 * — when the document that claimed the advance is cancelled or amended, the
 * claim is undone. The delete is deliberate and transaction-scoped, and the
 * audit log keeps the history: a dead row here would corrupt Σ adjustments (the
 * invariant) and every report that reads it (ADR 0004 §4).
 */
const advanceAdjustmentSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    advance_id: { type: Schema.Types.ObjectId, ref: "Advance", required: true, index: true },
    /** Denormalised so the per-party reads never join back through the advance. */
    party_id: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },

    /** Which document claimed it — INVOICE for a customer advance, BILL for a
     *  supplier prepayment. Not a foreign key: the row survives the document's
     *  void only until the reversal removes it, and a broken link would be
     *  louder than no link at all. */
    document_type: { type: String, enum: ADJUSTMENT_DOCUMENT_TYPES, required: true },
    document_id: { type: Schema.Types.ObjectId, required: true, index: true },
    document_no: { type: String, trim: true, maxlength: 32, default: "" },

    amount_bdt: moneyField(),
    adjusted_on: { type: String, required: true, match: DATE_PATTERN },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

advanceAdjustmentSchema.index({ org_id: 1, advance_id: 1 });
advanceAdjustmentSchema.index({ org_id: 1, document_type: 1, document_id: 1 });

export type AdvanceDocument = InferSchemaType<typeof advanceSchema>;
export type AdvanceAdjustmentDocument = InferSchemaType<typeof advanceAdjustmentSchema>;

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled
 *  model instead of throwing OverwriteModelError on re-registration. */
export const AdvanceModel =
  (mongoose.models["Advance"] as Model<AdvanceDocument> | undefined) ??
  mongoose.model<AdvanceDocument>("Advance", advanceSchema);

export const AdvanceAdjustmentModel =
  (mongoose.models["AdvanceAdjustment"] as Model<AdvanceAdjustmentDocument> | undefined) ??
  mongoose.model<AdvanceAdjustmentDocument>("AdvanceAdjustment", advanceAdjustmentSchema);
