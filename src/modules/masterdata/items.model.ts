import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Items — what is actually being sold or bought (P3/P4).
 *
 * An item is a *default*, not a constraint: a document line may quote its own
 * price, quantity and tax, but starting from the item's defaults is what makes
 * raising a repeated invoice a form-filling exercise rather than a memory test.
 *
 * The three account mappings (income, COGS, expense) are what turn a line into
 * journal postings later: a sale credits income, a purchase debits expense, and
 * a stock-tracked sale also debits COGS against inventory. Storing them here —
 * by code, like everything else that points at the chart — means an item can be
 * sold by one account and consumed by another without a special case per
 * document.
 *
 * `tax_code` names a row in `taxRates` rather than storing a percentage,
 * because a rate changes over time: documents snapshot the rate at line time
 * (plan §5.4) while the item simply says which rate to start from.
 *
 * `sku` is unique per organisation and, like a party's code, immutable after
 * creation — stock and reports key off it.
 */
const itemSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    sku: { type: String, required: true, trim: true, maxlength: 32 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500, default: "" },

    /** Quantity-on-hand tracked? Off for services and one-off purchases. */
    track_stock: { type: Boolean, default: false },
    unit_id: { type: Schema.Types.ObjectId, ref: "Unit", default: null },

    /**
     * At or below this many on hand, the stock screen calls the item low.
     *
     * A plain quantity, not money, so a Number like a document line's `qty`. The
     * default of 0 is deliberate: it means "only out of stock counts as low",
     * which is the honest answer for an organisation that has not set a level —
     * better than inventing a threshold nobody chose.
     */
    reorder_level: { type: Number, default: 0, min: 0 },

    /** Default tax rate, by its master-data code. "" = no tax. */
    tax_code: { type: String, trim: true, maxlength: 24, default: "" },

    income_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    cogs_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    expense_account_code: { type: String, required: true, trim: true, maxlength: 24 },

    is_active: { type: Boolean, default: true, index: true },

    created_by: { type: String, default: "" },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

itemSchema.index({ org_id: 1, sku: 1 }, { unique: true });
itemSchema.index({ org_id: 1, name: 1 });

export type ItemDocument = InferSchemaType<typeof itemSchema>;

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled
 *  model instead of throwing OverwriteModelError on re-registration. */
export const ItemModel =
  (mongoose.models["Item"] as Model<ItemDocument> | undefined) ??
  mongoose.model<ItemDocument>("Item", itemSchema);
