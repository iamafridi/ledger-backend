import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { MONTH_PATTERN, moneyField } from "../../shared/db/money-field.js";

/**
 * One salary per user per month. Salary changes over time and the dashboard
 * compares two months, so a single "current salary" on a profile would silently
 * restate last month's figures whenever someone got a raise.
 */
const salarySchema = new Schema(
  {
    uid: { type: String, required: true, trim: true },
    month: { type: String, required: true, match: MONTH_PATTERN },
    amount_bdt: moneyField(),
  },
  { timestamps: true, versionKey: false },
);

salarySchema.index({ uid: 1, month: 1 }, { unique: true });

export type SalaryDocument = InferSchemaType<typeof salarySchema>;

/**
 * `mongoose.models` is consulted first so a dev-server hot reload reuses the
 * compiled model instead of throwing OverwriteModelError on re-registration.
 * The cast restores the document type, which the lookup erases.
 */
export const SalaryModel = (mongoose.models["Salary"] as Model<SalaryDocument> | undefined) ??
  mongoose.model<SalaryDocument>("Salary", salarySchema);
