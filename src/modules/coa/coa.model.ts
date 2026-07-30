import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Chart of accounts — the spine every other module hangs off.
 *
 * `code` is unique per organisation and is what journals, documents and reports
 * refer to. Codes are stable, human-readable and hierarchical by convention
 * (1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx revenue, 5xxx expenses), so
 * an accountant can read a trial balance without a lookup table.
 *
 * `is_system` marks the accounts the posting engine itself writes to — cash,
 * AR, AP, VAT control, retained earnings. Their codes and types are load-
 * bearing: services resolve them by code, so letting one be renamed or
 * deactivated would break posting in a way that only shows up on the next
 * payment. Labels stay editable; codes, types and active state do not.
 *
 * `normal_balance` is stored rather than derived from `type` because a contra
 * account (accumulated depreciation is an ASSET that credits) is exactly the
 * case where "derive it" produces the wrong answer.
 *
 * Accounts are deactivated, never deleted: one with postings against it must
 * keep existing or every historical report that joins to it breaks.
 */
const coaAccountSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    code: { type: String, required: true, trim: true, maxlength: 24 },
    name: { type: String, required: true, trim: true, maxlength: 120 },

    type: { type: String, enum: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"], required: true },
    /** Free-text classification used to group reports (CASH, AR, COGS, ...). */
    subtype: { type: String, trim: true, maxlength: 40, default: "" },
    parent_id: { type: Schema.Types.ObjectId, ref: "CoaAccount", default: null },
    normal_balance: { type: String, enum: ["DEBIT", "CREDIT"], required: true },

    is_system: { type: Boolean, default: false },
    is_active: { type: Boolean, default: true, index: true },

    created_by: { type: String, default: "" },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

coaAccountSchema.index({ org_id: 1, code: 1 }, { unique: true });
coaAccountSchema.index({ org_id: 1, type: 1, code: 1 });

export type CoaAccountDocument = InferSchemaType<typeof coaAccountSchema>;

/**
 * `mongoose.models` is consulted first so a dev-server hot reload reuses the
 * compiled model instead of throwing OverwriteModelError on re-registration.
 * The cast restores the document type, which the lookup erases.
 */
export const CoaAccountModel =
  (mongoose.models["CoaAccount"] as Model<CoaAccountDocument> | undefined) ??
  mongoose.model<CoaAccountDocument>("CoaAccount", coaAccountSchema);
