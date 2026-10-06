/**
 * Payroll, staff and staff loans — plan §6, Phase 11.
 *
 * THE ONE IDEA
 * Payroll is a document family like any other: a monthly run is one posting
 * (`DR 5100 Salaries Expense gross / CR 2300 Salaries Payable net / CR 1600
 * recoveries / CR 4100 interest / CR 2200 withheld tax`), paying the run is a
 * second (`DR 2300 / CR cash`), and a payslip is the numbered per-person
 * document behind the first — not a second source of truth. A loan to a member
 * of staff is money the *organisation* is owed (it left the till and comes back
 * out of salary), so it lives on the asset side in 1600; 2500 Loan Payable is
 * what the organisation owes its own lenders — the other direction entirely.
 *
 * SCHEDULED, NOT ESTIMATED
 * A loan carries a stored installment schedule generated once at disbursement
 * (flat interest: total interest = principal × rate × months / 12, rounded once
 * half-up; installments telescope so Σ interest equals the contract exactly and
 * never a paisa more). Every repayment — payroll deduction or cash — marks
 * those rows, and the loan's caches (`repaid_bdt`, `outstanding_bdt`,
 * `outstanding_principal_bdt`, `status`) are **recomputed** from them after
 * every write, the P9 lesson: a cache is a reading of the rows, never a running
 * total a reversal can drift.
 *
 * WHY ONE INSTALLMENT ROW EVEN FOR AN ADVANCE
 * A salary advance has no schedule, but it still owes exactly one repayment
 * record — so disbursement writes a single installment row (seq 1, due that
 * day, zero interest). One repayment path, one derivation, and reversing a
 * payroll run can release what it claimed by rewriting rows rather than by
 * remembering amounts.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField, DATE_PATTERN, MONTH_PATTERN } from "../../shared/db/money-field.js";

/* ── Staff master ────────────────────────────────────────────────────────── */

export const STAFF_STATUSES = ["ACTIVE", "INACTIVE"] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

const staffSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    /** Identity, unique per org — documents point at it, so it never changes. */
    code: { type: String, required: true, trim: true, maxlength: 24 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    designation: { type: String, trim: true, maxlength: 80, default: "" },

    joining_date: { type: String, required: true, match: DATE_PATTERN },
    /** Branch or segment label (plan §6 P11). Free text on purpose: the segment
     *  dimension itself is P12's work, and payroll must not wait for it. */
    branch: { type: String, trim: true, maxlength: 80, default: "" },

    /** The monthly gross a run pays them, unless a run overrides the allowance.
     *  Changes take effect on the next run — a run snapshots what it pays. */
    monthly_salary_bdt: moneyField(),

    status: { type: String, enum: STAFF_STATUSES, default: "ACTIVE", index: true },
    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

staffSchema.index({ org_id: 1, code: 1 }, { unique: true });

/* ── Payroll runs ────────────────────────────────────────────────────────── */

export const PAYROLL_RUN_STATUSES = ["POSTED", "REVERSED"] as const;
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];

const payrollRunSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    period_key: { type: String, required: true, match: MONTH_PATTERN },
    /** Business date the accrual posts on — the last day of the period unless
     *  the run form says otherwise. */
    date: { type: String, required: true, match: DATE_PATTERN },

    /** POSTED → REVERSED. Paid-ness lives in `paid_on`, not in the status: the
     *  partial unique index below keeps one *live* run per period, and a paid
     *  run is still live until it is reversed. */
    status: { type: String, enum: PAYROLL_RUN_STATUSES, default: "POSTED", index: true },

    expense_account_code: { type: String, required: true, trim: true, maxlength: 24 },

    staff_count: { type: Number, required: true, min: 0 },
    gross_bdt: moneyField(),
    deductions_bdt: moneyField(),
    net_bdt: moneyField(),
    /** The four credits inside the accrual, stored so the run screen and the
     *  integrity check read one set of figures. Principal and advance recovery
     *  share the 1600 line; interest goes to 4100 and tax to 2200. */
    loan_principal_bdt: moneyField(),
    advance_bdt: moneyField(),
    loan_interest_bdt: moneyField(),
    tax_bdt: moneyField(),

    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    /** Set when the run is paid; `payment_journal_entry_id` is null only when
     *  the net was zero — nothing moved, so nothing was posted. */
    paid_on: { type: String, default: null },
    payment_account_code: { type: String, default: "", maxlength: 24 },
    payment_journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    reversed_reason: { type: String, trim: true, maxlength: 300, default: "" },
    reversal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

payrollRunSchema.index({ org_id: 1, period_key: 1, status: 1 });
// One live run per period — the idempotency key, partial on POSTED so a
// reversed run frees the period for the corrected one (the P9 pattern).
payrollRunSchema.index(
  { org_id: 1, period_key: 1 },
  { unique: true, partialFilterExpression: { status: "POSTED" } },
);

/* ── Payslips ────────────────────────────────────────────────────────────── */

export const PAYSLIP_STATUSES = ["POSTED", "PAID", "REVERSED"] as const;
export type PayslipStatus = (typeof PAYSLIP_STATUSES)[number];

/** One withholding on one payslip. `principal_bdt`/`interest_bdt` exist only on
 *  a LOAN row and split it exactly; the others carry zeros. */
const payrollDeductionSchema = new Schema(
  {
    type: { type: String, enum: ["LOAN", "ADVANCE", "TAX"], required: true },
    loan_id: { type: Schema.Types.ObjectId, ref: "StaffLoan", default: null },
    amount_bdt: moneyField(),
    principal_bdt: moneyField(),
    interest_bdt: moneyField(),
    reason: { type: String, trim: true, maxlength: 200, default: "" },
  },
  { timestamps: false, versionKey: false },
);

const payslipSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    run_id: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true, index: true },
    staff_id: { type: Schema.Types.ObjectId, ref: "Staff", required: true, index: true },

    period_key: { type: String, required: true, match: MONTH_PATTERN },
    /** Numbered at creation, inside the run's transaction (ADR 0002: numbers
     *  are claimed at issue, never at draft). */
    doc_no: { type: String, trim: true, maxlength: 32, default: "" },
    doc_year: { type: Number, default: null },
    doc_seq: { type: Number, default: null },

    /** Snapshots, so a payslip still reads correctly after a rename. */
    staff_code: { type: String, trim: true, maxlength: 24, default: "" },
    staff_name: { type: String, trim: true, maxlength: 120, default: "" },

    basic_bdt: moneyField(),
    allowances_bdt: moneyField(),
    gross_bdt: moneyField(),
    deductions: { type: [payrollDeductionSchema], default: [] },
    deductions_bdt: moneyField(),
    loan_principal_bdt: moneyField(),
    advance_bdt: moneyField(),
    loan_interest_bdt: moneyField(),
    tax_bdt: moneyField(),
    net_bdt: moneyField(),

    status: { type: String, enum: PAYSLIP_STATUSES, default: "POSTED", index: true },
    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

payslipSchema.index({ org_id: 1, period_key: 1, staff_id: 1 });

/* ── Staff loans & advances ──────────────────────────────────────────────── */

export const STAFF_LOAN_KINDS = ["LOAN", "ADVANCE"] as const;
export type StaffLoanKind = (typeof STAFF_LOAN_KINDS)[number];
export const STAFF_LOAN_STATUSES = ["ACTIVE", "CLOSED"] as const;
export type StaffLoanStatus = (typeof STAFF_LOAN_STATUSES)[number];

const staffLoanSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    staff_id: { type: Schema.Types.ObjectId, ref: "Staff", required: true, index: true },

    doc_no: { type: String, trim: true, maxlength: 32, default: "" },
    doc_year: { type: Number, default: null },
    doc_seq: { type: Number, default: null },

    /** LOAN carries a schedule and interest; ADVANCE is a0%-interest recovery
     *  of money already handed over, recorded on the same instrument because it
     *  is the same posting and the same sub-ledger row. */
    kind: { type: String, enum: STAFF_LOAN_KINDS, default: "LOAN" },

    principal_bdt: moneyField(),
    disbursed_on: { type: String, required: true, match: DATE_PATTERN },
    /** Where the cash came from (1000/1010), snapshotted at disbursement. */
    account_code: { type: String, required: true, trim: true, maxlength: 24 },

    /** Flat annual rate, canonical 2dp. "0.00" on an advance. */
    interest_rate_percent: moneyField(),
    term_months: { type: Number, default: 0, min: 0, max: 600 },
    total_interest_bdt: moneyField(),
    /** The contractual installment — (principal + interest) / months, with the
     *  last row absorbing the rounding. Stored so the schedule is auditable. */
    installment_bdt: moneyField(),

    status: { type: String, enum: STAFF_LOAN_STATUSES, default: "ACTIVE", index: true },
    /** What is still to collect: principal + interest − repaid (UI figure). */
    outstanding_bdt: moneyField(),
    /** What is still owed on the asset side: principal − principal recovered.
     *  This is the figure 1600 holds, and I5 ties the two together. */
    outstanding_principal_bdt: moneyField(),
    repaid_bdt: moneyField(),

    /** The disbursement entry (`DR 1600 / CR cash`). Repayments post their own
     *  entries — a payroll deduction inside the run's entry, cash on its own. */
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    notes: { type: String, trim: true, maxlength: 500, default: "" },
    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

staffLoanSchema.index({ org_id: 1, doc_no: 1 });

/* ── Loan installments (the repayment record) ────────────────────────────── */

const loanInstallmentSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    loan_id: { type: Schema.Types.ObjectId, ref: "StaffLoan", required: true, index: true },
    staff_id: { type: Schema.Types.ObjectId, ref: "Staff", required: true, index: true },

    seq: { type: Number, required: true, min: 1 },
    due_date: { type: String, required: true, match: DATE_PATTERN },
    amount_bdt: moneyField(),
    /** The contract split. `interest_paid` is derived as min(paid, interest),
     *  so recognised interest can never exceed what this row promises. */
    principal_bdt: moneyField(),
    interest_bdt: moneyField(),

    paid_bdt: moneyField(),
    /** What `paid_bdt` was before the latest claim — a payroll run that
     *  reverses restores exactly this, so an earlier run's share of a
     *  partially-claimed row survives (found by the P11 smoke: zeroing the row
     *  erased September's recovery when October reversed). */
    paid_before_run_bdt: moneyField(),
    /** Every payroll run that has withheld part of this row, oldest first —
     *  the record a reversal actually subtracts from. A later run claiming
     *  the remainder overwrites `run_id` and the snapshot above, so the
     *  earlier run's take was unrecoverable: reversing it voided the accrual
     *  while the row kept the money, and 1600 came out 2,000 apart from the
     *  sub-ledger (found by the P11 screens). Each take is stored when the run
     *  claims it, so a release is arithmetic on the row itself. */
    claims: [
      {
        run_id: { type: Schema.Types.ObjectId, ref: "PayrollRun", required: true },
        payslip_id: { type: Schema.Types.ObjectId, ref: "Payslip", default: null },
        take_bdt: moneyField(),
      },
    ],
    status: { type: String, enum: ["DUE", "PAID"], default: "DUE", index: true },
    paid_on: { type: String, default: "" },
    /** Who paid it: the payroll run that withheld it, or null for cash. */
    run_id: { type: Schema.Types.ObjectId, ref: "PayrollRun", default: null },
    payslip_id: { type: Schema.Types.ObjectId, ref: "Payslip", default: null },
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
  },
  { timestamps: true, versionKey: false },
);

loanInstallmentSchema.index({ org_id: 1, loan_id: 1, seq: 1 }, { unique: true });

/** `InferSchemaType` reads `moneyField()`'s inner `required` as optional and
 *  omits `_id`, so every consumer would otherwise repeat `?? "0.00"` on top of
 *  `String(doc._id)` gymnastics. Binding both here keeps the service honest. */
export type StaffDocument = InferSchemaType<typeof staffSchema> & {
  _id: mongoose.Types.ObjectId;
};
export type PayrollRunDocument = InferSchemaType<typeof payrollRunSchema> & {
  _id: mongoose.Types.ObjectId;
};
export type PayslipDocument = InferSchemaType<typeof payslipSchema> & {
  _id: mongoose.Types.ObjectId;
};
export type StaffLoanDocument = InferSchemaType<typeof staffLoanSchema> & {
  _id: mongoose.Types.ObjectId;
};
export type LoanInstallmentDocument = InferSchemaType<typeof loanInstallmentSchema> & {
  _id: mongoose.Types.ObjectId;
};

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled
 *  model instead of throwing OverwriteModelError on re-registration. */
export const StaffModel =
  (mongoose.models["Staff"] as Model<StaffDocument> | undefined) ??
  mongoose.model<StaffDocument>("Staff", staffSchema, "staff");

export const PayrollRunModel =
  (mongoose.models["PayrollRun"] as Model<PayrollRunDocument> | undefined) ??
  mongoose.model<PayrollRunDocument>("PayrollRun", payrollRunSchema);

export const PayslipModel =
  (mongoose.models["Payslip"] as Model<PayslipDocument> | undefined) ??
  mongoose.model<PayslipDocument>("Payslip", payslipSchema);

export const StaffLoanModel =
  (mongoose.models["StaffLoan"] as Model<StaffLoanDocument> | undefined) ??
  mongoose.model<StaffLoanDocument>("StaffLoan", staffLoanSchema);

export const LoanInstallmentModel =
  (mongoose.models["LoanInstallment"] as Model<LoanInstallmentDocument> | undefined) ??
  mongoose.model<LoanInstallmentDocument>("LoanInstallment", loanInstallmentSchema);
