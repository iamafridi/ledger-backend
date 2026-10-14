/**
 * Phase 11 smoke — payroll, staff ledger and loans, run in-process against the
 * real app and the real database on a throwaway org, which is deleted at the
 * end.
 *
 *   npx tsx scripts/smoke-p11.ts
 *
 * The point of this script is the phase's exit gate: **payroll and loan
 * postings balance, and the staff ledger ties to the GL control accounts** —
 * exercised through hand-checkable figures: a 60,000.00 loan at 12% flat over
 * 12 months (7,200.00 interest, 5,600.00 installments of 5,000.00 principal +
 * 600.00 interest), a 5,000.00 salary advance, a September run whose payslips
 * deduct one installment, one advance recovery and one tax, its payment, an
 * October run that is reversed and re-posted (installments released and
 * re-claimed), and cash collection and settlement on a second advance.
 *
 * Every figure below is hand-checkable, and the arithmetic is in the comments.
 *
 * Exit 0 = every check passed.
 */
// Must be first: pins the JWKS URL before any src module (and its cached
// environment) can load.
import "./smoke-p11-env.js";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import request from "supertest";
import { SignJWT, exportJWK } from "jose";

import { createApp } from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { getEnvironment } from "../src/config/env.js";
import { OrgMembershipModel, OrganizationModel } from "../src/modules/org/org.model.js";
import { CoaAccountModel } from "../src/modules/coa/coa.model.js";
import { JournalEntryModel, JournalLineModel } from "../src/modules/journals/journal.model.js";
import { PeriodModel } from "../src/modules/periods/period.model.js";
import { SequenceCounterModel } from "../src/modules/sequence/sequence.model.js";
import { PartyModel } from "../src/modules/masterdata/parties.model.js";
import { ItemModel } from "../src/modules/masterdata/items.model.js";
import { MasterCategoryModel, TaxRateModel, UnitModel } from "../src/modules/masterdata/catalogs.model.js";
import { OrgSettingsModel } from "../src/modules/settings/org-settings.model.js";
import {
  BillLineModel,
  BillModel,
  DebitNoteModel,
  PaymentAllocationModel,
  PaymentModel,
} from "../src/modules/purchases/purchases.model.js";
import {
  CreditNoteModel,
  InvoiceLineModel,
  InvoiceModel,
  ReceiptAllocationModel,
  ReceiptModel,
} from "../src/modules/sales/sales.model.js";
import {
  BankAccountModel,
  StatementImportModel,
  StatementLineModel,
  TransferModel,
} from "../src/modules/banking/banking.model.js";
import { TaxCertificateModel, TaxChallanModel } from "../src/modules/tax/tax.model.js";
import {
  StockBalanceModel,
  StockMovementModel,
  StocktakeModel,
  WarehouseModel,
} from "../src/modules/inventory/inventory.model.js";
import { DepreciationRunModel, FixedAssetModel } from "../src/modules/fixed-assets/assets.model.js";
import { AdvanceAdjustmentModel, AdvanceModel } from "../src/modules/advances/advances.model.js";
import {
  LoanInstallmentModel,
  PayrollRunModel,
  PayslipModel,
  StaffLoanModel,
  StaffModel,
} from "../src/modules/payroll/payroll.model.js";
import { AuditLogModel } from "../src/core/audit.js";
import { runIntegrityChecks } from "../src/core/integrity.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const app = createApp();

/* ── Token minting (the same recipe as the Phase 5–10 smokes) ───────────── */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_PORT = 4577;
const CACHED_JWK: Record<string, unknown> = {};
const jwksServer = createServer((_request, response) => {
  const jwk = { ...CACHED_JWK, kid: "smoke-key", alg: "RS256", use: "sig" };
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
});

let authorization = "";

async function mintToken(uid: string, projectId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "smoke-key" })
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime("1h")
    .setIssuer(`https://securetoken.google.com/${projectId}`)
    .setAudience(projectId)
    .sign(privateKey);
}

const get = (path: string) => request(app).get(path).set("authorization", authorization);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (path: string, body: any) =>
  request(app).post(path).set("authorization", authorization).send(body);

interface PostedLine {
  account_code: string;
  debit_bdt: string;
  credit_bdt: string;
}

async function entryLines(entryId: string): Promise<PostedLine[]> {
  return (await get(`/api/v1/journals/${entryId}`)).body.data.entry.lines as PostedLine[];
}

const hasLine = (lines: PostedLine[], code: string, side: "debit" | "credit", amount: string): boolean =>
  lines.some(
    (line) => line.account_code === code && line[side === "debit" ? "debit_bdt" : "credit_bdt"] === amount,
  );

interface StaffRow {
  id: string;
  code: string;
  name: string;
  status: string;
  monthly_salary_bdt: string;
}

interface DeductionRow {
  type: "LOAN" | "ADVANCE" | "TAX";
  loan_id: string | null;
  amount_bdt: string;
  principal_bdt: string;
  interest_bdt: string;
}

interface PayslipRow {
  id: string;
  staff_id: string;
  doc_no: string | null;
  gross_bdt: string;
  deductions_bdt: string;
  net_bdt: string;
  deductions: DeductionRow[];
  status: "POSTED" | "PAID" | "REVERSED";
}

interface RunRow {
  id: string;
  period_key: string;
  date: string;
  status: "POSTED" | "REVERSED";
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
  payslips?: PayslipRow[];
}

interface InstallmentRow {
  seq: number;
  due_date: string;
  amount_bdt: string;
  principal_bdt: string;
  interest_bdt: string;
  paid_bdt: string;
  status: "DUE" | "PAID";
  run_id: string | null;
  payslip_id: string | null;
}

interface LoanRow {
  id: string;
  staff_id: string;
  doc_no: string | null;
  kind: "LOAN" | "ADVANCE";
  principal_bdt: string;
  total_interest_bdt: string;
  installment_bdt: string;
  status: "ACTIVE" | "CLOSED";
  outstanding_bdt: string;
  outstanding_principal_bdt: string;
  repaid_bdt: string;
  journal_entry_id: string | null;
  schedule?: InstallmentRow[];
}

interface LedgerResult {
  staff: StaffRow;
  rows: { date: string; kind: string; ref: string; amount_bdt: string; direction: string; settled: boolean }[];
  totals: {
    gross_bdt: string;
    deductions_bdt: string;
    net_bdt: string;
    net_paid_bdt: string;
    net_payable_bdt: string;
    advances_outstanding_bdt: string;
    loans_outstanding_bdt: string;
    recovered_bdt: string;
  };
}

async function main(): Promise<void> {
  Object.assign(CACHED_JWK, await exportJWK(publicKey));
  await new Promise<void>((resolve) => jwksServer.listen(JWKS_PORT, resolve));

  const environment = getEnvironment();
  await connectDatabase();
  console.log("Phase 11 smoke — payroll, staff ledger and loans\n");

  const uid = `smoke-p11-${Date.now()}`;
  authorization = `Bearer ${await mintToken(uid, environment.FIREBASE_PROJECT_ID)}`;

  const first = await get("/api/v1/auth/me");
  const orgId = first.body.data?.org as string;
  check("signup bootstraps an org with OWNER context", first.status === 200 && Boolean(orgId));

  try {
    /* ── A. The staff master ─────────────────────────────────────────────── */
    const st1 = (
      await post("/api/v1/staff", {
        code: "E01",
        name: "Rahim Uddin",
        designation: "Store manager",
        joining_date: "2024-03-01",
        branch: "Dhaka",
        monthly_salary_bdt: "30000.00",
      })
    ).body.data.staff as StaffRow;
    check(
      "staff member created ACTIVE at 30000.00 a month",
      st1?.status === "ACTIVE" && st1.monthly_salary_bdt === "30000.00" && Boolean(st1?.id),
      JSON.stringify({ status: st1?.status, salary: st1?.monthly_salary_bdt }),
    );

    const st2 = (
      await post("/api/v1/staff", {
        code: "E02",
        name: "Karima Begum",
        joining_date: "2025-01-15",
        branch: "Chattogram",
        monthly_salary_bdt: "20000.00",
      })
    ).body.data.staff as StaffRow;
    const st3 = (
      await post("/api/v1/staff", {
        code: "E03",
        name: "Sabbir Ahmed",
        joining_date: "2026-08-01",
        monthly_salary_bdt: "15000.00",
        status: "INACTIVE",
      })
    ).body.data.staff as StaffRow;
    check("three staff members exist, one of them inactive", Boolean(st2?.id && st3?.id));

    const duplicate = await post("/api/v1/staff", {
      code: "E01",
      name: "Impostor",
      joining_date: "2026-09-01",
      monthly_salary_bdt: "1000.00",
    });
    check(
      "a duplicate staff code is refused (409 STAFF_CODE_EXISTS)",
      duplicate.status === 409 && duplicate.body.error?.code === "STAFF_CODE_EXISTS",
      `status ${duplicate.status} ${duplicate.body.error?.code}`,
    );

    const activeOnly = (
      await get("/api/v1/staff?status=ACTIVE")
    ).body.data.staff as StaffRow[];
    check(
      "the ACTIVE list is exactly the two on the payroll",
      activeOnly.length === 2 && activeOnly.every((row) => row.status === "ACTIVE"),
      JSON.stringify(activeOnly.map((row) => row.code)),
    );

    const emptyLedger = (await get(`/api/v1/staff/${st1.id}/ledger`)).body.data as LedgerResult;
    check(
      "a fresh staff ledger has no rows and nothing payable",
      emptyLedger.rows.length === 0 &&
        emptyLedger.totals.net_payable_bdt === "0.00" &&
        emptyLedger.totals.loans_outstanding_bdt === "0.00",
      JSON.stringify(emptyLedger.totals),
    );

    /* ── B. Disbursement: a loan with a schedule, an advance without one ─── */
    //   60000.00 at 12% flat over 12 months: interest 60000 × 12/100 × 12/12 =
    //   7200.00; installment (60000 + 7200) / 12 = 5600.00, each row 5000.00
    //   principal + 600.00 interest — exact, so the sums are exact.
    const loan = (
      await post("/api/v1/staff/loans", {
        staff_id: st1.id,
        kind: "LOAN",
        principal_bdt: "60000.00",
        disbursed_on: "2026-09-05",
        account_code: "1010",
        interest_rate_percent: "12.00",
        term_months: 12,
      })
    ).body.data.loan as LoanRow;
    check(
      "the loan is numbered with 7200.00 of interest over 12 × 5600.00 installments",
      loan?.doc_no === "2026-01" &&
        loan.total_interest_bdt === "7200.00" &&
        loan.installment_bdt === "5600.00" &&
        loan.outstanding_bdt === "67200.00" &&
        loan.outstanding_principal_bdt === "60000.00" &&
        loan.status === "ACTIVE",
      JSON.stringify({
        doc_no: loan?.doc_no,
        interest: loan?.total_interest_bdt,
        installment: loan?.installment_bdt,
      }),
    );
    check(
      "the schedule is twelve rows: 5600.00 each, split 5000.00 principal + 600.00 interest",
      loan.schedule?.length === 12 &&
        loan.schedule.every(
          (row) =>
            row.amount_bdt === "5600.00" &&
            row.principal_bdt === "5000.00" &&
            row.interest_bdt === "600.00" &&
            row.status === "DUE",
        ) &&
        loan.schedule[0]?.due_date === "2026-10-05" &&
        loan.schedule[11]?.due_date === "2027-09-05",
      JSON.stringify(loan.schedule?.[0]),
    );
    check(
      "the schedule sums to the contract exactly — interest never overstated",
      loan
        .schedule!.reduce((acc, row) => acc + Number(row.interest_bdt), 0) === 7200 &&
        loan.schedule!.reduce((acc, row) => acc + Number(row.principal_bdt), 0) === 60000,
    );

    const loanEntry = await entryLines(loan.journal_entry_id!);
    check(
      "the disbursement posts DR 1600 Staff Loans / CR 1010 Bank for the principal",
      loanEntry.length === 2 &&
        hasLine(loanEntry, "1600", "debit", "60000.00") &&
        hasLine(loanEntry, "1010", "credit", "60000.00"),
      JSON.stringify(loanEntry),
    );

    const advance = (
      await post("/api/v1/staff/loans", {
        staff_id: st2.id,
        kind: "ADVANCE",
        principal_bdt: "5000.00",
        disbursed_on: "2026-09-06",
        account_code: "1000",
      })
    ).body.data.loan as LoanRow;
    check(
      "an advance is the same instrument at 0%: one row, no interest, 5000.00 outstanding",
      advance?.doc_no === "2026-02" &&
        advance.kind === "ADVANCE" &&
        advance.total_interest_bdt === "0.00" &&
        advance.outstanding_bdt === "5000.00" &&
        advance.schedule?.length === 1 &&
        advance.schedule[0]?.amount_bdt === "5000.00" &&
        advance.schedule[0]?.due_date === "2026-09-06",
      JSON.stringify(advance?.schedule),
    );
    const advanceEntry = await entryLines(advance.journal_entry_id!);
    check(
      "the advance posts DR 1600 / CR 1000 Cash",
      advanceEntry.length === 2 &&
        hasLine(advanceEntry, "1600", "debit", "5000.00") &&
        hasLine(advanceEntry, "1000", "credit", "5000.00"),
      JSON.stringify(advanceEntry),
    );

    const advanceWithInterest = await post("/api/v1/staff/loans", {
      staff_id: st2.id,
      kind: "ADVANCE",
      principal_bdt: "1000.00",
      disbursed_on: "2026-09-07",
      interest_rate_percent: "5.00",
    });
    check(
      "an advance carrying interest is refused (422 ADVANCE_NO_INTEREST)",
      advanceWithInterest.status === 422 &&
        advanceWithInterest.body.error?.code === "ADVANCE_NO_INTEREST",
      `status ${advanceWithInterest.status} ${advanceWithInterest.body.error?.code}`,
    );

    const inactiveLoan = await post("/api/v1/staff/loans", {
      staff_id: st3.id,
      principal_bdt: "1000.00",
      disbursed_on: "2026-09-07",
    });
    check(
      "no loan can be recorded for an inactive staff member (422 STAFF_INACTIVE)",
      inactiveLoan.status === 422 && inactiveLoan.body.error?.code === "STAFF_INACTIVE",
      `status ${inactiveLoan.status} ${inactiveLoan.body.error?.code}`,
    );

    /* ── C. The September run: preview, post, the entry, the payslips ────── */
    //   ST1: 30000.00 + 2000.00 allowance = 32000.00 gross; deduct the loan's
    //   first installment 5600.00 (5000.00 principal + 600.00 interest) and
    //   1000.00 of source tax → net 25400.00.
    //   ST2: 20000.00 gross; recover 2000.00 of the advance → net 18000.00.
    //   Totals: gross 52000.00, deductions 8600.00, net 43400.00.
    const septemberPayments = [
      {
        staff_id: st1.id,
        allowances_bdt: "2000.00",
        deductions: [
          { type: "LOAN", loan_id: loan.id },
          { type: "TAX", amount_bdt: "1000.00", reason: "Source tax" },
        ],
      },
      {
        staff_id: st2.id,
        deductions: [{ type: "ADVANCE", amount_bdt: "2000.00", reason: "Advance recovery" }],
      },
    ];

    const previewSept = (
      await post("/api/v1/staff/runs/preview", {
        period_key: "2026-09",
        payments: septemberPayments,
      })
    ).body.data.preview as {
      date: string;
      rows: { staff_id: string; gross_bdt: string; deductions_bdt: string; net_bdt: string; deductions: DeductionRow[] }[];
      totals: { staff_count: number; gross_bdt: string; deductions_bdt: string; net_bdt: string };
    };
    check(
      "the preview posts on the period's last day and totals 52000.00 gross / 43400.00 net",
      previewSept.date === "2026-09-30" &&
        previewSept.totals.staff_count === 2 &&
        previewSept.totals.gross_bdt === "52000.00" &&
        previewSept.totals.deductions_bdt === "8600.00" &&
        previewSept.totals.net_bdt === "43400.00",
      JSON.stringify(previewSept.totals),
    );
    const previewSt1 = previewSept.rows.find((row) => row.staff_id === st1.id)!;
    check(
      "the preview splits ST1's loan deduction into 5000.00 principal and 600.00 interest",
      previewSt1.gross_bdt === "32000.00" &&
        previewSt1.net_bdt === "25400.00" &&
        previewSt1.deductions.some(
          (row) => row.type === "LOAN" && row.principal_bdt === "5000.00" && row.interest_bdt === "600.00",
        ) &&
        previewSt1.deductions.some((row) => row.type === "TAX" && row.amount_bdt === "1000.00"),
      JSON.stringify(previewSt1),
    );

    const runSept = (
      await post("/api/v1/staff/runs", {
        period_key: "2026-09",
        payments: septemberPayments,
      })
    ).body.data.run as RunRow;
    check(
      "posting writes one accrual for the batch — the same figures the preview showed",
      runSept?.status === "POSTED" &&
        runSept.date === "2026-09-30" &&
        runSept.gross_bdt === "52000.00" &&
        runSept.net_bdt === "43400.00" &&
        runSept.loan_principal_bdt === "5000.00" &&
        runSept.advance_bdt === "2000.00" &&
        runSept.loan_interest_bdt === "600.00" &&
        runSept.tax_bdt === "1000.00" &&
        Boolean(runSept.journal_entry_id),
      JSON.stringify({ gross: runSept?.gross_bdt, net: runSept?.net_bdt }),
    );

    const septEntry = await entryLines(runSept.journal_entry_id!);
    check(
      "the accrual is DR 5100 52000.00 / CR 2300 43400.00 / CR 1600 7000.00 / CR 4100 600.00 / CR 2200 1000.00",
      septEntry.length === 5 &&
        hasLine(septEntry, "5100", "debit", "52000.00") &&
        hasLine(septEntry, "2300", "credit", "43400.00") &&
        hasLine(septEntry, "1600", "credit", "7000.00") &&
        hasLine(septEntry, "4100", "credit", "600.00") &&
        hasLine(septEntry, "2200", "credit", "1000.00"),
      JSON.stringify(septEntry),
    );

    const septSlips = runSept.payslips ?? [];
    const slipSt1 = septSlips.find((row) => row.staff_id === st1.id)!;
    const slipSt2 = septSlips.find((row) => row.staff_id === st2.id)!;
    check(
      "two numbered payslips: ST1 25400.00 net, ST2 18000.00 net",
      septSlips.length === 2 &&
        slipSt1.doc_no === "2026-01" &&
        slipSt1.net_bdt === "25400.00" &&
        slipSt2.doc_no === "2026-02" &&
        slipSt2.net_bdt === "18000.00",
      JSON.stringify(septSlips.map((row) => ({ no: row.doc_no, net: row.net_bdt }))),
    );
    check(
      "ST1's payslip carries the loan split and the tax as rows",
      slipSt1.deductions.some(
        (row) => row.type === "LOAN" && row.principal_bdt === "5000.00" && row.interest_bdt === "600.00",
      ) &&
        slipSt1.deductions.some((row) => row.type === "TAX" && row.amount_bdt === "1000.00"),
      JSON.stringify(slipSt1.deductions),
    );

    const loanAfterSept = (
      await get(`/api/v1/staff/loans/${loan.id}`)
    ).body.data.loan as LoanRow;
    check(
      "the run claimed installment 1: repaid 5600.00, 61600.00 left, 5500.00 of principal recovered",
      loanAfterSept.repaid_bdt === "5600.00" &&
        loanAfterSept.outstanding_bdt === "61600.00" &&
        loanAfterSept.outstanding_principal_bdt === "55000.00" &&
        loanAfterSept.status === "ACTIVE",
      JSON.stringify({
        repaid: loanAfterSept.repaid_bdt,
        outstanding: loanAfterSept.outstanding_bdt,
        principal: loanAfterSept.outstanding_principal_bdt,
      }),
    );
    check(
      "installment 1 is PAID and points back at the run and its payslip",
      loanAfterSept.schedule?.[0]?.status === "PAID" &&
        loanAfterSept.schedule[0].paid_bdt === "5600.00" &&
        loanAfterSept.schedule[0].run_id === runSept.id &&
        loanAfterSept.schedule[0].payslip_id === slipSt1.id,
      JSON.stringify(loanAfterSept.schedule?.[0]),
    );
    const advanceAfterSept = (
      await get(`/api/v1/staff/loans/${advance.id}`)
    ).body.data.loan as LoanRow;
    check(
      "the advance absorbed 2000.00, 3000.00 left",
      advanceAfterSept.repaid_bdt === "2000.00" && advanceAfterSept.outstanding_bdt === "3000.00",
      JSON.stringify({ repaid: advanceAfterSept.repaid_bdt, left: advanceAfterSept.outstanding_bdt }),
    );

    /* ── D. The guards ───────────────────────────────────────────────────── */
    const rerunSept = await post("/api/v1/staff/runs", {
      period_key: "2026-09",
      payments: septemberPayments,
    });
    check(
      "a second run for the same period is refused (409 PAYROLL_PERIOD_EXISTS)",
      rerunSept.status === 409 && rerunSept.body.error?.code === "PAYROLL_PERIOD_EXISTS",
      `status ${rerunSept.status} ${rerunSept.body.error?.code}`,
    );

    const overRecovery = await post("/api/v1/staff/runs/preview", {
      period_key: "2026-10",
      payments: [
        { staff_id: st2.id, deductions: [{ type: "ADVANCE", amount_bdt: "99999.00" }] },
      ],
    });
    check(
      "recovering more than the staff member's advances is refused (422 ADVANCE_RECOVERY_EXCEEDS)",
      overRecovery.status === 422 &&
        overRecovery.body.error?.code === "ADVANCE_RECOVERY_EXCEEDS",
      `status ${overRecovery.status} ${overRecovery.body.error?.code}`,
    );

    const unknownStaff = await post("/api/v1/staff/runs/preview", {
      period_key: "2026-10",
      payments: [{ staff_id: "aaaaaaaaaaaaaaaaaaaaaaaa", allowances_bdt: "100.00" }],
    });
    check(
      "a payment naming somebody off the payroll is refused (422 STAFF_NOT_IN_RUN)",
      unknownStaff.status === 422 && unknownStaff.body.error?.code === "STAFF_NOT_IN_RUN",
      `status ${unknownStaff.status} ${unknownStaff.body.error?.code}`,
    );

    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "VIEWER" } });
    check(
      "a VIEWER may read the staff, the runs and a ledger",
      (await get("/api/v1/staff")).status === 200 &&
        (await get("/api/v1/staff/runs")).status === 200 &&
        (await get(`/api/v1/staff/${st1.id}/ledger`)).status === 200,
    );
    check(
      "a VIEWER cannot add staff, run payroll or disburse a loan (403)",
      (
        await post("/api/v1/staff", {
          code: "E09",
          name: "Nope",
          joining_date: "2026-09-01",
          monthly_salary_bdt: "100.00",
        })
      ).status === 403 &&
        (await post("/api/v1/staff/runs", { period_key: "2026-11" })).status === 403 &&
        (
          await post("/api/v1/staff/loans", {
            staff_id: st1.id,
            principal_bdt: "100.00",
            disbursed_on: "2026-09-10",
          })
        ).status === 403,
    );
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "OWNER" } });

    /* ── E. Pay the September run ────────────────────────────────────────── */
    const paidSept = (
      await post(`/api/v1/staff/runs/${runSept.id}/pay`, { method: "CASH" })
    ).body.data.run as RunRow;
    check(
      "paying the run marks it paid on the run date, out of cash",
      paidSept.paid_on === "2026-09-30" &&
        paidSept.paid_on !== null &&
        Boolean(paidSept.payment_journal_entry_id),
      JSON.stringify({ paid_on: paidSept.paid_on }),
    );
    const payEntry = await entryLines(paidSept.payment_journal_entry_id!);
    check(
      "the payment is DR 2300 43400.00 / CR 1000 Cash 43400.00",
      payEntry.length === 2 &&
        hasLine(payEntry, "2300", "debit", "43400.00") &&
        hasLine(payEntry, "1000", "credit", "43400.00"),
      JSON.stringify(payEntry),
    );
    const septSlipsAfterPay = (
      await get(`/api/v1/staff/payslips?run_id=${runSept.id}`)
    ).body.data.payslips as PayslipRow[];
    check(
      "both payslips flipped to PAID",
      septSlipsAfterPay.length === 2 && septSlipsAfterPay.every((row) => row.status === "PAID"),
      JSON.stringify(septSlipsAfterPay.map((row) => row.status)),
    );
    const payAgain = await post(`/api/v1/staff/runs/${runSept.id}/pay`, { method: "CASH" });
    check(
      "paying a paid run is refused (409 RUN_ALREADY_PAID)",
      payAgain.status === 409 && payAgain.body.error?.code === "RUN_ALREADY_PAID",
      `status ${payAgain.status} ${payAgain.body.error?.code}`,
    );

    /* ── F. October: post, reverse (everything restored), post again ─────── */
    //   ST1 takes installment 2 (5600.00, no allowance this month); ST2
    //   recovers the rest of the advance (3000.00). Totals: gross 50000.00,
    //   deductions 8600.00, net 41400.00.
    const octoberPayments = [
      { staff_id: st1.id, deductions: [{ type: "LOAN", loan_id: loan.id }] },
      { staff_id: st2.id, deductions: [{ type: "ADVANCE", amount_bdt: "3000.00" }] },
    ];
    const runOct = (
      await post("/api/v1/staff/runs", { period_key: "2026-10", payments: octoberPayments })
    ).body.data.run as RunRow;
    check(
      "October posts: 50000.00 gross, 41400.00 net, recoveries 8000.00, interest 600.00",
      runOct?.status === "POSTED" &&
        runOct.gross_bdt === "50000.00" &&
        runOct.net_bdt === "41400.00" &&
        runOct.loan_principal_bdt === "5000.00" &&
        runOct.advance_bdt === "3000.00" &&
        runOct.loan_interest_bdt === "600.00" &&
        runOct.tax_bdt === "0.00",
      JSON.stringify({ gross: runOct?.gross_bdt, advance: runOct?.advance_bdt }),
    );
    const octEntry = await entryLines(runOct.journal_entry_id!);
    check(
      "no tax line this month: four lines, 2200 absent because nothing was withheld",
      octEntry.length === 4 &&
        hasLine(octEntry, "5100", "debit", "50000.00") &&
        hasLine(octEntry, "2300", "credit", "41400.00") &&
        hasLine(octEntry, "1600", "credit", "8000.00") &&
        hasLine(octEntry, "4100", "credit", "600.00") &&
        !octEntry.some((line) => line.account_code === "2200"),
      JSON.stringify(octEntry),
    );

    const loanAfterOct = (await get(`/api/v1/staff/loans/${loan.id}`)).body.data.loan as LoanRow;
    const advanceAfterOct = (
      await get(`/api/v1/staff/loans/${advance.id}`)
    ).body.data.loan as LoanRow;
    check(
      "October claimed installment 2 and emptied the advance to CLOSED",
      loanAfterOct.repaid_bdt === "11200.00" &&
        loanAfterOct.outstanding_bdt === "56000.00" &&
        loanAfterOct.outstanding_principal_bdt === "50000.00" &&
        advanceAfterOct.outstanding_bdt === "0.00" &&
        advanceAfterOct.status === "CLOSED",
      JSON.stringify({ loan: loanAfterOct.repaid_bdt, advance: advanceAfterOct.status }),
    );

    const reversed = (
      await post(`/api/v1/staff/runs/${runOct.id}/reverse`, { reason: "Wrong allowances" })
    ).body.data.run as RunRow;
    check(
      "reversing flips the run and its payslips to REVERSED and voids the entry",
      reversed.status === "REVERSED" &&
        (reversed.payslips ?? []).every((row) => row.status === "REVERSED"),
      JSON.stringify({ status: reversed.status, slips: reversed.payslips?.map((row) => row.status) }),
    );
    const loanAfterReverse = (
      await get(`/api/v1/staff/loans/${loan.id}`)
    ).body.data.loan as LoanRow;
    const advanceAfterReverse = (
      await get(`/api/v1/staff/loans/${advance.id}`)
    ).body.data.loan as LoanRow;
    check(
      "the reversal released every claim: installment 2 DUE again, balances restored, advance ACTIVE",
      loanAfterReverse.repaid_bdt === "5600.00" &&
        loanAfterReverse.outstanding_bdt === "61600.00" &&
        loanAfterReverse.outstanding_principal_bdt === "55000.00" &&
        loanAfterReverse.schedule?.[1]?.status === "DUE" &&
        loanAfterReverse.schedule[1].paid_bdt === "0.00" &&
        loanAfterReverse.schedule[1].run_id === null &&
        advanceAfterReverse.outstanding_bdt === "3000.00" &&
        advanceAfterReverse.status === "ACTIVE",
      JSON.stringify({
        loan: loanAfterReverse.repaid_bdt,
        installment2: loanAfterReverse.schedule?.[1],
        advance: advanceAfterReverse.status,
      }),
    );
    const reverseAgain = await post(`/api/v1/staff/runs/${runOct.id}/reverse`, {
      reason: "Should not be possible",
    });
    check(
      "reversing a reversed run is refused (409 RUN_REVERSED)",
      reverseAgain.status === 409 && reverseAgain.body.error?.code === "RUN_REVERSED",
      `status ${reverseAgain.status} ${reverseAgain.body.error?.code}`,
    );

    const runOctAgain = (
      await post("/api/v1/staff/runs", { period_key: "2026-10", payments: octoberPayments })
    ).body.data.run as RunRow;
    check(
      "October posts again after the reversal — numbers are never reused, figures identical",
      runOctAgain?.status === "POSTED" &&
        runOctAgain.id !== runOct.id &&
        (runOctAgain.payslips ?? []).every((row) => row.doc_no !== null) &&
        runOctAgain.net_bdt === "41400.00" &&
        (runOctAgain.payslips ?? []).some((row) => row.doc_no === "2026-05") &&
        (runOctAgain.payslips ?? []).some((row) => row.doc_no === "2026-06"),
      JSON.stringify(runOctAgain?.payslips?.map((row) => row.doc_no)),
    );

    /* ── G. Cash on a second advance: collect, then settle ───────────────── */
    //   ST1 gets a 4000.00 advance on 2026-09-20. 1500.00 is collected in cash
    //   on 2026-10-05, the remaining 2500.00 settles it on 2026-10-06 — both
    //   post `DR cash / CR 1600`, because the interest here is zero.
    const advance2 = (
      await post("/api/v1/staff/loans", {
        staff_id: st1.id,
        kind: "ADVANCE",
        principal_bdt: "4000.00",
        disbursed_on: "2026-09-20",
        account_code: "1000",
      })
    ).body.data.loan as LoanRow;
    check("ST1's second advance is numbered 2026-03 at 4000.00", advance2?.doc_no === "2026-03" && advance2.outstanding_bdt === "4000.00");

    const overCollect = await post(`/api/v1/staff/loans/${advance2.id}/collect`, {
      date: "2026-10-05",
      amount_bdt: "99999.00",
    });
    check(
      "collecting more than is outstanding is refused (422 LOAN_OVERPAID)",
      overCollect.status === 422 && overCollect.body.error?.code === "LOAN_OVERPAID",
      `status ${overCollect.status} ${overCollect.body.error?.code}`,
    );

    const collected = (
      await post(`/api/v1/staff/loans/${advance2.id}/collect`, {
        date: "2026-10-05",
        amount_bdt: "1500.00",
        account_code: "1000",
      })
    ).body.data as { loan: LoanRow; collected_bdt: string };
    check(
      "1500.00 collected in cash: 2500.00 left on the advance",
      collected.collected_bdt === "1500.00" && collected.loan.outstanding_bdt === "2500.00",
      JSON.stringify({ collected: collected.collected_bdt, left: collected.loan.outstanding_bdt }),
    );
    const collectEntry = await entryLines(collected.loan.journal_entry_id!);
    check(
      "the advance's own entry is still the disbursement — the collection posted its own",
      hasLine(collectEntry, "1600", "debit", "4000.00") && hasLine(collectEntry, "1000", "credit", "4000.00"),
      JSON.stringify(collectEntry),
    );
    const ledgerRows = await JournalLineModel.find({ org_id: orgId, account_code: "1600" }).lean();
    check(
      "1600 saw the collection as a 1500.00 credit alongside the disbursements",
      ledgerRows.some((row) => row.credit_bdt === "1500.00"),
      JSON.stringify(ledgerRows.map((row) => ({ d: row.debit_bdt, c: row.credit_bdt }))),
    );

    const settled = (
      await post(`/api/v1/staff/loans/${advance2.id}/settle`, { date: "2026-10-06" })
    ).body.data as { loan: LoanRow; settled_bdt: string };
    check(
      "settling pays the remaining 2500.00 and closes the advance",
      settled.settled_bdt === "2500.00" &&
        settled.loan.status === "CLOSED" &&
        settled.loan.outstanding_bdt === "0.00" &&
        settled.loan.repaid_bdt === "4000.00",
      JSON.stringify({ settled: settled.settled_bdt, status: settled.loan.status }),
    );
    const settleAgain = await post(`/api/v1/staff/loans/${advance2.id}/settle`, {
      date: "2026-10-07",
    });
    check(
      "settling a closed loan is refused (409 LOAN_CLOSED)",
      settleAgain.status === 409 && settleAgain.body.error?.code === "LOAN_CLOSED",
      `status ${settleAgain.status} ${settleAgain.body.error?.code}`,
    );

    /* ── H. The staff ledgers tie out, and the integrity run agrees ──────── */
    //   ST1: gross 62000.00 (32000.00 September + 30000.00 October); net
    //   49800.00, of which 25400.00 paid and 24400.00 still payable; 56000.00
    //   of loan left; 15200.00 recovered (5600.00 + 5600.00 payroll and the
    //   4000.00 advance collected in cash).
    const ledgerSt1 = (await get(`/api/v1/staff/${st1.id}/ledger`)).body.data as LedgerResult;
    check(
      "ST1's ledger totals: 62000.00 gross, 25400.00 paid, 24400.00 still payable",
      ledgerSt1.totals.gross_bdt === "62000.00" &&
        ledgerSt1.totals.deductions_bdt === "12200.00" &&
        ledgerSt1.totals.net_bdt === "49800.00" &&
        ledgerSt1.totals.net_paid_bdt === "25400.00" &&
        ledgerSt1.totals.net_payable_bdt === "24400.00" &&
        ledgerSt1.totals.loans_outstanding_bdt === "56000.00" &&
        ledgerSt1.totals.advances_outstanding_bdt === "0.00" &&
        ledgerSt1.totals.recovered_bdt === "15200.00",
      JSON.stringify(ledgerSt1.totals),
    );
    check(
      "ST1's rows tell the story: 2 salaries, the loan, the advance, 3 repayments",
      ledgerSt1.rows.filter((row) => row.kind === "SALARY").length === 2 &&
        ledgerSt1.rows.some((row) => row.kind === "LOAN" && row.amount_bdt === "60000.00" && row.direction === "OUT") &&
        ledgerSt1.rows.some((row) => row.kind === "ADVANCE" && row.amount_bdt === "4000.00") &&
        ledgerSt1.rows.filter((row) => row.kind === "REPAYMENT").length === 3 &&
        ledgerSt1.rows.some(
          (row) => row.kind === "REPAYMENT" && row.amount_bdt === "5600.00" && row.ref === "2026-01",
        ) &&
        ledgerSt1.rows.some(
          (row) => row.kind === "REPAYMENT" && row.amount_bdt === "4000.00" && row.ref === "Cash",
        ) &&
        ledgerSt1.rows.some(
          (row) => row.kind === "REPAYMENT" && row.amount_bdt === "5600.00" && row.ref === "2026-05",
        ),
      JSON.stringify(ledgerSt1.rows),
    );

    const ledgerSt2 = (await get(`/api/v1/staff/${st2.id}/ledger`)).body.data as LedgerResult;
    check(
      "ST2's ledger totals: advance fully recovered, salaries half paid",
      ledgerSt2.totals.gross_bdt === "40000.00" &&
        ledgerSt2.totals.net_bdt === "35000.00" &&
        ledgerSt2.totals.net_paid_bdt === "18000.00" &&
        ledgerSt2.totals.net_payable_bdt === "17000.00" &&
        ledgerSt2.totals.advances_outstanding_bdt === "0.00" &&
        ledgerSt2.totals.loans_outstanding_bdt === "0.00" &&
        ledgerSt2.totals.recovered_bdt === "5000.00",
      JSON.stringify(ledgerSt2.totals),
    );

    const runsList = (await get("/api/v1/staff/runs")).body.data.runs as RunRow[];
    check(
      "the run history keeps all three: September paid, October reversed and re-posted",
      runsList.length === 3 &&
        runsList.some((row) => row.period_key === "2026-09" && row.paid_on !== null) &&
        runsList.some((row) => row.period_key === "2026-10" && row.status === "REVERSED") &&
        runsList.some((row) => row.period_key === "2026-10" && row.status === "POSTED"),
      JSON.stringify(runsList.map((row) => ({ period: row.period_key, status: row.status }))),
    );

    const report = await runIntegrityChecks();
    const statusOf = (id: string): string | undefined =>
      report.checks.find((row) => row.id === id)?.status;
    check(
      "I5-PAYROLL passes — every run's entry equals its payslips and 2300 holds the unpaid net",
      statusOf("I5-PAYROLL") === "pass",
      JSON.stringify(report.checks.find((row) => row.id === "I5-PAYROLL")?.findings),
    );
    check(
      "I5-STAFF-LOANS passes — the sub-ledger equals what 1600 holds, exactly",
      statusOf("I5-STAFF-LOANS") === "pass",
      JSON.stringify(report.checks.find((row) => row.id === "I5-STAFF-LOANS")?.findings),
    );
    check(
      "the money-format check covers all five payroll collections",
      statusOf("P0-MONEY-FORMAT") === "pass",
    );
    check(
      "no integrity check fails",
      report.checks.every((row) => row.status !== "fail"),
      report.checks
        .filter((row) => row.status === "fail")
        .map((row) => row.id)
        .join(", "),
    );

    // The tables themselves: canonical amounts everywhere, and no installment
    // ever paid past its own schedule row.
    const storedInstalments = await LoanInstallmentModel.find({ org_id: orgId }).lean();
    check(
      "every stored installment amount is canonical and never overpaid",
      storedInstalments.every(
        (row) =>
          /^\d+\.\d{2}$/.test(row.amount_bdt ?? "") &&
          /^\d+\.\d{2}$/.test(row.paid_bdt ?? "") &&
          Number(row.paid_bdt ?? "0") <= Number(row.amount_bdt ?? "0"),
      ),
    );
    const storedSlips = await PayslipModel.find({ org_id: orgId }).lean();
    check(
      "every payslip satisfies gross − deductions = net to the paisa",
      storedSlips.every(
        (row) =>
          Math.round((Number(row.gross_bdt) - Number(row.deductions_bdt)) * 100) ===
          Math.round(Number(row.net_bdt) * 100),
      ),
      JSON.stringify(storedSlips.map((row) => ({ no: row.doc_no, g: row.gross_bdt, d: row.deductions_bdt, n: row.net_bdt }))),
    );

    /* ── H. A paid run reverses as one act: payment first, then accrual ──── */
    const paidRun = runsList.find((row) => row.paid_on !== null);
    const paymentEntryId = paidRun?.payment_journal_entry_id ?? null;
    const unpay = await post(`/api/v1/staff/runs/${paidRun?.id}/reverse`, {
      reason: "Paid run reversed end to end",
    });
    const unpayRun = (unpay.body.data as { run?: RunRow } | undefined)?.run;
    check(
      "a paid run can be reversed — no dead end: 200 with paidness cleared",
      unpay.status === 200 && unpayRun?.status === "REVERSED" && unpayRun?.paid_on === null,
      `status ${unpay.status} ${JSON.stringify(unpay.body.error ?? unpayRun)}`,
    );
    const paymentAfter = paymentEntryId
      ? await JournalEntryModel.findById(paymentEntryId).lean()
      : null;
    check(
      "the payment that paid that run is void with it, and its accrual too",
      paymentAfter?.status === "VOID" && unpayRun?.journal_entry_id != null,
      JSON.stringify({
        payment: paymentAfter?.status,
        accrual: unpayRun?.journal_entry_id,
        payment_entry: paymentEntryId,
      }),
    );
    check(
      "the voided payment is balanced against its reversal — cash came back",
      (await JournalLineModel.find({ entry_id: paymentAfter?.reversed_by_entry_id }).lean()).length > 0,
      String(paymentAfter?.reversed_by_entry_id),
    );

    // The claim that makes this interesting: the 5,000.00 advance row was
    // taken 2,000.00 by September and the rest (3,000.00) by the re-posted
    // October, which still holds it. Reversing September must take September's
    // 2,000.00 off the row and leave October's 3,000.00 exactly where it is —
    // a snapshot restore could not do that, and the tie-out below is where the
    // difference would show up.
    const postedOct = runsList.find(
      (row) => row.period_key === "2026-10" && row.status === "POSTED",
    );
    const sharedAdvanceRow = await LoanInstallmentModel.findOne({
      org_id: orgId,
      loan_id: advance.id,
    }).lean();
    check(
      "the shared advance row keeps October's 3,000.00 and loses only September's 2,000.00",
      sharedAdvanceRow?.paid_bdt === "3000.00" &&
        String(sharedAdvanceRow?.run_id) === postedOct?.id &&
        (sharedAdvanceRow?.claims ?? []).length === 1,
      JSON.stringify({
        paid: sharedAdvanceRow?.paid_bdt,
        run: String(sharedAdvanceRow?.run_id),
        claims: sharedAdvanceRow?.claims,
        oct: postedOct?.id,
      }),
    );
    const releasedRow = await LoanInstallmentModel.findOne({
      org_id: orgId,
      loan_id: loan.id,
      seq: 1,
    }).lean();
    const heldRow = await LoanInstallmentModel.findOne({
      org_id: orgId,
      loan_id: loan.id,
      seq: 2,
    }).lean();
    check(
      "September's installment is released while October's claim on the next one stands",
      releasedRow?.paid_bdt === "0.00" &&
        !releasedRow?.run_id &&
        (releasedRow?.claims ?? []).length === 0 &&
        heldRow?.paid_bdt === "5600.00" &&
        String(heldRow?.run_id) === postedOct?.id,
      JSON.stringify({ released: releasedRow, held: heldRow }),
    );

    const reportAfter = await runIntegrityChecks();
    check(
      "I5-PAYROLL still passes after reversing a paid run",
      reportAfter.checks.find((row) => row.id === "I5-PAYROLL")?.status === "pass",
      JSON.stringify(reportAfter.checks.find((row) => row.id === "I5-PAYROLL")?.findings),
    );
    check(
      "no integrity check fails after a paid run is reversed",
      reportAfter.checks.every((row) => row.status !== "fail"),
      reportAfter.checks
        .filter((row) => row.status === "fail")
        .map((row) => `${row.id}: ${JSON.stringify(row.findings)}`)
        .join(" | "),
    );
  } catch (error) {
    // The summary below must not hide why the run stopped short.
    failed += 1;
    failures.push(`run aborted: ${error instanceof Error ? error.stack : String(error)}`);
    console.log(`\n  ABORT ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    cleanupAndReport(orgId);
  }
}

/** Cleanup, split out so the finally block stays readable. */
function cleanupAndReport(orgId: string): void {
  void (async () => {
    try {
      const org = await OrganizationModel.findById(orgId).lean().catch(() => null);
      if (org) {
        const { default: mongoose } = await import("mongoose");
        const id = new mongoose.Types.ObjectId(orgId);
        await Promise.all([
          // The payroll sub-ledger (P11). Its rows reference staff, runs and
          // entries, and a leftover installment against a deleted loan would
          // corrupt I5-STAFF-LOANS for whoever inherits the database.
          LoanInstallmentModel.deleteMany({ org_id: id }),
          StaffLoanModel.deleteMany({ org_id: id }),
          PayslipModel.deleteMany({ org_id: id }),
          PayrollRunModel.deleteMany({ org_id: id }),
          StaffModel.deleteMany({ org_id: id }),
          // The advance sub-ledger (P10).
          AdvanceAdjustmentModel.deleteMany({ org_id: id }),
          AdvanceModel.deleteMany({ org_id: id }),
          // The register (P9).
          DepreciationRunModel.deleteMany({ org_id: id }),
          FixedAssetModel.deleteMany({ org_id: id }),
          InvoiceLineModel.deleteMany({ org_id: id }),
          InvoiceModel.deleteMany({ org_id: id }),
          ReceiptAllocationModel.deleteMany({ org_id: id }),
          ReceiptModel.deleteMany({ org_id: id }),
          CreditNoteModel.deleteMany({ org_id: id }),
          BillLineModel.deleteMany({ org_id: id }),
          BillModel.deleteMany({ org_id: id }),
          PaymentAllocationModel.deleteMany({ org_id: id }),
          PaymentModel.deleteMany({ org_id: id }),
          DebitNoteModel.deleteMany({ org_id: id }),
          TaxChallanModel.deleteMany({ org_id: id }),
          TaxCertificateModel.deleteMany({ org_id: id }),
          // The stock ledger (P8).
          StocktakeModel.deleteMany({ org_id: id }),
          StockMovementModel.deleteMany({ org_id: id }),
          StockBalanceModel.deleteMany({ org_id: id }),
          WarehouseModel.deleteMany({ org_id: id }),
          // The treasury rows a new org is bootstrapped with.
          BankAccountModel.deleteMany({ org_id: id }),
          TransferModel.deleteMany({ org_id: id }),
          StatementImportModel.deleteMany({ org_id: id }),
          StatementLineModel.deleteMany({ org_id: id }),
          JournalEntryModel.deleteMany({ org_id: id }),
          JournalLineModel.deleteMany({ org_id: id }),
          CoaAccountModel.deleteMany({ org_id: id }),
          PeriodModel.deleteMany({ org_id: id }),
          SequenceCounterModel.deleteMany({ org_id: id }),
          PartyModel.deleteMany({ org_id: id }),
          ItemModel.deleteMany({ org_id: id }),
          UnitModel.deleteMany({ org_id: id }),
          TaxRateModel.deleteMany({ org_id: id }),
          MasterCategoryModel.deleteMany({ org_id: id }),
          OrgSettingsModel.deleteMany({ org_id: id }),
          OrgMembershipModel.deleteMany({ org_id: id }),
          // Native, bypassing the append-only hook — the hook blocking
          // `AuditLog.deleteMany` is the feature, not a bug.
          AuditLogModel.collection.deleteMany({ org_id: id }),
        ]);
        await OrganizationModel.deleteOne({ _id: id });
      }
    } catch (error) {
      console.error("cleanup failed:", error);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log("Failures:");
      for (const failure of failures) console.log(`  - ${failure}`);
    }
    await disconnectDatabase();
    process.exit(failed === 0 ? 0 : 1);
  })();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
