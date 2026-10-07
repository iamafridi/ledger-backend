import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";
import { moneyField, DATE_PATTERN } from "../../shared/db/money-field.js";

export const FREQUENCIES = ["MONTHLY", "QUARTERLY", "ANNUAL", "WEEKLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const TEMPLATE_STATUSES = ["ACTIVE", "PAUSED", "COMPLETED"] as const;
export type TemplateStatus = (typeof TEMPLATE_STATUSES)[number];

const templateLineSchema = new Schema(
  {
    account_id: { type: Schema.Types.ObjectId, ref: "CoaAccount", required: true },
    account_code: { type: String, required: true, maxlength: 24 },
    account_name: { type: String, required: true, maxlength: 120 },
    debit_bdt: moneyField(),
    credit_bdt: moneyField(),
    memo: { type: String, trim: true, maxlength: 300, default: "" },
    party_id: { type: String, trim: true, maxlength: 64, default: "" },
    segment_id: { type: String, trim: true, maxlength: 64, default: "" },
  },
  { _id: false },
);

const executionRunSchema = new Schema(
  {
    run_date: { type: String, required: true, match: DATE_PATTERN },
    period_key: { type: String, required: true },
    entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", required: true },
    entry_no: { type: String, required: true },
    reversed_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    executed_at: { type: Date, default: Date.now },
    executed_by: { type: String, required: true },
  },
  { _id: false },
);

const recurringTemplateSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    template_name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    frequency: { type: String, required: true, enum: FREQUENCIES, default: "MONTHLY" },
    next_run_date: { type: String, required: true, match: DATE_PATTERN },
    end_date: { type: String, match: DATE_PATTERN, default: null },
    is_accrual: { type: Boolean, required: true, default: false },
    auto_post: { type: Boolean, required: true, default: false },
    status: { type: String, required: true, enum: TEMPLATE_STATUSES, default: "ACTIVE" },

    lines: { type: [templateLineSchema], required: true },
    runs: { type: [executionRunSchema], default: [] },

    last_run_date: { type: String, match: DATE_PATTERN, default: null },
    last_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
  },
  { timestamps: true, versionKey: false },
);

recurringTemplateSchema.index({ org_id: 1, status: 1 });
recurringTemplateSchema.index({ org_id: 1, next_run_date: 1 });

export type RecurringTemplateDocument = InferSchemaType<typeof recurringTemplateSchema>;

export const RecurringTemplateModel =
  (mongoose.models["RecurringTemplate"] as Model<RecurringTemplateDocument> | undefined) ??
  mongoose.model<RecurringTemplateDocument>("RecurringTemplate", recurringTemplateSchema);
