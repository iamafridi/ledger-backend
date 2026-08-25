import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { CATEGORIES } from "../../shared/ocr/types.js";
import { DATE_PATTERN, MONTH_PATTERN, moneyField } from "../../shared/db/money-field.js";

const expenseSchema = new Schema(
  {
    uid: { type: String, required: true, trim: true, index: true },
    date: { type: String, required: true, match: DATE_PATTERN },
    /**
     * Denormalised from `date`. Every dashboard read filters by month, and an
     * index on a stored month is a range-free equality lookup; deriving it in a
     * query would mean a collection scan with a $substr expression.
     * Kept in sync in one place — see `expense.service.ts`.
     */
    month: { type: String, required: true, match: MONTH_PATTERN },
    category: { type: String, required: true, enum: CATEGORIES },
    shop: { type: String, required: true, trim: true, maxlength: 120 },
    amount_bdt: moneyField(),
    /** Manual entry or a reviewed receipt scan. Drives the provenance chip. */
    source: { type: String, enum: ["manual", "receipt"], default: "manual" },
    note: { type: String, trim: true, maxlength: 500, default: "" },

    /**
     * Where the scanned or photographed document lives — a URL, never bytes.
     *
     * Plan §6 Phase 4 calls for attachment **metadata** pointing at object
     * storage (the plan §3 risk table rules out writing files to a serverless
     * disk, and Mongo's document cap rules out the bytes themselves). This row
     * records where the file is; nothing here fetches, stores or renders it.
     */
    attachment_url: { type: String, trim: true, maxlength: 500, default: "" },

    /**
     * The organisation whose books this expense is posted into (plan §4, D3).
     *
     * Linkage metadata only. The row is still *scoped* by `uid`, because a
     * personal expense belongs to a person and not to an organisation — an
     * accountant added to an org in a later phase must not thereby gain sight of
     * a colleague's private groceries. Every read in this module therefore
     * filters on `uid` and never on `org_id`.
     */
    org_id: { type: Schema.Types.ObjectId, default: null },

    /**
     * The journal entry this expense posted, or null while it is not in the
     * books.
     *
     * Never edited in place: changing an expense voids its entry and writes a
     * new one, so this always names the *live* entry for the row's current
     * values. Null is a real, repairable state — see `expense-ledger.ts` — and
     * the integrity run counts it, which is what keeps "fail-soft" from turning
     * into "silently missing from the books".
     */
    journal_entry_id: { type: Schema.Types.ObjectId, default: null, index: true },
  },
  { timestamps: true, versionKey: false },
);

expenseSchema.index({ uid: 1, month: 1, date: -1 });
expenseSchema.index({ uid: 1, month: 1, category: 1 });

export type ExpenseDocument = InferSchemaType<typeof expenseSchema>;

/**
 * `mongoose.models` is consulted first so a dev-server hot reload reuses the
 * compiled model instead of throwing OverwriteModelError on re-registration.
 * The cast restores the document type, which the lookup erases.
 */
export const ExpenseModel = (mongoose.models["Expense"] as Model<ExpenseDocument> | undefined) ??
  mongoose.model<ExpenseDocument>("Expense", expenseSchema);
