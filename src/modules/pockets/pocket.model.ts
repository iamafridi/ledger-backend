import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField } from "../../shared/db/money-field.js";

const pocketSchema = new Schema(
  {
    uid: { type: String, required: true, trim: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    /** The specific thing being saved for — required item 4 asks for it by name. */
    item: { type: String, required: true, trim: true, maxlength: 300 },
    target_bdt: moneyField(),
    monthly_contribution_bdt: moneyField(),
    /** Money already put aside. Kept separate from the target so progress is a
     *  fact the user asserts, not something inferred from elapsed months. */
    saved_bdt: moneyField(false),
  },
  { timestamps: true, versionKey: false },
);

pocketSchema.index({ uid: 1, createdAt: 1 });

export type PocketDocument = InferSchemaType<typeof pocketSchema>;

/**
 * `mongoose.models` is consulted first so a dev-server hot reload reuses the
 * compiled model instead of throwing OverwriteModelError on re-registration.
 * The cast restores the document type, which the lookup erases.
 */
export const PocketModel = (mongoose.models["Pocket"] as Model<PocketDocument> | undefined) ??
  mongoose.model<PocketDocument>("Pocket", pocketSchema);
