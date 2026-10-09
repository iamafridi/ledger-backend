import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Fiscal years and their accounting periods.
 *
 * A period is the unit that gets closed. Closing is what makes an accountant
 * able to say "March is final" — after it, the posting engine refuses any entry
 * dated in that period, so a report printed in April cannot quietly change.
 *
 * The key is a `YYYY-MM` string rather than a Date range because every posting
 * derives it from its business date by slicing: no timezone ever enters the
 * calculation, which is the whole reason this codebase parses dates as strings
 * (see `core/calendar.ts`).
 *
 * `closed_by` / `closed_at` are recorded because reopening a period is itself
 * something an owner should be able to see happened, and from whom.
 */
const fiscalYearSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    /** e.g. "2026-07-01" — the first day of the year. */
    start_date: { type: String, required: true, match: [/^\d{4}-\d{2}-\d{2}$/, "Bad date."], maxlength: 10 },
    end_date: { type: String, required: true, match: [/^\d{4}-\d{2}-\d{2}$/, "Bad date."], maxlength: 10 },
    label: { type: String, required: true, trim: true, maxlength: 40 },
    status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN" },
    created_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

fiscalYearSchema.index({ org_id: 1, start_date: 1 }, { unique: true });

const periodSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    fiscal_year_id: { type: Schema.Types.ObjectId, ref: "FiscalYear", required: true, index: true },
    /** "2026-07" — unique per organisation. */
    key: { type: String, required: true, match: [/^\d{4}-(?:0[1-9]|1[0-2])$/, "Period key must look like 2026-07."], maxlength: 7 },
    status: { type: String, enum: ["OPEN", "CLOSED"], default: "OPEN" },
    closed_at: { type: Date },
    closed_by: { type: String, default: "" },
    close_note: { type: String, default: "", maxlength: 300 },
  },
  { timestamps: true, versionKey: false },
);

periodSchema.index({ org_id: 1, key: 1 }, { unique: true });

export type FiscalYearDocument = InferSchemaType<typeof fiscalYearSchema>;
export type PeriodDocument = InferSchemaType<typeof periodSchema>;

export const FiscalYearModel =
  (mongoose.models["FiscalYear"] as Model<FiscalYearDocument> | undefined) ??
  mongoose.model<FiscalYearDocument>("FiscalYear", fiscalYearSchema);

export const PeriodModel =
  (mongoose.models["Period"] as Model<PeriodDocument> | undefined) ??
  mongoose.model<PeriodDocument>("Period", periodSchema);
