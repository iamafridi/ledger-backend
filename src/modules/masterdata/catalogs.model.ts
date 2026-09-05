/**
 * The small catalogs every document line draws on: units of measure, tax rates
 * and categories.
 *
 * Three tiny collections rather than three embedded arrays on the organisation
 * because each one has its own lifecycle — unique codes per org, active flags,
 * audit rows — and because a line snapshots from them (plan §5.4): once a rate
 * has been copied onto a line it is immutable, so the master row is free to
 * change without rewriting history. That only works if the masters are rows
 * with their own identity, not fields on a settings document.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * A unit of measure. `symbol` is what prints on a document ("pc", "kg");
 * `name` is what a person picks in a form ("Kilogram").
 */
const unitSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    symbol: { type: String, required: true, trim: true, maxlength: 8 },
    is_active: { type: Boolean, default: true, index: true },
    created_by: { type: String, default: "" },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

unitSchema.index({ org_id: 1, name: 1 }, { unique: true });

export type UnitDocument = InferSchemaType<typeof unitSchema>;

export const UnitModel =
  (mongoose.models["Unit"] as Model<UnitDocument> | undefined) ??
  mongoose.model<UnitDocument>("Unit", unitSchema);

/**
 * A tax rate.
 *
 * `rate_percent` is a canonical 2dp string ("15.00"), not a double: a rate is
 * multiplied into money, and the same argument that money cannot be a JSON
 * number applies to anything that feeds it (see `shared/validation/schemas.ts`).
 *
 * `code` is what items and document lines reference — stable while the name and
 * the percentage stay editable, because "VAT15" can become 15% → 12% without
 * breaking a single stored document, each of which snapshots the rate it was
 * issued under.
 *
 * `kind` is the P7 addition, and it is the whole reason withholding could be
 * added without a second collection. A VAT rate adds tax to a line; a
 * withholding rate removes tax from a payment (source tax, VDS, AIT). Both are
 * "a percentage with a code", both are seeded and admin-editable, and a document
 * line that names one of the second kind is refused rather than accepted — so
 * one table with a `kind` says exactly what two tables would have said, and a
 * rate cannot exist as both at once.
 */
const taxRateSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    code: { type: String, required: true, trim: true, maxlength: 24 },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    /** VAT adds tax to a sale or purchase line; WITHHOLDING is deducted from a
     *  supplier payment and owed to the tax office instead. */
    kind: {
      type: String,
      enum: ["VAT", "WITHHOLDING"],
      default: "VAT",
      index: true,
    },
    rate_percent: {
      type: String,
      required: true,
      match: [/^\d{1,3}\.\d{2}$/, "Rate must be stored like 15.00."],
      default: "0.00",
    },
    is_active: { type: Boolean, default: true, index: true },
    created_by: { type: String, default: "" },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

taxRateSchema.index({ org_id: 1, code: 1 }, { unique: true });

export type TaxRateDocument = InferSchemaType<typeof taxRateSchema>;

export const TaxRateModel =
  (mongoose.models["TaxRate"] as Model<TaxRateDocument> | undefined) ??
  mongoose.model<TaxRateDocument>("TaxRate", taxRateSchema);

/**
 * A category — a named way to group transactions, wired to the account its
 * transactions post to.
 *
 * The account mapping is the whole point: a category is how a person thinks
 * ("this is Rent"), and `account_code` is how the ledger thinks (5200), and the
 * row is the bridge between them. The seed ships the personal-ledger categories
 * with the mapping `coa-seed.ts` already uses, so the chart, the expenses and
 * the category list cannot disagree on day one.
 *
 * `(org, kind, name)` is unique rather than name alone, so "Services" can be an
 * expense category and an income category at once without either being wrong.
 */
const categorySchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 40 },
    kind: { type: String, enum: ["EXPENSE", "INCOME"], required: true, default: "EXPENSE" },
    /** The chart account transactions in this category post to, by code. */
    account_code: { type: String, required: true, trim: true, maxlength: 24 },
    is_active: { type: Boolean, default: true, index: true },
    created_by: { type: String, default: "" },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

categorySchema.index({ org_id: 1, kind: 1, name: 1 }, { unique: true });

export type CategoryDocument = InferSchemaType<typeof categorySchema>;

/** Named `MasterCategory` because "category" alone is already the expense
 *  line's own field everywhere else in this codebase. */
export const MasterCategoryModel =
  (mongoose.models["MasterCategory"] as Model<CategoryDocument> | undefined) ??
  mongoose.model<CategoryDocument>("MasterCategory", categorySchema);
