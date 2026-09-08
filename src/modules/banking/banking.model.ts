/**
 * Banking & cash — the collections of plan §6 Phase 6.
 *
 * WHAT A BANK ACCOUNT IS HERE
 * A `BankAccount` is *not* a second ledger. It is a **view of one asset account
 * in the chart**, plus the details a bank needs printed on a transfer (branch,
 * account number, SWIFT). Money only ever moves through `postJournal`, so the
 * balance on the banking screen and the balance in the trial balance are the
 * same number read twice, and the unique index on `(org_id, account_code)`
 * makes the 1:1 mapping a database fact rather than a convention somebody has to
 * remember.
 *
 * WHY THE STATEMENT LINES ARE STORED AT ALL
 * A bank statement is evidence from outside the books. Keeping each imported
 * line — with its own date, reference and running balance — is what lets
 * reconciliation *show its work*: which lines the books already know, which the
 * bank reported and the books do not, and what is still in transit. Summarising
 * the statement into one "bank balance" field would answer the question and
 * destroy the audit trail behind it.
 *
 * DIRECTION IS AN ENUM, NEVER A SIGN
 * `amount_bdt` is a canonical non-negative 2dp string and `direction` says which
 * way the money went, for the same reason a journal line does it that way: a
 * stored `-500` cannot say whether it means a withdrawal, a charge or a typo.
 *
 * NOTHING IS EVER DELETED
 * A transfer is voided (its journal entry is reversed); a statement line is
 * matched, corrected or ignored, never removed. Ignoring is recorded with the
 * person and the reason, so a reviewer can see the item was considered.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField, DATE_PATTERN } from "../../shared/db/money-field.js";

/* ── Bank & cash accounts ────────────────────────────────────────────────── */

const bankAccountSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    /** BANK moves money electronically; CASH is the till. Both are the same row
     *  because the reconciliation arithmetic is identical — only the label and
     *  the chart account they point at differ. */
    kind: { type: String, enum: ["BANK", "CASH"], required: true, default: "BANK" },

    /** What the screen and the transfer memo call it ("City Bank — Current"). */
    name: { type: String, required: true, trim: true, maxlength: 120 },

    /** The chart account this is a view of. Must be an ASSET account, and the
     *  unique index below makes the mapping 1:1. */
    account_code: { type: String, required: true, trim: true, maxlength: 24 },
    account_name: { type: String, trim: true, maxlength: 120, default: "" },

    bank_name: { type: String, trim: true, maxlength: 120, default: "" },
    branch: { type: String, trim: true, maxlength: 120, default: "" },
    account_number: { type: String, trim: true, maxlength: 40, default: "" },
    routing_number: { type: String, trim: true, maxlength: 40, default: "" },
    swift_code: { type: String, trim: true, maxlength: 20, default: "" },

    /** The closing balance printed on the most recently imported statement, and
     *  the date it was drawn at. Purely informational: the **book** balance is
     *  always derived from the ledger, and the difference between the two is
     *  exactly what reconciliation exists to explain. */
    last_statement_balance_bdt: moneyField(false),
    last_statement_date: { type: String, match: DATE_PATTERN, default: "" },

    is_active: { type: Boolean, default: true, index: true },
    memo: { type: String, trim: true, maxlength: 300, default: "" },

    created_by: { type: String, required: true },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

/** The 1:1 mapping, enforced by the database rather than by discipline. */
bankAccountSchema.index({ org_id: 1, account_code: 1 }, { unique: true });

/* ── Transfers ───────────────────────────────────────────────────────────── */

/**
 * A transfer between two of the organisation's own accounts.
 *
 * It posts exactly **one** balanced journal entry (debit destination, credit
 * source; a bank fee, if any, debits an expense account and is included in the
 * credit total), because two separate entries — money leaving and money
 * arriving — can half-fail, and a half-completed transfer invents money.
 */
const transferSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    doc_no: { type: String, required: true, trim: true, maxlength: 32 },
    doc_year: { type: Number, required: true },
    doc_seq: { type: Number, required: true, min: 1 },

    from_account_id: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true, index: true },
    to_account_id: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true, index: true },
    /** Denormalised codes so a list read needs no join, and so the transfer
     *  still reads correctly if an account is renamed or deactivated. */
    from_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    to_account_code: { type: String, required: true, trim: true, maxlength: 24 },

    date: { type: String, required: true, match: DATE_PATTERN },
    amount_bdt: moneyField(),
    /** A wire or transfer fee, when the bank charged one. Zero means none, and
     *  no fee line is posted. */
    fee_bdt: moneyField(false),
    fee_account_code: { type: String, trim: true, maxlength: 24, default: "" },

    memo: { type: String, trim: true, maxlength: 300, default: "" },
    status: { type: String, enum: ["POSTED", "VOID"], default: "POSTED", index: true },

    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    void_reason: { type: String, trim: true, maxlength: 300, default: "" },

    created_by: { type: String, required: true },
    voided_by: { type: String, default: "" },
    voided_at: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

transferSchema.index({ org_id: 1, doc_no: 1 }, { unique: true });
transferSchema.index({ org_id: 1, date: -1 });

/* ── Statement imports ───────────────────────────────────────────────────── */

/**
 * One imported statement file.
 *
 * Kept as its own row so a whole upload can be reviewed as a unit — "this is
 * what arrived on the 3rd, this is how much of it has been dealt with" — and so
 * a duplicate upload is detectable (the per-line fingerprint below) without
 * guessing from the lines themselves.
 */
const statementImportSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    bank_account_id: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true, index: true },

    filename: { type: String, trim: true, maxlength: 200, default: "" },
    /** How many data rows the file held, how many were stored, and how many were
     *  dropped as fingerprints this account had already seen. */
    line_count: { type: Number, required: true, min: 0 },
    imported_count: { type: Number, required: true, min: 0 },
    duplicate_count: { type: Number, required: true, min: 0 },

    period_from: { type: String, match: DATE_PATTERN, default: "" },
    period_to: { type: String, match: DATE_PATTERN, default: "" },
    /** The statement's own opening/closing figures when the file carried a
     *  running-balance column. Blank when it did not — and blank is preferred
     *  over an invention. */
    opening_balance_bdt: moneyField(false),
    closing_balance_bdt: moneyField(false),

    imported_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

statementImportSchema.index({ org_id: 1, bank_account_id: 1, createdAt: -1 });

/* ── Statement lines ─────────────────────────────────────────────────────── */

/**
 * One line of a bank statement, and its reconciliation state.
 *
 * The four states are the four things a person can honestly decide about a line:
 *
 *   UNMATCHED  nothing has been said about it yet
 *   MATCHED    it is the bank's view of a journal line already in the books
 *   CORRECTED  it was in neither, so the missing entry was posted from here
 *   IGNORED    it is not to be acted on (an informational line, or a duplicate
 *              the books already carry through another route) — recorded with a
 *              reason, because "ignored" with no reason is indistinguishable
 *              from "forgotten"
 *
 * `fingerprint` is derived from the line's own content so that re-uploading an
 * overlapping statement does not silently double the evidence.
 */
const statementLineSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    bank_account_id: { type: Schema.Types.ObjectId, ref: "BankAccount", required: true, index: true },
    batch_id: { type: Schema.Types.ObjectId, ref: "StatementImport", required: true, index: true },

    /** Position in the file, so the lines print in the bank's own order. */
    seq: { type: Number, required: true, min: 0 },

    date: { type: String, required: true, match: DATE_PATTERN },
    description: { type: String, trim: true, maxlength: 500, default: "" },
    reference: { type: String, trim: true, maxlength: 120, default: "" },

    direction: { type: String, enum: ["IN", "OUT"], required: true },
    amount_bdt: moneyField(),
    /** The running balance the statement printed, when it printed one. */
    balance_bdt: moneyField(false),

    fingerprint: { type: String, required: true, trim: true, maxlength: 80 },

    status: {
      type: String,
      enum: ["UNMATCHED", "MATCHED", "CORRECTED", "IGNORED"],
      default: "UNMATCHED",
      index: true,
    },

    matched_line_id: { type: Schema.Types.ObjectId, ref: "JournalLine", default: null },
    matched_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    matched_entry_no: { type: String, trim: true, maxlength: 32, default: "" },
    /** Amount of the journal line this was matched to, kept so the workspace can
     *  show a pairing whose two halves disagree without re-reading the ledger. */
    matched_amount_bdt: moneyField(false),

    adjustment_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    counter_account_code: { type: String, trim: true, maxlength: 24, default: "" },

    note: { type: String, trim: true, maxlength: 300, default: "" },
    resolved_by: { type: String, default: "" },
    resolved_at: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

statementLineSchema.index({ org_id: 1, bank_account_id: 1, date: 1, seq: 1 });
statementLineSchema.index({ org_id: 1, bank_account_id: 1, fingerprint: 1 });
statementLineSchema.index({ org_id: 1, bank_account_id: 1, status: 1 });

export type BankAccountDocument = InferSchemaType<typeof bankAccountSchema>;
export type TransferDocument = InferSchemaType<typeof transferSchema>;
export type StatementImportDocument = InferSchemaType<typeof statementImportSchema>;
export type StatementLineDocument = InferSchemaType<typeof statementLineSchema>;

export const BankAccountModel =
  (mongoose.models["BankAccount"] as Model<BankAccountDocument> | undefined) ??
  mongoose.model<BankAccountDocument>("BankAccount", bankAccountSchema);

export const TransferModel =
  (mongoose.models["Transfer"] as Model<TransferDocument> | undefined) ??
  mongoose.model<TransferDocument>("Transfer", transferSchema);

export const StatementImportModel =
  (mongoose.models["StatementImport"] as Model<StatementImportDocument> | undefined) ??
  mongoose.model<StatementImportDocument>("StatementImport", statementImportSchema);

export const StatementLineModel =
  (mongoose.models["StatementLine"] as Model<StatementLineDocument> | undefined) ??
  mongoose.model<StatementLineDocument>("StatementLine", statementLineSchema);
