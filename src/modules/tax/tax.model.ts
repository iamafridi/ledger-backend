/**
 * Tax documents — the two records withholding needs beyond the payment itself
 * (plan §6 Phase 7).
 *
 * WHY THERE ARE ONLY TWO
 * The tax inside a document line is already recorded, on the line, as an
 * immutable snapshot (`tax_rate_snapshot`, `tax_bdt`), and a payment already
 * carries its own withholdings. So a VAT return and a withholding register are
 * *reads* — they are built from documents that already exist, and there is no
 * "return" collection to drift from the ledger it claims to summarise. What is
 * genuinely new is the two things that happen after the tax is computed:
 *
 *   TaxChallan      money actually deposited with the tax office. Withholding
 *                   turns a payable-to-supplier into a payable-to-the-government,
 *                   and only a challan clears it: `DR 2200 / CR cash`.
 *
 *   TaxCertificate  the paper a supplier is given stating what was withheld from
 *                   them, so they can claim it. It posts nothing (the tax was
 *                   already withheld at payment); it is a numbered record that
 *                   one was issued, which is what makes "we filed it" auditable.
 *
 * Both are numbered through the same gapless sequence service as every other
 * document, because both are numbers quoted to somebody outside the business.
 */
import mongoose, { Schema, type InferSchemaType, type Model, type SchemaDefinitionProperty } from "mongoose";

import { moneyField, MONEY_PATTERN, DATE_PATTERN, MONTH_PATTERN } from "../../shared/db/money-field.js";

/** A rate is a percentage, not an amount — but it is snapshotted onto a
 *  certificate beside the amount it produced, so it travels in the same
 *  canonical 2dp string form as everywhere else. */
const rateField = (defaultValue = "0.00"): SchemaDefinitionProperty<string> => ({
  type: String,
  trim: true,
  default: defaultValue,
  match: [MONEY_PATTERN, "A rate must be a decimal with at most two places."],
});

/**
 * A deposit of withheld tax with the tax office.
 *
 * `challan_ref` is the tax office's own reference number, free text: it comes
 * from a piece of paper the business did not print, and a regex over a form
 * number that has changed shape twice would lock somebody out of recording a
 * real deposit. The document number *this* ledger issued is `doc_no`, and the
 * two are shown together so a discrepancy can be found in either direction.
 */
const taxChallanSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    doc_no: { type: String, required: true, trim: true, maxlength: 32 },
    doc_year: { type: Number, required: true },
    doc_seq: { type: Number, required: true, min: 1 },

    date: { type: String, required: true, match: DATE_PATTERN },

    amount_bdt: moneyField(),

    /** The asset account the money was deposited from (1010 bank by default). */
    account_code: { type: String, required: true, trim: true, maxlength: 24 },
    account_name: { type: String, trim: true, maxlength: 120, default: "" },

    /** The tax office's reference for this deposit, as printed on their receipt. */
    challan_ref: { type: String, trim: true, maxlength: 60, default: "" },
    memo: { type: String, trim: true, maxlength: 300, default: "" },

    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

taxChallanSchema.index({ org_id: 1, doc_no: 1 }, { unique: true });
taxChallanSchema.index({ org_id: 1, date: -1 });

/**
 * A certificate of tax withheld from one supplier for one fiscal month.
 *
 * The lines are a snapshot of what the payments said when the certificate was
 * issued, so a later correction to a payment cannot silently change a document
 * the supplier has already filed. Issuing twice for the same supplier and month
 * is refused: two certificates for one month is exactly the ambiguity that lets
 * a supplier claim the same tax twice.
 */
const certificateWithholdingSchema = new Schema(
  {
    tax_code: { type: String, required: true, trim: true, maxlength: 24 },
    tax_rate_snapshot: rateField(),
    amount_bdt: moneyField(),
  },
  { _id: false },
);

const taxCertificateSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    doc_no: { type: String, required: true, trim: true, maxlength: 32 },
    doc_year: { type: Number, required: true },
    doc_seq: { type: Number, required: true, min: 1 },

    party_id: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },

    date: { type: String, required: true, match: DATE_PATTERN },
    /** The month the withholding belongs to — stored, so "has this party's month
     *  been certified yet?" is an indexed equality rather than a range guess. */
    period_key: { type: String, required: true, match: MONTH_PATTERN, index: true },

    amount_bdt: moneyField(),
    withholdings: { type: [certificateWithholdingSchema], default: [] },

    status: { type: String, enum: ["ISSUED", "VOID"], default: "ISSUED", index: true },
    void_reason: { type: String, trim: true, maxlength: 300, default: "" },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

taxCertificateSchema.index({ org_id: 1, doc_no: 1 }, { unique: true });
taxCertificateSchema.index({ org_id: 1, party_id: 1, period_key: 1, status: 1 });

export type TaxChallanDocument = InferSchemaType<typeof taxChallanSchema>;
export type TaxCertificateDocument = InferSchemaType<typeof taxCertificateSchema>;

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled
 *  model instead of throwing OverwriteModelError on re-registration. */
export const TaxChallanModel =
  (mongoose.models["TaxChallan"] as Model<TaxChallanDocument> | undefined) ??
  mongoose.model<TaxChallanDocument>("TaxChallan", taxChallanSchema);

export const TaxCertificateModel =
  (mongoose.models["TaxCertificate"] as Model<TaxCertificateDocument> | undefined) ??
  mongoose.model<TaxCertificateDocument>("TaxCertificate", taxCertificateSchema);
