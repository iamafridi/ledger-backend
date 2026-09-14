/**
 * Sales & Accounts Receivable — the five collections of plan §6 Phase 3.
 *
 * The shape of this file is the shape of a receivable. An **invoice** is a claim
 * on a customer; a **receipt** is money arriving; a **credit note** is the claim
 * being given back. Everything a screen wants to show about an invoice's status
 * is *derived* from the other three — which is why `paid_bdt` and `credited_bdt`
 * live on the invoice as cache rather than as truth, refreshed only by
 * `recomputeInvoiceSettlement()` reading the rows that actually move money.
 * Two sources of truth for "how much is still owed" is how an aging report and a
 * control account end up disagreeing six months later.
 *
 * Three decisions worth stating plainly:
 *
 * 1. **Nothing here is ever deleted.** A draft can be discarded because no
 *    number was ever claimed for it; an *issued* document is only ever voided,
 *    and voiding writes a reversing entry rather than removing anything.
 *
 * 2. **Credit notes share the line collection with invoices** (`doc_type` +
 *    `doc_id`, exactly the `docId` of plan §5.4). They are the same arithmetic —
 *    quantity, price, discount, tax — pointed the other way, and two line models
 *    would be two places for the totals rule to drift apart.
 *
 * 3. **Money is a canonical 2dp string everywhere**, per `shared/db/money-field.ts`.
 *    `qty` is the one exception, and deliberately so: it is a physical quantity
 *    (1.5 kg), not an amount of money, and it is multiplied into a money value
 *    by decimal arithmetic rather than stored as one.
 */
import mongoose, { Schema, type InferSchemaType, type Model, type SchemaDefinitionProperty } from "mongoose";

import { moneyField, MONEY_PATTERN, DATE_PATTERN } from "../../shared/db/money-field.js";

/** A rate is a percentage, not an amount — but it feeds money arithmetic, so it
 *  travels in the same canonical two-decimal string form. 5%, not 0.05. */
const rateField = (defaultValue = "0.00"): SchemaDefinitionProperty<string> => ({
  type: String,
  trim: true,
  default: defaultValue,
  match: [MONEY_PATTERN, "A rate must be a decimal with at most two places."],
});

/* ── Invoices ────────────────────────────────────────────────────────────── */

/**
 * The status is a summary of facts held elsewhere, and is recomputed from them:
 *
 *   DRAFT           nothing has been posted; the lines are still editable
 *   ISSUED          posted, nothing settled against it
 *   PARTIALLY_PAID  some receipts or credit notes have settled against it
 *   PAID            fully settled
 *   VOID            reversed; the number is burned and never reissued
 *
 * `VOID` is refused while any receipt is allocated to the invoice (plan §6):
 * unwinding a customer's payment is a business event of its own, not a side
 * effect of correcting an invoice.
 */
const invoiceSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    /** Null while the invoice is a draft — a number is claimed only at issue
     *  (plan §5.3), so an abandoned draft leaves no hole in the sequence. */
    doc_no: { type: String, default: null, maxlength: 32 },
    doc_year: { type: Number, default: null },
    doc_seq: { type: Number, default: null, min: 1 },

    party_id: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },

    date: { type: String, required: true, match: DATE_PATTERN },
    /** What the aging report buckets on. Falls back to `date` when blank, which
     *  is the plan's stated rule rather than an accident. */
    due_date: { type: String, match: DATE_PATTERN, default: "" },

    memo: { type: String, trim: true, maxlength: 500, default: "" },

    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "PARTIALLY_PAID", "PAID", "VOID"],
      default: "DRAFT",
      index: true,
    },

    /** Derived from the lines (plan §5.4) and rewritten in the same transaction
     *  as any line change. Never incremented, always recomputed. */
    subtotal_bdt: moneyField(),
    discount_total_bdt: moneyField(),
    tax_total_bdt: moneyField(),
    total_bdt: moneyField(),

    /** Derived from the receipt allocations and credit notes against this
     *  invoice — see `recomputeInvoiceSettlement()`. */
    paid_bdt: moneyField(),
    credited_bdt: moneyField(),

    /** The AR posting. Null on a draft, and a defect worth finding on anything
     *  issued — hence the integrity check that looks for exactly that. */
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    /** Why the invoice the customer is holding no longer counts. */
    void_reason: { type: String, trim: true, maxlength: 300, default: "" },

    created_by: { type: String, required: true },
    issued_by: { type: String, default: "" },
    issued_at: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

invoiceSchema.index({ org_id: 1, date: -1 });
invoiceSchema.index(
  { org_id: 1, doc_no: 1 },
  { unique: true, partialFilterExpression: { doc_no: { $ne: null } } },
);
/** The outstanding query: this party's open invoices, oldest first. */
invoiceSchema.index({ org_id: 1, party_id: 1, status: 1, date: 1 });
/** High-frequency aging and overdue receivables queries */
invoiceSchema.index({ org_id: 1, status: 1, due_date: 1 });

/* ── Document lines (invoices and credit notes) ──────────────────────────── */

/**
 * Plan §5.4, implemented literally.
 *
 * WHAT IS A SNAPSHOT AND WHY
 * `label_snapshot` and `tax_rate_snapshot` are written when the line is created
 * and never touched again. A rate that is edited in the catalog next month must
 * not silently restate a document already in a customer's hands — the line
 * records the percentage it was *issued under*, and every derived amount on it
 * is consistent with that number forever.
 *
 * WHY DIRECTION IS NEVER A SIGN
 * Every stored amount is non-negative and the side it sits on comes from
 * `is_deduction`. A ledger that stores `-500` cannot say whether that means a
 * credit or a discount or a typo, and a report that sums the column gets a
 * number with no defensible meaning.
 */
const invoiceLineSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    /** Which document this line belongs to — `invoiceLines` holds both. */
    doc_type: { type: String, enum: ["INVOICE", "CREDIT_NOTE"], required: true },
    doc_id: { type: Schema.Types.ObjectId, required: true, index: true },

    sort_order: { type: Number, required: true, default: 0 },

    /** The item's name as it stood when the line was written. */
    label_snapshot: { type: String, trim: true, maxlength: 160, default: "" },
    description: { type: String, trim: true, maxlength: 300, default: "" },

    /** A physical quantity, not money: 1.5 kg is a legitimate line. */
    qty: { type: Number, required: true, min: 0 },

    unit_price_bdt: moneyField(),
    discount_bdt: moneyField(),
    net_bdt: moneyField(),
    tax_code: { type: String, trim: true, maxlength: 24, default: "" },
    tax_rate_snapshot: rateField(),
    /** Which way round this line's prices were read — the org's VAT mode at the
     *  moment it was written (plan §6 Phase 7). Snapshotted like the rate itself:
     *  a later change to the profile must not restate a printed document. */
    tax_mode: { type: String, enum: ["EXCLUSIVE", "INCLUSIVE"], default: "EXCLUSIVE" },
    tax_bdt: moneyField(),
    line_total_bdt: moneyField(),

    /** Where the net amount posts: a revenue account for both document types,
     *  because a credit note reverses revenue rather than creating a negative
     *  sale somewhere else. Snapshotted by code, like a journal line. */
    account_code: { type: String, required: true, trim: true, maxlength: 24 },
    account_name: { type: String, trim: true, maxlength: 120, default: "" },
    item_id: { type: Schema.Types.ObjectId, ref: "Item", default: null },

    /** A line that subtracts — a settlement discount, a rebate. Gives the
     *  document a way to go down without any stored amount going negative. */
    is_deduction: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

invoiceLineSchema.index({ doc_type: 1, doc_id: 1, sort_order: 1 });

/* ── Receipts ────────────────────────────────────────────────────────────── */

/**
 * Money received from a customer. Issued immediately — there is no draft
 * state for a receipt, because the money has already arrived by the time
 * anybody types it in.
 *
 * `unallocated_bdt` is the part of the receipt that no invoice claimed, and it
 * is the customer's **advance**: it sits on their account as a credit until a
 * future invoice absorbs it. Storing it explicitly rather than deriving it on
 * every read is what makes integrity check I6 (`advance_outstanding ≥ 0`)
 * answerable without replaying the whole history.
 */
const receiptSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    doc_no: { type: String, required: true, trim: true, maxlength: 32 },
    doc_year: { type: Number, required: true },
    doc_seq: { type: Number, required: true, min: 1 },

    party_id: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },

    date: { type: String, required: true, match: DATE_PATTERN },
    method: { type: String, enum: ["CASH", "BANK"], default: "CASH" },
    /** The asset account the money landed in — 1000 cash or 1010 bank by
     *  default, overridable when an organisation keeps several. */
    account_code: { type: String, required: true, trim: true, maxlength: 24 },
    account_name: { type: String, trim: true, maxlength: 120, default: "" },

    amount_bdt: moneyField(),
    allocated_bdt: moneyField(),
    /** The advance. `allocated + unallocated === amount`, always. */
    unallocated_bdt: moneyField(),

    memo: { type: String, trim: true, maxlength: 300, default: "" },
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

receiptSchema.index({ org_id: 1, date: -1 });
receiptSchema.index({ org_id: 1, doc_no: 1 }, { unique: true });

/**
 * One receipt applied to one invoice.
 *
 * This row is the *only* thing that moves an invoice towards PAID, which is what
 * lets `recomputeInvoiceSettlement()` be a read-and-rewrite rather than a set of
 * increments threaded through three services. A partial unique index is not
 * needed on (receipt, invoice): the same receipt may legitimately be applied to
 * one invoice twice (a correction), and the outstanding check bounds the total
 * either way.
 */
const receiptAllocationSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    receipt_id: { type: Schema.Types.ObjectId, ref: "Receipt", required: true, index: true },
    invoice_id: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    /** Denormalised for the per-party aging and statement reads, which would
     *  otherwise have to join back through the invoice for every row. */
    party_id: { type: Schema.Types.ObjectId, ref: "Party", required: true, index: true },
    amount_bdt: moneyField(),
  },
  { timestamps: true, versionKey: false },
);

receiptAllocationSchema.index({ org_id: 1, invoice_id: 1 });

/* ── Credit notes ────────────────────────────────────────────────────────── */

/**
 * A claim given back — a return, a price correction, a bad debt written off
 * against one invoice. It always names the invoice it corrects: a free-floating
 * credit is a customer advance, which is what an unallocated receipt already is.
 *
 * `reason` is required and there is no way to leave it blank, for the same
 * reason a void demands one: the person who finds the number in a report a year
 * from now cannot reconstruct why it is there from the amounts alone.
 */
const creditNoteSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    doc_no: { type: String, required: true, trim: true, maxlength: 32 },
    doc_year: { type: Number, required: true },
    doc_seq: { type: Number, required: true, min: 1 },

    invoice_id: { type: Schema.Types.ObjectId, ref: "Invoice", required: true, index: true },
    party_id: { type: Schema.Types.ObjectId, ref: "Party", required: true },

    date: { type: String, required: true, match: DATE_PATTERN },
    reason: { type: String, required: true, trim: true, minlength: 3, maxlength: 300 },

    status: { type: String, enum: ["ISSUED", "VOID"], default: "ISSUED", index: true },

    subtotal_bdt: moneyField(),
    tax_total_bdt: moneyField(),
    total_bdt: moneyField(),

    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    void_reason: { type: String, trim: true, maxlength: 300, default: "" },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

creditNoteSchema.index({ org_id: 1, doc_no: 1 }, { unique: true });
creditNoteSchema.index({ org_id: 1, invoice_id: 1, status: 1 });

export type InvoiceDocument = InferSchemaType<typeof invoiceSchema>;
export type InvoiceLineDocument = InferSchemaType<typeof invoiceLineSchema>;
export type ReceiptDocument = InferSchemaType<typeof receiptSchema>;
export type ReceiptAllocationDocument = InferSchemaType<typeof receiptAllocationSchema>;
export type CreditNoteDocument = InferSchemaType<typeof creditNoteSchema>;

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled
 *  model instead of throwing OverwriteModelError on re-registration. */
export const InvoiceModel =
  (mongoose.models["Invoice"] as Model<InvoiceDocument> | undefined) ??
  mongoose.model<InvoiceDocument>("Invoice", invoiceSchema);

export const InvoiceLineModel =
  (mongoose.models["InvoiceLine"] as Model<InvoiceLineDocument> | undefined) ??
  mongoose.model<InvoiceLineDocument>("InvoiceLine", invoiceLineSchema);

export const ReceiptModel =
  (mongoose.models["Receipt"] as Model<ReceiptDocument> | undefined) ??
  mongoose.model<ReceiptDocument>("Receipt", receiptSchema);

export const ReceiptAllocationModel =
  (mongoose.models["ReceiptAllocation"] as Model<ReceiptAllocationDocument> | undefined) ??
  mongoose.model<ReceiptAllocationDocument>("ReceiptAllocation", receiptAllocationSchema);

export const CreditNoteModel =
  (mongoose.models["CreditNote"] as Model<CreditNoteDocument> | undefined) ??
  mongoose.model<CreditNoteDocument>("CreditNote", creditNoteSchema);
