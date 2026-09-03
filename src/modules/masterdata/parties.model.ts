import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField } from "../../shared/db/money-field.js";

/**
 * Parties — the customers and suppliers documents will be issued to (P3 sales,
 * P4 purchases).
 *
 * `code` is the short, human-typed handle an accountant actually uses on a
 * document ("C01", "BAAL") and is unique per organisation, so one org's codes
 * say nothing about another's. It is assigned at creation and never edited:
 * a document that quoted `KHAN` must not start meaning something else because
 * a list was re-sorted three months later.
 *
 * `control_account_code` is the double-entry link back to the chart. A party is
 * not an account — its *balance* lives on one (1100 Accounts Receivable for
 * customers, 2000 Accounts Payable for suppliers), and every future document
 * line that carries a party carries this account with it, so the control
 * account can always tie the party sub-ledger to the general ledger (integrity
 * check I5).
 *
 * Parties are deactivated, never deleted: history that names them must keep
 * resolving.
 */
const partySchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    code: { type: String, required: true, trim: true, maxlength: 24 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    kind: { type: String, enum: ["CUSTOMER", "SUPPLIER", "BOTH"], required: true, default: "BOTH" },

    email: { type: String, trim: true, lowercase: true, maxlength: 200, default: "" },
    phone: { type: String, trim: true, maxlength: 40, default: "" },
    address: { type: String, trim: true, maxlength: 300, default: "" },

    /** The chart account this party's balance posts to, by code. */
    control_account_code: { type: String, required: true, trim: true, maxlength: 24 },

    /**
     * How much credit this party may run up before P3 warns (plan §6).
     *
     * **A warning, never a block.** "0.00" means no limit is set, which is the
     * default: a ledger that refused to issue an invoice because somebody had
     * not filled in a limit field would be a worse failure than an overdue
     * receivable. The number exists so the warning can be specific — "this takes
     * them to 84,500.00 against a 50,000.00 limit" — rather than a vague nag.
     */
    credit_limit_bdt: moneyField(),

    is_active: { type: Boolean, default: true, index: true },

    created_by: { type: String, default: "" },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

partySchema.index({ org_id: 1, code: 1 }, { unique: true });
partySchema.index({ org_id: 1, name: 1 });

export type PartyDocument = InferSchemaType<typeof partySchema>;

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled
 *  model instead of throwing OverwriteModelError on re-registration. */
export const PartyModel =
  (mongoose.models["Party"] as Model<PartyDocument> | undefined) ??
  mongoose.model<PartyDocument>("Party", partySchema);
