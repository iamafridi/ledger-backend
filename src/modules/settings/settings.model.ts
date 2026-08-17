import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Per-user preferences. The DPS rate lives here rather than being hard-coded so
 * the figure the app quotes is a stated, editable rate — required item 4 asks
 * for the return "at a rate you state", and a rate the user cannot see or change
 * is not a stated rate.
 */
const settingsSchema = new Schema(
  {
    uid: { type: String, required: true, trim: true, unique: true },
    dps_annual_rate_percent: {
      type: String,
      required: true,
      match: [/^\d+(\.\d{1,2})?$/, "Rate must be a decimal with up to two places."],
      default: "8.00",
    },
    currency: { type: String, default: "BDT" },
    /**
     * The reference date the forecast should treat as "today".
     *
     * Set when a published case is loaded, because a case states its own `today`
     * (PUB-01 is the 17th of April) and the forecast is only reproducible
     * against the dataset if that date is used. Absent for an ordinary user, who
     * gets the real date.
     */
    as_of_date: { type: String, match: [/^\d{4}-\d{2}-\d{2}$/, "Bad date."] },
  },
  { timestamps: true, versionKey: false },
);

export type SettingsDocument = InferSchemaType<typeof settingsSchema>;

/**
 * `mongoose.models` is consulted first so a dev-server hot reload reuses the
 * compiled model instead of throwing OverwriteModelError on re-registration.
 * The cast restores the document type, which the lookup erases.
 */
export const SettingsModel = (mongoose.models["Settings"] as Model<SettingsDocument> | undefined) ??
  mongoose.model<SettingsDocument>("Settings", settingsSchema);

export const DEFAULT_DPS_RATE = "8.00";
