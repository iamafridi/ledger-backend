/**
 * Organisation-wide settings — the profile every document prints and the
 * numbering rules every document follows.
 *
 * Deliberately *not* more fields on the `Organization` document: that row is
 * read on every request (org resolution reads it), so every optional profile
 * field added to it is read on every request too. This row is read when a
 * profile is shown or a number is issued, which is what optional data should
 * cost.
 *
 * `numbering_prefixes` is the org's claim on the sequence format (plan §5.3):
 * an empty prefix keeps the plain `2026-01` shape, a set one becomes
 * `INV-2026-01`. A prefix change affects numbers issued *after* it — old
 * numbers are never restated, which is the same rule as everything else here.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const NUMBERING_KINDS = [
  "journal",
  "invoice",
  "bill",
  "receipt",
  "credit_note",
  "payment",
  "debit_note",
  "transfer",
  // P7's tax documents. A challan and a withholding certificate are numbers a
  // tax office is given, so they are issued gaplessly like every other document
  // rather than being labelled with a timestamp.
  "challan",
  "tax_certificate",
] as const;

export type NumberingKind = (typeof NUMBERING_KINDS)[number];

/** Letters, digits and dashes only — the prefix ends up in a document number
 *  that people copy into emails and spreadsheets, so no spaces or punctuation. */
export const NUMBERING_PREFIX_PATTERN = /^[A-Za-z0-9-]*$/;

const numberingPrefixesSchema = new Schema(
  {
    journal: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    invoice: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    bill: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    receipt: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    credit_note: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    payment: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    debit_note: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    transfer: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    challan: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
    tax_certificate: { type: String, default: "", maxlength: 12, match: [NUMBERING_PREFIX_PATTERN, "Bad prefix."] },
  },
  { _id: false },
);

export type NumberingPrefixes = InferSchemaType<typeof numberingPrefixesSchema>;

const orgSettingsSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, unique: true },

    address: { type: String, trim: true, maxlength: 300, default: "" },
    /** A URL, not an upload: file storage was cut from the portfolio scope. */
    logo_url: { type: String, trim: true, maxlength: 500, default: "" },
    /** BIN/TIN — the Bangladeshi business tax identification a VAT invoice
     *  must print. Free text because the format has changed shape more than
     *  once and a wrong regex locks a legitimate taxpayer out of their own
     *  settings screen. */
    bin: { type: String, trim: true, maxlength: 30, default: "" },

    /**
     * How tax is treated on document lines:
     *   NONE       the org does not charge tax
     *   EXCLUSIVE  line amounts are net; tax adds on top
     *   INCLUSIVE  line amounts already contain the tax
     */
    vat_mode: {
      type: String,
      enum: ["NONE", "EXCLUSIVE", "INCLUSIVE"],
      required: true,
      default: "NONE",
    },

    numbering_prefixes: { type: numberingPrefixesSchema, default: () => ({}) },
  },
  { timestamps: true, versionKey: false },
);

export type OrgSettingsDocument = InferSchemaType<typeof orgSettingsSchema>;

export const OrgSettingsModel =
  (mongoose.models["OrgSettings"] as Model<OrgSettingsDocument> | undefined) ??
  mongoose.model<OrgSettingsDocument>("OrgSettings", orgSettingsSchema);
