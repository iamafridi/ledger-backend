import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField, DATE_PATTERN, MONTH_PATTERN } from "../../shared/db/money-field.js";

/**
 * The double-entry core: journal entries and their lines.
 *
 * An entry is only ever *created* (draft or posted) or *voided*. A posted entry
 * is never edited — the correction is a new reversing entry, which is why
 * `reverses_entry_id` exists. Anything else would let history be rewritten
 * after a report has already been printed from it.
 *
 * `status` moving POSTED → VOID on the original is a marker, not an edit: the
 * amounts, lines and date are untouched, and the reversal carries the opposite
 * side. Reports take POSTED entries plus their reversals as a pair, so a voided
 * entry nets to zero rather than vanishing from the record.
 *
 * Money is stored as canonical 2dp strings rather than BSON doubles or paisa
 * integers — see `shared/db/money-field.ts` for why, and note that a line never
 * stores a negative amount: the side it sits on expresses direction.
 */
const journalEntrySchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    /** Gapless per (org, kind, year). Null while the entry is a draft. */
    entry_no: { type: String, default: null, maxlength: 32 },
    entry_year: { type: Number, default: null },
    /** Numeric part of `entry_no`, stored so "highest issued this year" is an
     *  indexed max rather than a string sort. Null while a draft. */
    entry_seq: { type: Number, default: null, min: 1 },

    /** Business date, no time and no timezone. Drives the period. */
    date: { type: String, required: true, match: DATE_PATTERN },
    /** Denormalised from `date`, as on Expense: a period lookup is an equality scan. */
    period_key: { type: String, required: true, match: MONTH_PATTERN, index: true },

    description: { type: String, required: true, trim: true, maxlength: 300 },

    /** What produced this entry, so the journal can be read as a story. */
    source: {
      type: String,
      enum: [
        "MANUAL",
        "OPENING",
        "EXPENSE",
        "SALARY",
        "INVOICE",
        "BILL",
        "RECEIPT",
        "PAYMENT",
        "CREDIT_NOTE",
        "DEBIT_NOTE",
        "TRANSFER",
        "BANK_CORRECTION",
        "TAX_CHALLAN",
        "STOCK_ADJUSTMENT",
        "STOCKTAKE",
        "ASSET_ACQUISITION",
        "DEPRECIATION",
        "DISPOSAL",
        "ADVANCE",
        "REVERSAL",
        "PAYROLL",
        "PAYROLL_PAYMENT",
        "STAFF_LOAN",
      ],
      default: "MANUAL",
    },
    source_id: { type: String, default: "", maxlength: 64 },

    status: { type: String, enum: ["DRAFT", "POSTED", "VOID"], default: "DRAFT", index: true },

    /** Set on a reversal, pointing at the entry it cancels. */
    reverses_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    /** Set on an entry that has been voided, pointing at its reversal. */
    reversed_by_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    void_reason: { type: String, default: "", maxlength: 300 },

    created_by: { type: String, required: true },
    posted_by: { type: String, default: "" },
    posted_at: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

journalEntrySchema.index({ org_id: 1, date: -1 });
journalEntrySchema.index({ org_id: 1, status: 1, date: -1 });
journalEntrySchema.index({ org_id: 1, entry_no: 1 }, { unique: true, partialFilterExpression: { entry_no: { $ne: null } } });

/**
 * One side of one entry. The account is referenced by id for the join and by
 * code for the human reading a printout — codes are what an accountant expects
 * to see, and resolving them at read time would let a later renumbering rewrite
 * how an old entry displays.
 */
const journalLineSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", required: true, index: true },

    account_id: { type: Schema.Types.ObjectId, ref: "CoaAccount", required: true },
    account_code: { type: String, required: true, maxlength: 24 },
    account_name: { type: String, required: true, maxlength: 120 },

    /**
     * Both sides are always present and always canonical 2dp; the side that is
     * not used carries "0.00". Stating both rather than leaving one absent means
     * the balanced check can read the document literally instead of treating
     * `undefined` as zero — a missing value and a zero are different claims, and
     * only one of them is something a ledger should accept silently.
     */
    debit_bdt: moneyField(),
    credit_bdt: moneyField(),

    memo: { type: String, trim: true, maxlength: 300, default: "" },
    /** Set in later phases when a line belongs to a party (AR/AP sub-ledger). */
    party_id: { type: String, default: "", maxlength: 64 },
    /** Branch / department tagging, added in P12. */
    segment_id: { type: String, default: "", maxlength: 64 },

    sort_order: { type: Number, required: true, default: 0 },
  },
  { timestamps: true, versionKey: false },
);

journalLineSchema.index({ entry_id: 1, sort_order: 1 });
journalLineSchema.index({ org_id: 1, account_id: 1 });

export type JournalEntryDocument = InferSchemaType<typeof journalEntrySchema>;
export type JournalLineDocument = InferSchemaType<typeof journalLineSchema>;

export const JournalEntryModel =
  (mongoose.models["JournalEntry"] as Model<JournalEntryDocument> | undefined) ??
  mongoose.model<JournalEntryDocument>("JournalEntry", journalEntrySchema);

export const JournalLineModel =
  (mongoose.models["JournalLine"] as Model<JournalLineDocument> | undefined) ??
  mongoose.model<JournalLineDocument>("JournalLine", journalLineSchema);
