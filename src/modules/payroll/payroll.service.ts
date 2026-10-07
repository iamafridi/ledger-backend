/**
 * The payroll engine — plan §6, Phase 11.
 *
 * A payroll run is a document family like every other in this codebase: one
 * transaction per act, one journal entry per act, numbers claimed at issue and
 * never at draft, and caches recomputed from rows rather than incremented.
 *
 * THE POSTINGS, STATED ONCE
 *   run      DR 5100 Salaries Expense (Σ gross)
 *              CR 2300 Salaries Payable (Σ net)
 *              CR 1600 Staff Loans (Σ loan principal + Σ advance recovery)
 *              CR 4100 Other Income (Σ loan interest)
 *              CR 2200 Source Tax Payable (Σ withheld tax)
 *   pay run  DR 2300 (Σ net) / CR cash or bank (Σ net)   — nothing when net is 0
 *   loan     DR 1600 (principal) / CR cash or bank (principal)
 *   cash repayment  DR cash or bank (total) / CR 1600 (principal part)
 *                              / CR 4100 (interest part)
 * A payroll deduction that settles a loan installment therefore moves no cash:
 * it pays the employee's salary with a slice of what they already owe back,
 * exactly as an advance claim on an invoice posts nothing (ADR 0004 §5).
 *
 * THE SCHEDULE IS THE REPAYMENT RECORD
 * Every loan — including a zero-interest advance — carries installment rows,
 * and every repayment marks them; the loan's caches are then recomputed from
 * the rows. Interest-first splitting per row (`interest_paid = min(paid,
 * interest)`) means recognised interest can never exceed the contract, and a
 * reversed payroll run releases its installments by rewriting rows, so the
 * schedule and the sub-ledger cannot drift apart.
 */
import type { ClientSession } from "mongoose";
import { z } from "zod";

import {
  LoanInstallmentModel,
  PayrollRunModel,
  PayslipModel,
  StaffLoanModel,
  StaffModel,
  type PayrollRunDocument,
  type PayslipDocument,
  type StaffDocument,
  type StaffLoanDocument,
} from "./payroll.model.js";
import { ensureChartOfAccounts } from "../coa/coa.service.js";
import { JournalEntryModel } from "../journals/journal.model.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { inTransaction, postJournal, voidEntry } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, toPaisa, ZERO, type Money } from "../../core/money.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";
import { MONTH_PATTERN } from "../../shared/db/money-field.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

const MonthInput = z
  .string()
  .trim()
  .regex(MONTH_PATTERN, "Use a period like 2026-09.");

export const StaffInputSchema = z.object({
  code: z.string().trim().min(1).max(24),
  name: z.string().trim().min(1).max(120),
  designation: z.string().trim().max(80).default(""),
  joining_date: DateInput,
  branch: z.string().trim().max(80).default(""),
  monthly_salary_bdt: MoneyInput,
  status: z.enum(["ACTIVE", "INACTIVE"]).default("ACTIVE"),
});

export const UpdateStaffSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  designation: z.string().trim().max(80).optional(),
  branch: z.string().trim().max(80).optional(),
  monthly_salary_bdt: MoneyInput.optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
});

export const ListStaffQuery = z.object({
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

/** One withholding on one payslip. A LOAN row names the loan and takes its
 *  next unpaid installment whole (so the principal/interest split is the
 *  contract's own); ADVANCE and TAX rows carry an explicit amount. */
export const DeductionInput = z.object({
  type: z.enum(["LOAN", "ADVANCE", "TAX"]),
  loan_id: ObjectIdInput.optional(),
  amount_bdt: MoneyInput.optional(),
  reason: z.string().trim().max(200).default(""),
});

export const RunPaymentInput = z.object({
  staff_id: ObjectIdInput,
  allowances_bdt: MoneyInput.default("0.00"),
  deductions: z.array(DeductionInput).max(20).default([]),
});

export const CreateRunSchema = z.object({
  period_key: MonthInput,
  /** Blank posts on the last day of the period. */
  date: z.union([DateInput, z.literal("")]).default(""),
  expense_account_code: z.string().trim().max(24).default(""),
  payments: z.array(RunPaymentInput).max(500).default([]),
});

export const PreviewRunSchema = CreateRunSchema;

export const PayRunSchema = z.object({
  date: z.union([DateInput, z.literal("")]).default(""),
  method: z.enum(["CASH", "BANK"]).default("CASH"),
  account_code: z.string().trim().max(24).default(""),
});

export const ReverseRunSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason for reversing this run.").max(300),
});

export const LoanInputSchema = z.object({
  staff_id: ObjectIdInput,
  kind: z.enum(["LOAN", "ADVANCE"]).default("LOAN"),
  principal_bdt: MoneyInput,
  disbursed_on: DateInput,
  account_code: z.string().trim().max(24).default(""),
  /** Flat annual rate. An advance is always 0.00 and carries no schedule. */
  interest_rate_percent: MoneyInput.default("0.00"),
  term_months: z.coerce.number().int().min(1).max(600).default(12),
  notes: z.string().trim().max(500).default(""),
});

export const CollectSchema = z.object({
  date: DateInput,
  amount_bdt: MoneyInput,
  account_code: z.string().trim().max(24).default(""),
});

export const SettleSchema = z.object({
  date: DateInput,
  account_code: z.string().trim().max(24).default(""),
});

export const ListLoanQuery = z.object({
  staff_id: ObjectIdInput.optional(),
  status: z.enum(["ACTIVE", "CLOSED"]).optional(),
  kind: z.enum(["LOAN", "ADVANCE"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const ListRunQuery = z.object({
  period_key: MonthInput.optional(),
  status: z.enum(["POSTED", "REVERSED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

export const ListPayslipQuery = z.object({
  run_id: ObjectIdInput.optional(),
  staff_id: ObjectIdInput.optional(),
  period_key: MonthInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

export type StaffInput = z.output<typeof StaffInputSchema>;
export type CreateRunInput = z.output<typeof CreateRunSchema>;
export type PayRunInput = z.output<typeof PayRunSchema>;
export type LoanInput = z.output<typeof LoanInputSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface StaffView {
  id: string;
  code: string;
  name: string;
  designation: string;
  joining_date: string;
  branch: string;
  monthly_salary_bdt: string;
  status: "ACTIVE" | "INACTIVE";
}

export interface PayslipDeductionView {
  type: "LOAN" | "ADVANCE" | "TAX";
  loan_id: string | null;
  amount_bdt: string;
  principal_bdt: string;
  interest_bdt: string;
  reason: string;
}

export interface PayslipView {
  id: string;
  run_id: string;
  staff_id: string;
  staff_code: string;
  staff_name: string;
  period_key: string;
  doc_no: string | null;
  basic_bdt: string;
  allowances_bdt: string;
  gross_bdt: string;
  deductions: PayslipDeductionView[];
  deductions_bdt: string;
  loan_principal_bdt: string;
  advance_bdt: string;
  loan_interest_bdt: string;
  tax_bdt: string;
  net_bdt: string;
  status: "POSTED" | "PAID" | "REVERSED";
}

export interface PayrollRunView {
  id: string;
  period_key: string;
  date: string;
  status: "POSTED" | "REVERSED";
  expense_account_code: string;
  staff_count: number;
  gross_bdt: string;
  deductions_bdt: string;
  net_bdt: string;
  loan_principal_bdt: string;
  advance_bdt: string;
  loan_interest_bdt: string;
  tax_bdt: string;
  journal_entry_id: string | null;
  paid_on: string | null;
  payment_account_code: string;
  payment_journal_entry_id: string | null;
  reversed_reason: string;
}

export interface RunDetail extends PayrollRunView {
  payslips: PayslipView[];
}

export interface LoanInstallmentView {
  id: string;
  seq: number;
  due_date: string;
  amount_bdt: string;
  principal_bdt: string;
  interest_bdt: string;
  paid_bdt: string;
  status: "DUE" | "PAID";
  paid_on: string;
  run_id: string | null;
  payslip_id: string | null;
}

export interface StaffLoanView {
  id: string;
  staff_id: string;
  staff_code: string;
  staff_name: string;
  doc_no: string | null;
  kind: "LOAN" | "ADVANCE";
  principal_bdt: string;
  disbursed_on: string;
  account_code: string;
  interest_rate_percent: string;
  term_months: number;
  total_interest_bdt: string;
  installment_bdt: string;
  status: "ACTIVE" | "CLOSED";
  outstanding_bdt: string;
  outstanding_principal_bdt: string;
  repaid_bdt: string;
  journal_entry_id: string | null;
  notes: string;
  schedule?: LoanInstallmentView[];
}

export interface LedgerRow {
  date: string;
  kind: "SALARY" | "LOAN" | "ADVANCE" | "REPAYMENT";
  ref: string;
  memo: string;
  amount_bdt: string;
  /** OUT = money the organisation handed over; IN = money came back. */
  direction: "IN" | "OUT";
  /** False while the payslip's run is unpaid. */
  settled: boolean;
}

export interface StaffLedgerResult {
  staff: StaffView;
  rows: LedgerRow[];
  totals: {
    gross_bdt: string;
    deductions_bdt: string;
    net_bdt: string;
    net_paid_bdt: string;
    /** What the organisation still owes this person: net of unpaid runs. */
    net_payable_bdt: string;
    advances_outstanding_bdt: string;
    loans_outstanding_bdt: string;
    recovered_bdt: string;
  };
}

/* ── Small helpers ───────────────────────────────────────────────────────── */

/** "2026-09" → "2026-09-30". Payroll posts on the period's last day unless the
 *  form names another date — the accrual belongs to the month, not to today. */
function lastDayOf(periodKey: string): string {
  const [year, month] = periodKey.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${periodKey}-${String(last).padStart(2, "0")}`;
}

/** Monthly due dates from the disbursement day, clamped to shorter months
 *  (31 Jan + 1 month is 28/29 Feb, never "invalid date"). */
function addMonths(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  const clamped = Math.min(day, last);
  const mm = String(target.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(clamped).padStart(2, "0");
  return `${target.getUTCFullYear()}-${mm}-${dd}`;
}

interface AccountRef {
  code: string;
  name: string;
}

/**
 * Resolve a posting account by code, checking its **type** — the same rule
 * `parties.service.ts` validates control accounts with, because a payroll run
 * that named a revenue account as salaries expense would balance and still be
 * wrong. A code the chart does not have triggers the idempotent template seed
 * (orgs created before P11 lack 1600), then resolves again.
 */
async function requireAccountByType(
  orgId: string,
  uid: string,
  code: string,
  type: "ASSET" | "LIABILITY" | "EXPENSE" | "REVENUE",
): Promise<AccountRef> {
  const find = async (): Promise<ReturnType<typeof findOneAccount>> =>
    findOneAccount(orgId, code);

  let account = await find();
  if (!account) {
    // The template only seeds at signup, so an organisation created before P11
    // has no 1600. Re-seeding is idempotent by (org, code): it fills the gap
    // and touches nothing that exists.
    await ensureChartOfAccounts(orgId, uid);
    account = await find();
  }
  if (!account) {
    throw new AppError(422, "ACCOUNT_NOT_FOUND", `No account with code ${code} exists in this ledger.`);
  }
  if (account.is_active === false) {
    throw new AppError(422, "ACCOUNT_INACTIVE", `Account ${code} (${account.name}) is inactive.`);
  }
  if (account.type !== type) {
    throw new AppError(
      422,
      "ACCOUNT_WRONG_TYPE",
      `${account.code} (${account.name}) is a ${account.type.toLowerCase()} account, and payroll needs a ${type.toLowerCase()} one.`,
    );
  }
  return { code: account.code, name: account.name };
}

async function findOneAccount(
  orgId: string,
  code: string,
): Promise<{ code: string; name: string; type: string; is_active: boolean } | null> {
  return CoaAccountModel.findOne({ org_id: orgId, code }).lean();
}

function shapeStaff(doc: StaffDocument): StaffView {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    designation: doc.designation ?? "",
    joining_date: doc.joining_date,
    branch: doc.branch ?? "",
    monthly_salary_bdt: doc.monthly_salary_bdt,
    status: doc.status,
  };
}

function shapePayslip(doc: PayslipDocument): PayslipView {
  return {
    id: String(doc._id),
    run_id: String(doc.run_id),
    staff_id: String(doc.staff_id),
    staff_code: doc.staff_code ?? "",
    staff_name: doc.staff_name ?? "",
    period_key: doc.period_key,
    doc_no: doc.doc_no || null,
    basic_bdt: doc.basic_bdt,
    allowances_bdt: doc.allowances_bdt,
    gross_bdt: doc.gross_bdt,
    deductions: (doc.deductions ?? []).map((row) => ({
      type: row.type,
      loan_id: row.loan_id ? String(row.loan_id) : null,
      amount_bdt: row.amount_bdt,
      principal_bdt: row.principal_bdt,
      interest_bdt: row.interest_bdt,
      reason: row.reason ?? "",
    })),
    deductions_bdt: doc.deductions_bdt,
    loan_principal_bdt: doc.loan_principal_bdt,
    advance_bdt: doc.advance_bdt,
    loan_interest_bdt: doc.loan_interest_bdt,
    tax_bdt: doc.tax_bdt,
    net_bdt: doc.net_bdt,
    status: doc.status,
  };
}

function shapeRun(doc: PayrollRunDocument): PayrollRunView {
  return {
    id: String(doc._id),
    period_key: doc.period_key,
    date: doc.date,
    status: doc.status,
    expense_account_code: doc.expense_account_code,
    staff_count: doc.staff_count,
    gross_bdt: doc.gross_bdt,
    deductions_bdt: doc.deductions_bdt,
    net_bdt: doc.net_bdt,
    loan_principal_bdt: doc.loan_principal_bdt,
    advance_bdt: doc.advance_bdt,
    loan_interest_bdt: doc.loan_interest_bdt,
    tax_bdt: doc.tax_bdt,
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    paid_on: doc.paid_on ?? null,
    payment_account_code: doc.payment_account_code ?? "",
    payment_journal_entry_id: doc.payment_journal_entry_id
      ? String(doc.payment_journal_entry_id)
      : null,
    reversed_reason: doc.reversed_reason ?? "",
  };
}

function shapeLoan(
  doc: StaffLoanDocument,
  labels?: { code: string; name: string },
  schedule?: LoanInstallmentView[],
): StaffLoanView {
  return {
    id: String(doc._id),
    staff_id: String(doc.staff_id),
    staff_code: labels?.code ?? "",
    staff_name: labels?.name ?? "",
    doc_no: doc.doc_no || null,
    kind: doc.kind,
    principal_bdt: doc.principal_bdt,
    disbursed_on: doc.disbursed_on,
    account_code: doc.account_code,
    interest_rate_percent: doc.interest_rate_percent,
    term_months: doc.term_months ?? 0,
    total_interest_bdt: doc.total_interest_bdt,
    installment_bdt: doc.installment_bdt,
    status: doc.status,
    outstanding_bdt: doc.outstanding_bdt,
    outstanding_principal_bdt: doc.outstanding_principal_bdt,
    repaid_bdt: doc.repaid_bdt,
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    notes: doc.notes ?? "",
    ...(schedule ? { schedule } : {}),
  };
}

/* ── The run plan — computed once, used by preview and post alike ───────── */

export interface PlannedDeduction {
  type: "LOAN" | "ADVANCE" | "TAX";
  loan_id: string | null;
  amount: Money;
  principal: Money;
  interest: Money;
  reason: string;
  /** The installment row a LOAN deduction settles, when there is one. */
  installment_id: string | null;
  /** That row's own amount — a payroll deduction takes its remainder whole, so
   *  the stored `paid_bdt` becomes exactly this. */
  installment_amount: Money;
  /** Where the money lands: a LOAN row in full, an ADVANCE recovery in FIFO
   *  chunks across the staff member's open advance rows. Written in the run's
   *  transaction — a deduction that marked nothing would leave 1600 and the
   *  sub-ledger disagreeing (found by the P11 smoke). */
  installment_picks: InstallmentPick[];
}

export interface InstallmentPick {
  installment_id: string;
  loan_id: string;
  take: Money;
  paid_before: Money;
  row_amount: Money;
}

export interface PlannedStaff {
  staff: StaffDocument;
  allowances: Money;
  gross: Money;
  deductions: PlannedDeduction[];
  deductionsTotal: Money;
  loanPrincipal: Money;
  advanceRecovered: Money;
  loanInterest: Money;
  tax: Money;
  net: Money;
}

export interface RunPlan {
  date: string;
  expense: AccountRef;
  rows: PlannedStaff[];
  totals: {
    staff_count: number;
    gross: Money;
    deductions: Money;
    net: Money;
    loan_principal: Money;
    advance: Money;
    loan_interest: Money;
    tax: Money;
  };
}

/**
 * Compute who is paid what for a period, with no writes — the preview screen
 * and the posting run the *same* function, so the figure a user confirms is
 * the figure that posts, to the paisa (the P9 rule).
 */
export async function computeRunPlan(
  orgId: string,
  uid: string,
  input: CreateRunInput,
  session?: ClientSession,
): Promise<RunPlan> {
  const date = input.date || lastDayOf(input.period_key);
  const expense = await requireAccountByType(
    orgId,
    uid,
    input.expense_account_code || CONTROL_ACCOUNT.SALARY_EXPENSE,
    "EXPENSE",
  );

  const staff = await StaffModel.find({ org_id: orgId, status: "ACTIVE" })
    .sort({ code: 1 })
    .session(session ?? null)
    .lean();
  if (staff.length === 0) {
    throw new AppError(
      422,
      "PAYROLL_NO_STAFF",
      "There are no active staff to pay. Add a staff member on /staff first.",
    );
  }
  const staffById = new Map(staff.map((row) => [String(row._id), row]));

  const requested = new Map<string, z.output<typeof RunPaymentInput>>();
  for (const payment of input.payments) {
    const key = String(payment.staff_id);
    if (requested.has(key)) {
      throw new AppError(
        422,
        "PAYROLL_DUPLICATE_STAFF",
        "The same staff member appears twice in this run's payments.",
      );
    }
    if (!staffById.has(key)) {
      throw new AppError(
        422,
        "STAFF_NOT_IN_RUN",
        "A payment names a staff member who is not on the active payroll.",
      );
    }
    requested.set(key, payment);
  }

  // The loans every LOAN deduction points at, loaded once.
  const loanIds = [
    ...new Set(
      [...requested.values()].flatMap((payment) =>
        payment.deductions
          .filter((row) => row.type === "LOAN")
          .map((row) => String(row.loan_id)),
      ),
    ),
  ];
  const loans = loanIds.length
    ? await StaffLoanModel.find({ org_id: orgId, _id: { $in: loanIds } })
        .session(session ?? null)
        .lean()
    : [];
  const loanById = new Map(loans.map((row) => [String(row._id), row]));

  // The unpaid advance rows per staff member, oldest money first — the FIFO
  // queue an ADVANCE recovery drains, in chunks.
  const openAdvanceLoans = await StaffLoanModel.find({ org_id: orgId, kind: "ADVANCE", status: "ACTIVE" })
    .sort({ disbursed_on: 1, _id: 1 })
    .session(session ?? null)
    .lean();
  const advanceLoanIds = openAdvanceLoans.map((row) => String(row._id));
  interface AdvanceQueueEntry {
    loan_id: string;
    installment_id: string;
    rowAmount: Money;
    paidBefore: Money;
    left: Money;
  }
  const advanceRows = advanceLoanIds.length
    ? await LoanInstallmentModel.find({
        org_id: orgId,
        loan_id: { $in: advanceLoanIds },
        status: "DUE",
      })
        .sort({ loan_id: 1, seq: 1 })
        .session(session ?? null)
        .lean()
    : [];
  const advanceQueue = new Map<string, AdvanceQueueEntry[]>();
  for (const loan of openAdvanceLoans) {
    for (const row of advanceRows) {
      if (String(row.loan_id) !== String(loan._id)) continue;
      const left = money(row.amount_bdt ?? "0.00").minus(money(row.paid_bdt ?? "0.00"));
      if (!left.greaterThan(ZERO)) continue;
      const key = String(loan.staff_id);
      const queue = advanceQueue.get(key) ?? [];
      queue.push({
        loan_id: String(loan._id),
        installment_id: String(row._id),
        rowAmount: money(row.amount_bdt ?? "0.00"),
        paidBefore: money(row.paid_bdt ?? "0.00"),
        left,
      });
      advanceQueue.set(key, queue);
    }
  }

  // Installments for those loans, oldest unpaid first — the queue a LOAN
  // deduction drains.
  interface InstallmentRow {
    _id: unknown;
    loan_id: unknown;
    seq: number;
    amount_bdt?: string;
    paid_bdt?: string;
    principal_bdt?: string;
    interest_bdt?: string;
  }
  const installments: InstallmentRow[] = loanIds.length
    ? await LoanInstallmentModel.find({ org_id: orgId, loan_id: { $in: loanIds } })
        .sort({ loan_id: 1, seq: 1 })
        .session(session ?? null)
        .lean()
    : [];
  const nextUnpaid = new Map<string, InstallmentRow>();
  for (const row of installments) {
    const remaining = money(row.amount_bdt ?? "0.00").minus(money(row.paid_bdt ?? "0.00"));
    if (!remaining.greaterThan(ZERO)) continue;
    const key = String(row.loan_id);
    if (!nextUnpaid.has(key)) nextUnpaid.set(key, row);
  }

  const rows: PlannedStaff[] = [];
  for (const member of staff) {
    const extra = requested.get(String(member._id));
    const allowances = money(extra?.allowances_bdt ?? "0.00");
    if (allowances.isNegative()) {
      throw new AppError(422, "ALLOWANCE_NEGATIVE", `An allowance cannot be negative (${member.name}).`);
    }
    const basic = money(member.monthly_salary_bdt);
    const gross = basic.plus(allowances);

    const deductions: PlannedDeduction[] = [];
    let loanPrincipal = ZERO;
    let advanceRecovered = ZERO;
    let loanInterest = ZERO;
    let tax = ZERO;
    let dedTotal = ZERO;

    for (const row of extra?.deductions ?? []) {
      if (row.type === "LOAN") {
        const loan = row.loan_id ? loanById.get(String(row.loan_id)) : undefined;
        if (!loan) {
          throw new AppError(422, "LOAN_NOT_FOUND", "A deduction names a loan that does not exist.");
        }
        if (String(loan.staff_id) !== String(member._id)) {
          throw new AppError(
            422,
            "LOAN_STAFF_MISMATCH",
            `That loan belongs to a different staff member — it cannot be deducted from ${member.name}'s salary.`,
          );
        }
        if (loan.kind !== "LOAN" || loan.status !== "ACTIVE") {
          throw new AppError(
            422,
            "LOAN_NOT_BORROWABLE",
            `Loan ${loan.doc_no ?? String(loan._id)} is not an active loan, so nothing more can be deducted against it.`,
          );
        }
        const next = nextUnpaid.get(String(loan._id));
        if (!next) {
          throw new AppError(
            422,
            "LOAN_ALREADY_SETTLED",
            `Loan ${loan.doc_no ?? String(loan._id)} has no unpaid installment left.`,
          );
        }
        const remaining = money(next.amount_bdt ?? "0.00").minus(money(next.paid_bdt ?? "0.00"));
        // Interest-first within the row: recognised interest can never exceed
        // what the contract row promises, which is what keeps the schedule
        // honest under partial cash repayments too.
        const paidSoFar = money(next.paid_bdt ?? "0.00");
        const contractInterest = money(next.interest_bdt ?? "0.00");
        const contractPrincipal = money(next.principal_bdt ?? "0.00");
        const interestPaid = paidSoFar.greaterThan(contractInterest) ? contractInterest : paidSoFar;
        const principalPaid = paidSoFar.minus(interestPaid);
        const principalRemaining = contractPrincipal.minus(principalPaid);
        const interestRemaining = remaining.minus(principalRemaining);
        deductions.push({
          type: "LOAN",
          loan_id: String(loan._id),
          amount: remaining,
          principal: principalRemaining,
          interest: interestRemaining,
          reason: row.reason,
          installment_id: String(next._id),
          installment_amount: money(next.amount_bdt ?? "0.00"),
          installment_picks: [
            {
              installment_id: String(next._id),
              loan_id: String(loan._id),
              take: remaining,
              paid_before: paidSoFar,
              row_amount: money(next.amount_bdt ?? "0.00"),
            },
          ],
        });
        loanPrincipal = loanPrincipal.plus(principalRemaining);
        loanInterest = loanInterest.plus(interestRemaining);
        dedTotal = dedTotal.plus(remaining);
        nextUnpaid.delete(String(loan._id)); // the next deduction takes the next row
      } else if (row.type === "ADVANCE") {
        const amount = money(row.amount_bdt ?? "0.00");
        if (!amount.greaterThan(ZERO)) {
          throw new AppError(
            422,
            "DEDUCTION_AMOUNT_REQUIRED",
            `An advance recovery for ${member.name} needs an amount greater than zero.`,
          );
        }
        const queue = advanceQueue.get(String(member._id)) ?? [];
        const left = queue.reduce((acc, entry) => acc.plus(entry.left), ZERO);
        if (amount.greaterThan(left)) {
          throw new AppError(
            422,
            "ADVANCE_RECOVERY_EXCEEDS",
            `The advance recovery of ${fmt(amount)} is more than ${member.name}'s uncollected advances (${fmt(left)}).`,
          );
        }
        let need = amount;
        const picks: InstallmentPick[] = [];
        for (const entry of queue) {
          if (!need.greaterThan(ZERO)) break;
          if (!entry.left.greaterThan(ZERO)) continue;
          const take = need.greaterThan(entry.left) ? entry.left : need;
          picks.push({
            installment_id: entry.installment_id,
            loan_id: entry.loan_id,
            take,
            paid_before: entry.paidBefore,
            row_amount: entry.rowAmount,
          });
          entry.left = entry.left.minus(take);
          need = need.minus(take);
        }
        deductions.push({
          type: "ADVANCE",
          loan_id: picks[0]?.loan_id ?? null,
          amount,
          principal: amount,
          interest: ZERO,
          reason: row.reason,
          installment_id: picks[0]?.installment_id ?? null,
          installment_amount: ZERO,
          installment_picks: picks,
        });
        advanceRecovered = advanceRecovered.plus(amount);
        dedTotal = dedTotal.plus(amount);
      } else {
        const amount = money(row.amount_bdt ?? "0.00");
        if (!amount.greaterThan(ZERO)) {
          throw new AppError(
            422,
            "DEDUCTION_AMOUNT_REQUIRED",
            `A tax deduction for ${member.name} needs an amount greater than zero.`,
          );
        }
        deductions.push({
          type: "TAX",
          loan_id: null,
          amount,
          principal: ZERO,
          interest: ZERO,
          reason: row.reason,
          installment_id: null,
          installment_amount: ZERO,
          installment_picks: [],
        });
        tax = tax.plus(amount);
        dedTotal = dedTotal.plus(amount);
      }
    }

    if (dedTotal.greaterThan(gross)) {
      throw new AppError(
        422,
        "PAYROLL_DEDUCTION_EXCEEDS_GROSS",
        `Deductions of ${fmt(dedTotal)} exceed ${member.name}'s gross of ${fmt(gross)}. A salary cannot be withheld past zero.`,
      );
    }

    rows.push({
      staff: member,
      allowances,
      gross,
      deductions,
      deductionsTotal: dedTotal,
      loanPrincipal,
      advanceRecovered,
      loanInterest,
      tax,
      net: gross.minus(dedTotal),
    });
  }

  const totals = rows.reduce(
    (acc, row) => ({
      staff_count: acc.staff_count + 1,
      gross: acc.gross.plus(row.gross),
      deductions: acc.deductions.plus(row.deductionsTotal),
      net: acc.net.plus(row.net),
      loan_principal: acc.loan_principal.plus(row.loanPrincipal),
      advance: acc.advance.plus(row.advanceRecovered),
      loan_interest: acc.loan_interest.plus(row.loanInterest),
      tax: acc.tax.plus(row.tax),
    }),
    {
      staff_count: 0,
      gross: ZERO,
      deductions: ZERO,
      net: ZERO,
      loan_principal: ZERO,
      advance: ZERO,
      loan_interest: ZERO,
      tax: ZERO,
    },
  );

  if (!totals.gross.greaterThan(ZERO)) {
    throw new AppError(
      422,
      "PAYROLL_ZERO_GROSS",
      "This run pays nothing — every salary is zero and there are no allowances. Give somebody a salary before posting payroll.",
    );
  }

  return { date, expense, rows, totals };
}

/* ── Runs ──────────────────────────────────────────────────────────────── */

export async function runDetail(
  orgId: string,
  id: string,
  session?: ClientSession,
): Promise<RunDetail> {
  assertObjectId(id, "That payroll run does not exist.");
  const run = await PayrollRunModel.findOne({ _id: id, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!run) throw notFoundError("That payroll run does not exist.");
  const payslips = await PayslipModel.find({ org_id: orgId, run_id: id })
    .sort({ staff_code: 1 })
    .session(session ?? null)
    .lean();
  return { ...shapeRun(run), payslips: payslips.map(shapePayslip) };
}

/**
 * Recompute a loan's caches from its installment rows — after every write,
 * never by incrementing (the P9 lesson). Interest is recognised interest-first
 * per row, so `outstanding_principal` is exactly what 1600 still holds.
 */
export async function deriveLoanCaches(
  orgId: string,
  loanId: string,
  session?: ClientSession,
): Promise<void> {
  const rows = await LoanInstallmentModel.find({ org_id: orgId, loan_id: loanId })
    .session(session ?? null)
    .lean();
  let repaid = ZERO;
  let principalRecovered = ZERO;
  for (const row of rows) {
    const paid = money(row.paid_bdt);
    const interest = money(row.interest_bdt);
    const interestPaid = paid.greaterThan(interest) ? interest : paid;
    repaid = repaid.plus(paid);
    principalRecovered = principalRecovered.plus(paid.minus(interestPaid));
  }

  const loan = await StaffLoanModel.findOne({ _id: loanId, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!loan) return;

  const total = money(loan.principal_bdt).plus(money(loan.total_interest_bdt));
  const outstanding = total.minus(repaid);
  const outstandingPrincipal = money(loan.principal_bdt).minus(principalRecovered);
  await StaffLoanModel.updateOne(
    { _id: loanId, org_id: orgId },
    {
      $set: {
        repaid_bdt: fmt(repaid),
        // Clamped at zero: the guards refuse an overpayment, so a negative
        // here would be corruption, and a negative cannot be a moneyField
        // anyway — failing the validator is the louder outcome.
        outstanding_bdt: fmt(outstanding.greaterThan(ZERO) ? outstanding : ZERO),
        outstanding_principal_bdt: fmt(
          outstandingPrincipal.greaterThan(ZERO) ? outstandingPrincipal : ZERO,
        ),
        status: outstanding.greaterThan(ZERO) ? "ACTIVE" : "CLOSED",
      },
    },
    { session, runValidators: true },
  );
}

/**
 * Post a payroll run: one transaction, one accrual entry, numbered payslips,
 * and the loan installments it settles marked in the same commit. The plan is
 * computed by the same function the preview screen runs, so what was confirmed
 * is what posts.
 */
export async function createRun(
  orgId: string,
  uid: string,
  input: CreateRunInput,
  ip?: string,
): Promise<RunDetail> {
  return inTransaction(async (session) => {
    const live = await PayrollRunModel.findOne({
      org_id: orgId,
      period_key: input.period_key,
      status: "POSTED",
    })
      .session(session)
      .lean();
    if (live) {
      throw new AppError(
        409,
        "PAYROLL_PERIOD_EXISTS",
        `${input.period_key} already has a payroll run. Reverse it first if it needs correcting.`,
      );
    }

    const plan = await computeRunPlan(orgId, uid, input, session);

    const run = await PayrollRunModel.create(
      [
        {
          org_id: orgId,
          period_key: input.period_key,
          date: plan.date,
          status: "POSTED",
          expense_account_code: plan.expense.code,
          staff_count: plan.totals.staff_count,
          gross_bdt: fmt(plan.totals.gross),
          deductions_bdt: fmt(plan.totals.deductions),
          net_bdt: fmt(plan.totals.net),
          loan_principal_bdt: fmt(plan.totals.loan_principal),
          advance_bdt: fmt(plan.totals.advance),
          loan_interest_bdt: fmt(plan.totals.loan_interest),
          tax_bdt: fmt(plan.totals.tax),
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    // Payslips, numbered at issue inside the run's own transaction (ADR 0002).
    const slipRows = [];
    for (const row of plan.rows) {
      const allocation = await allocateNumber(orgId, "payslip", plan.date);
      slipRows.push({
        org_id: orgId,
        run_id: run._id,
        staff_id: row.staff._id,
        period_key: input.period_key,
        doc_no: allocation.number,
        doc_year: allocation.year,
        doc_seq: allocation.seq,
        staff_code: row.staff.code,
        staff_name: row.staff.name,
        basic_bdt: fmt(money(row.staff.monthly_salary_bdt)),
        allowances_bdt: fmt(row.allowances),
        gross_bdt: fmt(row.gross),
        deductions: row.deductions.map((deduction) => ({
          type: deduction.type,
          loan_id: deduction.loan_id,
          amount_bdt: fmt(deduction.amount),
          principal_bdt: fmt(deduction.principal),
          interest_bdt: fmt(deduction.interest),
          reason: deduction.reason,
        })),
        deductions_bdt: fmt(row.deductionsTotal),
        loan_principal_bdt: fmt(row.loanPrincipal),
        advance_bdt: fmt(row.advanceRecovered),
        loan_interest_bdt: fmt(row.loanInterest),
        tax_bdt: fmt(row.tax),
        net_bdt: fmt(row.net),
        status: "POSTED",
        created_by: uid,
      });
    }
    const slips = await PayslipModel.insertMany(slipRows, { session });
    const slipIdByStaff = new Map(slips.map((row) => [String(row.staff_id), String(row._id)]));

    // The installments this run settles, marked in the same commit — a LOAN
    // row's remainder whole (paid becomes the row's own amount and the row
    // closes), an ADVANCE recovery in the chunks the plan resolved. Both write
    // rows; neither writes nothing, which is what keeps 1600 and the sub-ledger
    // agreeing (the P11 smoke's catch).
    const loansToDerive = new Set<string>();
    for (const row of plan.rows) {
      for (const deduction of row.deductions) {
        for (const pick of deduction.installment_picks) {
          const newPaid = pick.paid_before.plus(pick.take);
          await LoanInstallmentModel.updateOne(
            { _id: pick.installment_id, org_id: orgId },
            {
              $set: {
                paid_bdt: fmt(newPaid),
                // The snapshot a reversal restores: what this row held before
                // this run touched it, so an earlier run's share survives.
                paid_before_run_bdt: fmt(pick.paid_before),
                status: newPaid.greaterThanOrEqualTo(pick.row_amount) ? "PAID" : "DUE",
                paid_on: plan.date,
                run_id: run._id,
                payslip_id: slipIdByStaff.get(String(row.staff._id)) ?? null,
              },
              // This run's take, recorded on the row itself. `run_id` and the
              // snapshot are overwritten by the next run that claims the
              // remainder, so they cannot answer "what did THIS run take?"
              // when it is time to reverse it — this can, and it is what keeps
              // the release arithmetic exact.
              $push: {
                claims: {
                  run_id: run._id,
                  payslip_id: slipIdByStaff.get(String(row.staff._id)) ?? null,
                  take_bdt: fmt(pick.take),
                },
              },
            },
            { session, runValidators: true },
          );
          loansToDerive.add(pick.loan_id);
        }
      }
    }
    for (const loanId of loansToDerive) await deriveLoanCaches(orgId, loanId, session);

    // One accrual entry for the batch, exactly as the run screen previewed it.
    const description = `Payroll ${input.period_key}`;
    const recovered = plan.totals.loan_principal.plus(plan.totals.advance);
    const lines = [
      { account_code: plan.expense.code, debit_bdt: fmt(plan.totals.gross), memo: description },
      ...(plan.totals.net.greaterThan(ZERO)
        ? [
            {
              account_code: CONTROL_ACCOUNT.PAYROLL_PAYABLE,
              credit_bdt: fmt(plan.totals.net),
              memo: description,
            },
          ]
        : []),
      ...(recovered.greaterThan(ZERO)
        ? [{ account_code: CONTROL_ACCOUNT.STAFF_LOAN, credit_bdt: fmt(recovered), memo: description }]
        : []),
      ...(plan.totals.loan_interest.greaterThan(ZERO)
        ? [
            {
              account_code: CONTROL_ACCOUNT.OTHER_INCOME,
              credit_bdt: fmt(plan.totals.loan_interest),
              memo: description,
            },
          ]
        : []),
      ...(plan.totals.tax.greaterThan(ZERO)
        ? [{ account_code: CONTROL_ACCOUNT.WITHHOLDING, credit_bdt: fmt(plan.totals.tax), memo: description }]
        : []),
    ];
    const entry = await postJournal(
      {
        orgId,
        uid,
        date: plan.date,
        description,
        source: "PAYROLL",
        source_id: String(run._id),
        lines,
        ...(ip ? { ip } : {}),
      },
      session,
    );
    await PayrollRunModel.updateOne(
      { _id: run._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session, runValidators: true },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "payroll.run",
        entityId: String(run._id),
        action: "PAYROLL_RUN_POSTED",
        after: {
          period_key: input.period_key,
          gross_bdt: fmt(plan.totals.gross),
          net_bdt: fmt(plan.totals.net),
          staff_count: plan.totals.staff_count,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    // Re-read inside the transaction for the response (the P10 lesson): a
    // spread of a mongoose document loses every schema field, and a sessionless
    // read cannot see the uncommitted run.
    return runDetail(orgId, String(run._id), session);
  });
}

/** Pay a posted run: `DR 2300 / CR cash`. A zero-net run moves nothing and
 *  posts nothing — marking it paid is still the truth. */
export async function payRun(
  orgId: string,
  uid: string,
  id: string,
  input: PayRunInput,
  ip?: string,
): Promise<RunDetail> {
  assertObjectId(id, "That payroll run does not exist.");
  return inTransaction(async (session) => {
    const run = await PayrollRunModel.findOne({ _id: id, org_id: orgId }).session(session).lean();
    if (!run) throw notFoundError("That payroll run does not exist.");
    if (run.status !== "POSTED") {
      throw new AppError(409, "RUN_REVERSED", "That payroll run was reversed, so there is nothing to pay.");
    }
    if (run.paid_on) {
      throw new AppError(409, "RUN_ALREADY_PAID", `That payroll run was already paid on ${run.paid_on}.`);
    }

    const net = money(run.net_bdt);
    const date = input.date || run.date;
    const account = await requireAccountByType(
      orgId,
      uid,
      input.account_code ||
        (input.method === "BANK" ? CONTROL_ACCOUNT.BANK : CONTROL_ACCOUNT.CASH),
      "ASSET",
    );

    let paymentEntryId: string | null = null;
    if (net.greaterThan(ZERO)) {
      const description = `Payroll payment ${run.period_key}`;
      const entry = await postJournal(
        {
          orgId,
          uid,
          date,
          description,
          source: "PAYROLL_PAYMENT",
          source_id: String(run._id),
          lines: [
            {
              account_code: CONTROL_ACCOUNT.PAYROLL_PAYABLE,
              debit_bdt: fmt(net),
              memo: description,
            },
            { account_code: account.code, credit_bdt: fmt(net), memo: description },
          ],
          ...(ip ? { ip } : {}),
        },
        session,
      );
      paymentEntryId = entry.id;
    }

    const updated = await PayrollRunModel.findOneAndUpdate(
      { _id: id, org_id: orgId, paid_on: null },
      {
        $set: {
          paid_on: date,
          payment_account_code: account.code,
          payment_journal_entry_id: paymentEntryId,
        },
      },
      { new: true, session, runValidators: true },
    ).lean();
    if (!updated) {
      throw new AppError(409, "RUN_ALREADY_PAID", "That payroll run was paid by another request a moment ago.");
    }
    await PayslipModel.updateMany(
      { org_id: orgId, run_id: id },
      { $set: { status: "PAID" } },
      { session },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "payroll.run",
        entityId: String(run._id),
        action: "PAYROLL_RUN_PAID",
        after: { paid_on: date, payment_account_code: account.code, net_bdt: run.net_bdt },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return runDetail(orgId, id, session);
  });
}

/**
 * Reverse a run: release the installments it claimed, void its accrual entry,
 * flip the run and its payslips to REVERSED, and — if the run was paid — void
 * its payment entry in the same transaction first. Reversing the accrual under
 * money that has already left would leave the cash where it is and the salary
 * unpaid, so both entries fall together or neither does.
 */
export async function reverseRun(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<RunDetail> {
  assertObjectId(id, "That payroll run does not exist.");
  return inTransaction(async (session) => {
    const run = await PayrollRunModel.findOne({ _id: id, org_id: orgId }).session(session).lean();
    if (!run) throw notFoundError("That payroll run does not exist.");
    if (run.status !== "POSTED") {
      throw new AppError(409, "RUN_REVERSED", "That payroll run has already been reversed.");
    }
    // A paid run is reversed by reversing both of its entries in one commit:
    // the payment goes first, so no moment exists where the salary is unpaid
    // but the cash is still gone. The payment is voided here rather than
    // instructed — "void the payment first" was advice the product could not
    // act on, and a refusal nobody can act on is just a dead end (the P11
    // screens found this). A payment already voided from the journals screen
    // has nothing left to undo, and a zero-net run never had one.
    if (run.paid_on && run.payment_journal_entry_id) {
      const payment = await JournalEntryModel.findOne({
        _id: run.payment_journal_entry_id,
        org_id: orgId,
      })
        .session(session)
        .lean();
      if (payment && payment.status === "POSTED" && !payment.reversed_by_entry_id) {
        await voidEntry(
          orgId,
          uid,
          String(run.payment_journal_entry_id),
          `Payroll run ${run.period_key} reversed — ${reason}`,
          ip,
          session,
        );
      }
    }

    // Release exactly what this run claimed, row by row, by SUBTRACTING ITS
    // OWN TAKE — never zeroing the row, and never restoring a snapshot that
    // belongs to somebody else. An earlier run's share of a partially-claimed
    // row survives because it is still owed; and a row a *later* run has since
    // claimed (the next run always takes the remainder of the same row) now
    // holds both takes at once, with `run_id` and the snapshot pointing at the
    // later one. Restoring that snapshot would put this run's take back on the
    // row while its accrual is voided, and 1600 would come out different from
    // the sub-ledger by exactly this run's take — the P11 screens caught that
    // tie-out breaking. So each release is arithmetic on the row: paid minus
    // the take this run recorded when it claimed it, and whoever is left holds
    // the row.
    const claimed = await LoanInstallmentModel.find({
      org_id: orgId,
      $or: [{ run_id: id }, { "claims.run_id": id }],
    })
      .session(session)
      .lean();
    for (const row of claimed) {
      const paid = money(row.paid_bdt ?? "0.00");
      const amount = money(row.amount_bdt ?? "0.00");
      const claims = row.claims ?? [];
      const mine = claims.filter((claim) => String(claim.run_id) === id);
      const remainingClaims = claims.filter((claim) => String(claim.run_id) !== id);
      // A row claimed before `claims` existed has no take recorded: the
      // snapshot is exact for a row this run still holds, which is the only
      // shape that row could be in.
      const take = mine.length
        ? mine.reduce((sum, claim) => sum.plus(money(claim.take_bdt ?? "0.00")), ZERO)
        : paid.minus(money(row.paid_before_run_bdt ?? "0.00"));
      const restored = paid.minus(take);
      const holder = remainingClaims[remainingClaims.length - 1] ?? null;
      const holderTake = holder ? money(holder.take_bdt ?? "0.00") : ZERO;
      await LoanInstallmentModel.updateOne(
        { _id: row._id, org_id: orgId },
        {
          $set: {
            paid_bdt: fmt(restored),
            status: restored.greaterThanOrEqualTo(amount) ? "PAID" : "DUE",
            paid_on: "",
            run_id: holder ? holder.run_id : null,
            payslip_id: holder ? (holder.payslip_id ?? null) : null,
            // The snapshot re-repaired for whoever holds it now: what the row
            // held before *that* claim, not before this run's.
            paid_before_run_bdt: fmt(restored.minus(holderTake)),
          },
          ...(mine.length ? { $pull: { claims: { run_id: id } } } : {}),
        },
        { session, runValidators: true },
      );
    }
    for (const loanId of [...new Set(claimed.map((row) => String(row.loan_id)))]) {
      await deriveLoanCaches(orgId, loanId, session);
    }

    if (run.journal_entry_id) {
      await voidEntry(orgId, uid, String(run.journal_entry_id), reason, ip, session);
    }
    await PayslipModel.updateMany(
      { org_id: orgId, run_id: id },
      { $set: { status: "REVERSED" } },
      { session },
    );
    await PayrollRunModel.findOneAndUpdate(
      { _id: id, org_id: orgId },
      // Paid-ness is cleared with the status: the payment entry is void (or
      // was), so nothing has been paid, and the period can be run again.
      { $set: { status: "REVERSED", reversed_reason: reason, paid_on: null } },
      { session, runValidators: true },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "payroll.run",
        entityId: String(run._id),
        action: "PAYROLL_RUN_REVERSED",
        before: { status: "POSTED", net_bdt: run.net_bdt },
        after: { status: "REVERSED", reason },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return runDetail(orgId, id, session);
  });
}

/* ── Loans & advances ───────────────────────────────────────────────────── */

function shapeInstallment(row: {
  _id?: unknown;
  seq: number;
  due_date: string;
  amount_bdt?: string;
  principal_bdt?: string;
  interest_bdt?: string;
  paid_bdt?: string;
  status: string;
  paid_on?: string;
  run_id?: unknown;
  payslip_id?: unknown;
}): LoanInstallmentView {
  return {
    id: String(row._id),
    seq: row.seq,
    due_date: row.due_date,
    amount_bdt: row.amount_bdt ?? "0.00",
    principal_bdt: row.principal_bdt ?? "0.00",
    interest_bdt: row.interest_bdt ?? "0.00",
    paid_bdt: row.paid_bdt ?? "0.00",
    status: row.status as "DUE" | "PAID",
    paid_on: row.paid_on ?? "",
    run_id: row.run_id ? String(row.run_id) : null,
    payslip_id: row.payslip_id ? String(row.payslip_id) : null,
  };
}

/**
 * Disburse a loan or a salary advance. The schedule is generated once, here,
 * and every later repayment marks those rows — an advance gets a single
 * zero-interest row so it shares exactly one repayment path with a loan.
 */
export async function createLoan(
  orgId: string,
  uid: string,
  input: LoanInput,
  ip?: string,
): Promise<StaffLoanView> {
  const staff = await StaffModel.findOne({ _id: input.staff_id, org_id: orgId }).lean();
  if (!staff) {
    throw new AppError(422, "STAFF_NOT_FOUND", "That staff member does not exist in this ledger.");
  }
  if (staff.status !== "ACTIVE") {
    throw new AppError(422, "STAFF_INACTIVE", `${staff.name} is inactive, so no loan can be recorded for them.`);
  }
  const principal = money(input.principal_bdt);
  if (!principal.greaterThan(ZERO)) {
    throw new AppError(422, "LOAN_AMOUNT_INVALID", "A loan or advance needs an amount greater than zero.");
  }
  const kind = input.kind;
  const rate = money(input.interest_rate_percent);
  if (rate.isNegative()) {
    throw new AppError(422, "LOAN_RATE_INVALID", "An interest rate cannot be negative.");
  }
  if (kind === "ADVANCE" && rate.greaterThan(ZERO)) {
    throw new AppError(422, "ADVANCE_NO_INTEREST", "A salary advance carries no interest — record a loan if interest applies.");
  }
  const term = kind === "LOAN" ? input.term_months : 0;
  // Flat interest: principal × annual rate × months / 12, rounded once.
  const totalInterest =
    kind === "LOAN" ? toPaisa(principal.times(rate).times(term).dividedBy(1200)) : ZERO;
  const account = await requireAccountByType(
    orgId,
    uid,
    input.account_code || CONTROL_ACCOUNT.CASH,
    "ASSET",
  );

  return inTransaction(async (session) => {
    const allocation = await allocateNumber(orgId, "loan", input.disbursed_on);
    const installmentBase =
      term > 0 ? toPaisa(principal.plus(totalInterest).dividedBy(term)) : ZERO;

    const loan = await StaffLoanModel.create(
      [
        {
          org_id: orgId,
          staff_id: staff._id,
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          kind,
          principal_bdt: fmt(principal),
          disbursed_on: input.disbursed_on,
          account_code: account.code,
          interest_rate_percent: fmt(rate),
          term_months: term,
          total_interest_bdt: fmt(totalInterest),
          installment_bdt: fmt(installmentBase),
          status: "ACTIVE",
          outstanding_bdt: fmt(principal.plus(totalInterest)),
          outstanding_principal_bdt: fmt(principal),
          repaid_bdt: "0.00",
          journal_entry_id: null,
          notes: input.notes,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    const scheduleRows = [];
    if (kind === "ADVANCE") {
      scheduleRows.push({
        org_id: orgId,
        loan_id: loan._id,
        staff_id: staff._id,
        seq: 1,
        due_date: input.disbursed_on,
        amount_bdt: fmt(principal),
        principal_bdt: fmt(principal),
        interest_bdt: "0.00",
        paid_bdt: "0.00",
        paid_before_run_bdt: "0.00",
        status: "DUE",
      });
    } else {
      // Flat interest, telescoped: cumulative interest at month k is
      // toPaisa(total × k / term), so the row differences sum to exactly the
      // contract — never a paisa more, whatever the rounding does in between.
      let previousCumulative = ZERO;
      for (let seq = 1; seq <= term; seq += 1) {
        const cumulativeInterest = toPaisa(totalInterest.times(seq).dividedBy(term));
        const interest = cumulativeInterest.minus(previousCumulative);
        previousCumulative = cumulativeInterest;
        const amount =
          seq < term
            ? installmentBase
            : principal.plus(totalInterest).minus(installmentBase.times(term - 1));
        scheduleRows.push({
          org_id: orgId,
          loan_id: loan._id,
          staff_id: staff._id,
          seq,
          due_date: addMonths(input.disbursed_on, seq),
          amount_bdt: fmt(amount),
          principal_bdt: fmt(amount.minus(interest)),
          interest_bdt: fmt(interest),
          paid_bdt: "0.00",
          paid_before_run_bdt: "0.00",
          status: "DUE",
        });
      }
    }
    await LoanInstallmentModel.insertMany(scheduleRows, { session });

    const description = `${kind === "ADVANCE" ? "Salary advance" : "Staff loan"} ${allocation.number} — ${staff.name}`;
    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.disbursed_on,
        description,
        source: "STAFF_LOAN",
        source_id: String(loan._id),
        lines: [
          { account_code: CONTROL_ACCOUNT.STAFF_LOAN, debit_bdt: fmt(principal), memo: description },
          { account_code: account.code, credit_bdt: fmt(principal), memo: description },
        ],
        ...(ip ? { ip } : {}),
      },
      session,
    );
    await StaffLoanModel.updateOne(
      { _id: loan._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session, runValidators: true },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "staff.loan",
        entityId: String(loan._id),
        action: "STAFF_LOAN_CREATED",
        after: {
          staff_id: String(staff._id),
          kind,
          principal_bdt: fmt(principal),
          total_interest_bdt: fmt(totalInterest),
          doc_no: allocation.number,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    // Re-read inside the transaction for the response (the P10 lesson): a
    // spread of a mongoose document loses every schema field.
    const saved = await StaffLoanModel.findOne({ _id: loan._id, org_id: orgId })
      .session(session)
      .lean();
    return shapeLoan(
      saved!,
      { code: staff.code, name: staff.name },
      (await LoanInstallmentModel.find({ org_id: orgId, loan_id: loan._id })
        .sort({ seq: 1 })
        .session(session)
        .lean())
        .map(shapeInstallment),
    );
  });
}

/**
 * Apply a cash repayment to a loan's unpaid installments, oldest first, and
 * post `DR cash / CR 1600 principal / CR 4100 interest`. Shared by the partial
 * collection and the settlement so the split logic exists once.
 */
async function applyCashRepayment(
  orgId: string,
  uid: string,
  loan: { _id: unknown; doc_no: string | null; kind: string },
  amount: Money,
  date: string,
  account: AccountRef,
  session: ClientSession,
  ip?: string,
): Promise<void> {
  // Only rows no payroll run currently claims: a claimed row's balance is the
  // run's business, and reaching into it would corrupt what that run's
  // reversal restores.
  const rows = (await LoanInstallmentModel.find({ org_id: orgId, loan_id: loan._id, status: "DUE" })
    .sort({ seq: 1 })
    .session(session)
    .lean())
    .filter((row) => !row.run_id);

  let left = amount;
  let principalPart = ZERO;
  let interestPart = ZERO;
  const touched: string[] = [];
  for (const row of rows) {
    if (!left.greaterThan(ZERO)) break;
    const rowRemaining = money(row.amount_bdt).minus(money(row.paid_bdt));
    if (!rowRemaining.greaterThan(ZERO)) continue;
    const chunk = left.greaterThan(rowRemaining) ? rowRemaining : left;

    const paidBefore = money(row.paid_bdt);
    const contractInterest = money(row.interest_bdt);
    const interestPaidBefore = paidBefore.greaterThan(contractInterest) ? contractInterest : paidBefore;
    const principalPaidBefore = paidBefore.minus(interestPaidBefore);
    const paidAfter = paidBefore.plus(chunk);
    const interestPaidAfter = paidAfter.greaterThan(contractInterest) ? contractInterest : paidAfter;
    const principalPaidAfter = paidAfter.minus(interestPaidAfter);
    interestPart = interestPart.plus(interestPaidAfter.minus(interestPaidBefore));
    principalPart = principalPart.plus(principalPaidAfter.minus(principalPaidBefore));

    await LoanInstallmentModel.updateOne(
      { _id: row._id, org_id: orgId },
      {
        $set: {
          paid_bdt: fmt(paidAfter),
          status: paidAfter.greaterThanOrEqualTo(money(row.amount_bdt)) ? "PAID" : "DUE",
          paid_on: date,
        },
      },
      { session, runValidators: true },
    );
    touched.push(String(row._id));
    left = left.minus(chunk);
  }

  const description = `Loan repayment ${loan.doc_no ?? String(loan._id)}`;
  const entry = await postJournal(
    {
      orgId,
      uid,
      date,
      description,
      source: "STAFF_LOAN",
      source_id: String(loan._id),
      lines: [
        { account_code: account.code, debit_bdt: fmt(amount), memo: description },
        ...(principalPart.greaterThan(ZERO)
          ? [{ account_code: CONTROL_ACCOUNT.STAFF_LOAN, credit_bdt: fmt(principalPart), memo: description }]
          : []),
        ...(interestPart.greaterThan(ZERO)
          ? [{ account_code: CONTROL_ACCOUNT.OTHER_INCOME, credit_bdt: fmt(interestPart), memo: description }]
          : []),
      ],
      ...(ip ? { ip } : {}),
    },
    session,
  );
  if (touched.length > 0) {
    await LoanInstallmentModel.updateMany(
      { _id: { $in: touched }, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { session },
    );
  }

  await deriveLoanCaches(orgId, String(loan._id), session);
}

async function collectGuard(
  orgId: string,
  uid: string,
  id: string,
  session: ClientSession,
): Promise<{ loan: NonNullable<Awaited<ReturnType<typeof findOneLoan>>>; remaining: Money }> {
  const loan = await findOneLoan(orgId, id, session);
  if (!loan) throw notFoundError("That loan does not exist.");
  if (loan.status !== "ACTIVE") {
    throw new AppError(
      409,
      "LOAN_CLOSED",
      `Loan ${loan.doc_no ?? String(loan._id)} is already settled — there is nothing left to collect.`,
    );
  }
  const rows = await LoanInstallmentModel.find({ org_id: orgId, loan_id: id, status: "DUE" })
    .sort({ seq: 1 })
    .session(session)
    .lean();
  // What can be collected in cash is what no payroll run is recovering: the
  // rest is coming out of salary and belongs to that run's reversal.
  const remaining = rows
    .filter((row) => !row.run_id)
    .reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00").minus(money(row.paid_bdt ?? "0.00"))), ZERO);
  return { loan, remaining };
}

async function findOneLoan(
  orgId: string,
  id: string,
  session?: ClientSession,
): Promise<StaffLoanDocument | null> {
  return StaffLoanModel.findOne({ _id: id, org_id: orgId }).session(session ?? null).lean();
}

/** Collect part of a loan in cash: FIFO across unpaid installments. */
export async function collectLoan(
  orgId: string,
  uid: string,
  id: string,
  input: { date: string; amount_bdt: string; account_code: string },
  ip?: string,
): Promise<{ loan: StaffLoanView; collected_bdt: string }> {
  assertObjectId(id, "That loan does not exist.");
  return inTransaction(async (session) => {
    const { loan, remaining } = await collectGuard(orgId, uid, id, session);
    const amount = money(input.amount_bdt);
    if (!amount.greaterThan(ZERO)) {
      throw new AppError(422, "COLLECT_AMOUNT_INVALID", "A repayment needs an amount greater than zero.");
    }
    if (amount.greaterThan(remaining)) {
      throw new AppError(
        422,
        "LOAN_OVERPAID",
        `The repayment of ${fmt(amount)} is more than the ${fmt(remaining)} collectible in cash on ${loan.doc_no ?? "this loan"} — the rest is being recovered through payroll.`,
      );
    }
    const account = await requireAccountByType(
      orgId,
      uid,
      input.account_code || CONTROL_ACCOUNT.CASH,
      "ASSET",
    );
    await applyCashRepayment(orgId, uid, loan, amount, input.date, account, session, ip);

    await writeAudit(
      {
        orgId,
        uid,
        entity: "staff.loan",
        entityId: String(loan._id),
        action: "STAFF_LOAN_COLLECTED",
        after: { amount_bdt: fmt(amount), date: input.date, account_code: account.code },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    const after = await findOneLoan(orgId, id, session);
    return { loan: shapeLoan(after!), collected_bdt: fmt(amount) };
  });
}

/** Settle what is left of a loan in one cash payment. */
export async function settleLoan(
  orgId: string,
  uid: string,
  id: string,
  input: { date: string; account_code: string },
  ip?: string,
): Promise<{ loan: StaffLoanView; settled_bdt: string }> {
  assertObjectId(id, "That loan does not exist.");
  return inTransaction(async (session) => {
    const { loan, remaining } = await collectGuard(orgId, uid, id, session);
    if (!remaining.greaterThan(ZERO)) {
      throw new AppError(409, "LOAN_CLOSED", `Loan ${loan.doc_no ?? String(loan._id)} is already settled.`);
    }
    const account = await requireAccountByType(
      orgId,
      uid,
      input.account_code || CONTROL_ACCOUNT.CASH,
      "ASSET",
    );
    await applyCashRepayment(orgId, uid, loan, remaining, input.date, account, session, ip);

    await writeAudit(
      {
        orgId,
        uid,
        entity: "staff.loan",
        entityId: String(loan._id),
        action: "STAFF_LOAN_SETTLED",
        after: { amount_bdt: fmt(remaining), date: input.date },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    const after = await findOneLoan(orgId, id, session);
    return { loan: shapeLoan(after!), settled_bdt: fmt(remaining) };
  });
}

/* ── Staff ──────────────────────────────────────────────────────────────── */

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

export async function listStaff(
  orgId: string,
  query: z.output<typeof ListStaffQuery>,
): Promise<StaffView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.status) filter["status"] = query.status;
  const rows = await StaffModel.find(filter).sort({ code: 1 }).limit(query.limit).lean();
  return rows.map(shapeStaff);
}

export async function createStaff(
  orgId: string,
  uid: string,
  input: StaffInput,
): Promise<StaffView> {
  const salary = money(input.monthly_salary_bdt);
  if (salary.isNegative()) {
    throw new AppError(422, "STAFF_SALARY_INVALID", "A monthly salary cannot be negative.");
  }
  try {
    const created = await StaffModel.create(
      [
        {
          org_id: orgId,
          code: input.code,
          name: input.name,
          designation: input.designation,
          joining_date: input.joining_date,
          branch: input.branch,
          monthly_salary_bdt: fmt(salary),
          status: input.status,
          created_by: uid,
        },
      ],
    );
    return shapeStaff(created[0]!);
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(
        409,
        "STAFF_CODE_EXISTS",
        `Staff code ${input.code} is already in use. Codes are identity — pick another.`,
      );
    }
    throw error;
  }
}

export async function updateStaff(
  orgId: string,
  uid: string,
  id: string,
  input: z.output<typeof UpdateStaffSchema>,
): Promise<StaffView> {
  assertObjectId(id, "That staff member does not exist.");
  const before = await StaffModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!before) throw notFoundError("That staff member does not exist.");

  const set: Record<string, unknown> = {};
  if (input.name !== undefined) set["name"] = input.name;
  if (input.designation !== undefined) set["designation"] = input.designation;
  if (input.branch !== undefined) set["branch"] = input.branch;
  if (input.monthly_salary_bdt !== undefined) {
    const salary = money(input.monthly_salary_bdt);
    if (salary.isNegative()) {
      throw new AppError(422, "STAFF_SALARY_INVALID", "A monthly salary cannot be negative.");
    }
    set["monthly_salary_bdt"] = fmt(salary);
  }
  if (input.status !== undefined) set["status"] = input.status;

  const updated = await StaffModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: set },
    { new: true, runValidators: true },
  ).lean();

  await writeAudit({
    orgId,
    uid,
    entity: "staff",
    entityId: id,
    action: "STAFF_UPDATED",
    before: { name: before.name, monthly_salary_bdt: before.monthly_salary_bdt, status: before.status },
    after: { name: updated?.name, monthly_salary_bdt: updated?.monthly_salary_bdt, status: updated?.status },
  });

  return shapeStaff(updated!);
}

export async function getStaff(orgId: string, id: string): Promise<StaffView> {
  assertObjectId(id, "That staff member does not exist.");
  const doc = await StaffModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That staff member does not exist.");
  return shapeStaff(doc);
}

/**
 * The staff ledger: every salary, advance, loan and repayment for one person,
 * with the totals the exit gate ties to the books — `net_payable_bdt` is what
 * the organisation still owes them (net of unpaid runs), and the outstanding
 * figures are what they still owe back.
 */
export async function staffLedger(orgId: string, id: string): Promise<StaffLedgerResult> {
  assertObjectId(id, "That staff member does not exist.");
  const staff = await StaffModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!staff) throw notFoundError("That staff member does not exist.");

  const [slips, runs, loans, installments] = await Promise.all([
    PayslipModel.find({ org_id: orgId, staff_id: id, status: { $ne: "REVERSED" } })
      .sort({ period_key: 1, _id: 1 })
      .lean(),
    PayrollRunModel.find({ org_id: orgId }).select({ _id: 1, date: 1, paid_on: 1 }).lean(),
    StaffLoanModel.find({ org_id: orgId, staff_id: id }).sort({ disbursed_on: 1, _id: 1 }).lean(),
    LoanInstallmentModel.find({ org_id: orgId, staff_id: id }).sort({ due_date: 1, seq: 1 }).lean(),
  ]);
  const runById = new Map(runs.map((row) => [String(row._id), row]));

  const rows: LedgerRow[] = [];
  let gross = ZERO;
  let deductions = ZERO;
  let net = ZERO;
  let netPaid = ZERO;
  let netPayable = ZERO;
  for (const slip of slips) {
    const run = runById.get(String(slip.run_id));
    const settled = Boolean(run?.paid_on);
    rows.push({
      date: run?.date ?? `${slip.period_key}-01`,
      kind: "SALARY",
      ref: slip.doc_no ?? "",
      memo: `${fmt(money(slip.basic_bdt))} salary${
        money(slip.allowances_bdt).greaterThan(ZERO) ? ` + ${fmt(money(slip.allowances_bdt))} allowances` : ""
      }${
        money(slip.deductions_bdt).greaterThan(ZERO)
          ? ` − ${fmt(money(slip.deductions_bdt))} deductions`
          : ""
      }`,
      amount_bdt: slip.net_bdt,
      direction: "OUT",
      settled,
    });
    gross = gross.plus(money(slip.gross_bdt));
    deductions = deductions.plus(money(slip.deductions_bdt));
    net = net.plus(money(slip.net_bdt));
    if (settled) netPaid = netPaid.plus(money(slip.net_bdt));
    else netPayable = netPayable.plus(money(slip.net_bdt));
  }

  let advancesOutstanding = ZERO;
  let loansOutstanding = ZERO;
  for (const loan of loans) {
    rows.push({
      date: loan.disbursed_on,
      kind: loan.kind,
      ref: loan.doc_no ?? "",
      memo:
        loan.kind === "ADVANCE"
          ? `Advance of ${fmt(money(loan.principal_bdt))} from the till`
          : `Loan of ${fmt(money(loan.principal_bdt))} at ${loan.interest_rate_percent}% over ${loan.term_months} months`,
      amount_bdt: loan.principal_bdt,
      direction: "OUT",
      settled: true,
    });
    if (loan.kind === "ADVANCE") {
      advancesOutstanding = advancesOutstanding.plus(money(loan.outstanding_bdt));
    } else {
      loansOutstanding = loansOutstanding.plus(money(loan.outstanding_bdt));
    }
  }

  let recovered = ZERO;
  for (const row of installments) {
    const paid = money(row.paid_bdt);
    if (!paid.greaterThan(ZERO)) continue;
    const viaRun = row.run_id ? runById.get(String(row.run_id)) : undefined;
    const viaPayslip = row.payslip_id
      ? slips.find((slip) => String(slip._id) === String(row.payslip_id))
      : undefined;
    rows.push({
      date: row.paid_on || row.due_date,
      kind: "REPAYMENT",
      ref: viaPayslip?.doc_no ?? "Cash",
      memo: viaRun
        ? `Recovered from salary (${viaPayslip?.doc_no ?? "payslip"})`
        : "Collected in cash",
      amount_bdt: fmt(paid),
      direction: "IN",
      settled: true,
    });
    recovered = recovered.plus(paid);
  }

  rows.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));

  return {
    staff: shapeStaff(staff),
    rows,
    totals: {
      gross_bdt: fmt(gross),
      deductions_bdt: fmt(deductions),
      net_bdt: fmt(net),
      net_paid_bdt: fmt(netPaid),
      net_payable_bdt: fmt(netPayable),
      advances_outstanding_bdt: fmt(advancesOutstanding),
      loans_outstanding_bdt: fmt(loansOutstanding),
      recovered_bdt: fmt(recovered),
    },
  };
}

/* ── Loan & run & payslip reads ──────────────────────────────────────── */

export async function listLoans(
  orgId: string,
  query: z.output<typeof ListLoanQuery>,
): Promise<StaffLoanView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.staff_id) filter["staff_id"] = query.staff_id;
  if (query.status) filter["status"] = query.status;
  if (query.kind) filter["kind"] = query.kind;
  const rows = await StaffLoanModel.find(filter)
    .sort({ disbursed_on: -1, _id: -1 })
    .limit(query.limit)
    .lean();
  const staffIds = [...new Set(rows.map((row) => String(row.staff_id)))];
  const staffRows = staffIds.length
    ? await StaffModel.find({ org_id: orgId, _id: { $in: staffIds } })
        .select({ code: 1, name: 1 })
        .lean()
    : [];
  const labels = new Map(
    staffRows.map((row) => [String(row._id), { code: row.code, name: row.name }]),
  );
  return rows.map((row) => shapeLoan(row, labels.get(String(row.staff_id))));
}

export async function getLoan(orgId: string, id: string): Promise<StaffLoanView> {
  assertObjectId(id, "That loan does not exist.");
  const loan = await StaffLoanModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!loan) throw notFoundError("That loan does not exist.");
  const staff = await StaffModel.findOne({ _id: loan.staff_id, org_id: orgId })
    .select({ code: 1, name: 1 })
    .lean();
  const schedule = await LoanInstallmentModel.find({ org_id: orgId, loan_id: id })
    .sort({ seq: 1 })
    .lean();
  return shapeLoan(
    loan,
    staff ? { code: staff.code, name: staff.name } : undefined,
    schedule.map(shapeInstallment),
  );
}

export async function listRuns(
  orgId: string,
  query: z.output<typeof ListRunQuery>,
): Promise<PayrollRunView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.period_key) filter["period_key"] = query.period_key;
  if (query.status) filter["status"] = query.status;
  const rows = await PayrollRunModel.find(filter)
    .sort({ period_key: -1, _id: -1 })
    .limit(query.limit)
    .lean();
  return rows.map(shapeRun);
}

export async function listPayslips(
  orgId: string,
  query: z.output<typeof ListPayslipQuery>,
): Promise<PayslipView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.run_id) filter["run_id"] = query.run_id;
  if (query.staff_id) filter["staff_id"] = query.staff_id;
  if (query.period_key) filter["period_key"] = query.period_key;
  const rows = await PayslipModel.find(filter)
    .sort({ period_key: -1, staff_code: 1 })
    .limit(query.limit)
    .lean();
  return rows.map(shapePayslip);
}

export async function getPayslip(orgId: string, id: string): Promise<PayslipView> {
  assertObjectId(id, "That payslip does not exist.");
  const doc = await PayslipModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That payslip does not exist.");
  return shapePayslip(doc);
}

export interface PreviewRow {
  staff_id: string;
  staff_code: string;
  staff_name: string;
  basic_bdt: string;
  allowances_bdt: string;
  gross_bdt: string;
  deductions: {
    type: "LOAN" | "ADVANCE" | "TAX";
    loan_id: string | null;
    amount_bdt: string;
    principal_bdt: string;
    interest_bdt: string;
    reason: string;
  }[];
  deductions_bdt: string;
  net_bdt: string;
}

/** The run wizard's preview — the same computation the post will run, so the
 *  figure confirmed on screen is the figure that posts. */
export async function previewRun(
  orgId: string,
  uid: string,
  input: CreateRunInput,
): Promise<{
  period_key: string;
  date: string;
  expense_account_code: string;
  rows: PreviewRow[];
  totals: { staff_count: number; gross_bdt: string; deductions_bdt: string; net_bdt: string };
}> {
  const plan = await computeRunPlan(orgId, uid, input);
  return {
    period_key: input.period_key,
    date: plan.date,
    expense_account_code: plan.expense.code,
    rows: plan.rows.map((row) => ({
      staff_id: String(row.staff._id),
      staff_code: row.staff.code,
      staff_name: row.staff.name,
      basic_bdt: fmt(money(row.staff.monthly_salary_bdt)),
      allowances_bdt: fmt(row.allowances),
      gross_bdt: fmt(row.gross),
      deductions: row.deductions.map((deduction) => ({
        type: deduction.type,
        loan_id: deduction.loan_id,
        amount_bdt: fmt(deduction.amount),
        principal_bdt: fmt(deduction.principal),
        interest_bdt: fmt(deduction.interest),
        reason: deduction.reason,
      })),
      deductions_bdt: fmt(row.deductionsTotal),
      net_bdt: fmt(row.net),
    })),
    totals: {
      staff_count: plan.totals.staff_count,
      gross_bdt: fmt(plan.totals.gross),
      deductions_bdt: fmt(plan.totals.deductions),
      net_bdt: fmt(plan.totals.net),
    },
  };
}

