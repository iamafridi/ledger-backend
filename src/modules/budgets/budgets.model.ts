import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import { moneyField } from "../../shared/db/money-field.js";

const budgetSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    fiscal_year_id: { type: Schema.Types.ObjectId, ref: "FiscalYear" },
    period_key: { type: String, required: true, trim: true, maxlength: 10 }, // e.g. "2026-07"
    account_id: { type: Schema.Types.ObjectId, ref: "CoaAccount", required: true },
    account_code: { type: String, required: true, trim: true, maxlength: 24 },
    account_name: { type: String, required: true, trim: true, maxlength: 120 },
    segment_id: { type: String, default: "", trim: true, maxlength: 64 },
    budget_bdt: moneyField(),
    notes: { type: String, trim: true, maxlength: 300, default: "" },
  },
  { timestamps: true, versionKey: false },
);

budgetSchema.index({ org_id: 1, period_key: 1, account_code: 1, segment_id: 1 }, { unique: true });
budgetSchema.index({ org_id: 1, account_id: 1, period_key: 1 });

export type BudgetDocument = InferSchemaType<typeof budgetSchema>;

export const BudgetModel =
  (mongoose.models["Budget"] as Model<BudgetDocument> | undefined) ??
  mongoose.model<BudgetDocument>("Budget", budgetSchema);
