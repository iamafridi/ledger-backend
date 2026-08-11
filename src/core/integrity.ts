/**
 * Integrity checks — the machine that answers "are these books still correct?".
 *
 * WHY THIS EXISTS AT ALL
 * MongoDB enforces none of the things a relational schema takes for granted: no
 * foreign keys, no CHECK constraints, no balanced-ledger invariant. Nothing in
 * the database will stop a future bug from writing an unbalanced journal entry
 * or an expense whose `month` disagrees with its `date`. Every invariant in this
 * codebase is therefore something only this file (and the tests) will notice has
 * broken — which makes the integrity run not a nice-to-have but the only
 * standing defence.
 *
 * Each check reports one of:
 *
 *   pass    the invariant holds
 *   fail    it does not — `findings` names the offending rows
 *   skipped the data the invariant governs does not exist yet (Phase 1's journal
 *           tables are not written until then), reported honestly rather than
 *           passing vacuously
 *
 * A vacuous pass is worse than a skip: it looks like evidence. So a check that
 * found nothing *to* check says so.
 *
 * INVARIANTS
 *   I1  every POSTED journal entry balances to zero        (P1)
 *   I2  trial balance debits equal credits                 (P1)
 *   I3  assets = liabilities + equity                      (P5)
 *   I4  nothing posts into a closed period                 (P1)
 *   I5  the AR control account equals the customer sub-ledger (P3)
 *   I5  the AP control account equals the supplier sub-ledger (P4)
 *   P3  every issued invoice, receipt and credit note is posted (P3)
 *   P4  every issued bill, payment and debit note is posted   (P4)
 *   P6  every bank/cash account maps onto one asset account (P6)
 *   P6  every transfer and posted correction is in the ledger (P6)
 *   I5  the VAT and withholding control accounts equal the documents behind them (P7)
 *   I5  stock valuation equals the inventory control account  (P8)
 *   I5  the fixed-asset register equals 1500 and 1510            (P9)
 *   I5  every advance is backed exactly once by the general ledger (P10)
 *   I6  Σ advances − Σ adjustments ≥ 0 for every party            (P10)
 *   I5  every payroll run's entry equals its payslips, and 2300 holds the unpaid net (P11)
 *   I5  the staff-loan sub-ledger equals what 1600 holds, exactly   (P11)
 *   P9  an asset's cached write-down equals the runs behind it   (P9)
 *   P9  no asset is depreciated twice for the same month        (P9)
 *   P1  every expense has been posted to the ledger         (P1, plan §4 D3)
 *   P0  every organisation has exactly one active owner
 *   P0  one organisation per user (plan §4, D1)
 *   P0  money fields are canonical 2dp strings — never a float
 *   P0  every expense's denormalised month matches its date
 *
 * Every check is a read. The integrity run never mutates the data it judges —
 * the append-only property of the audit log is proven by the test suite instead,
 * because proving it here would require writing the very row being inspected.
 */
import mongoose from "mongoose";
import { Decimal } from "decimal.js";

import { MONEY_PATTERN } from "../shared/db/money-field.js";
import { OrgMembershipModel, OrganizationModel } from "../modules/org/org.model.js";
import { ExpenseModel } from "../modules/expenses/expense.model.js";
import { PocketModel } from "../modules/pockets/pocket.model.js";
import { SalaryModel } from "../modules/salary/salary.model.js";
import { JournalEntryModel, JournalLineModel } from "../modules/journals/journal.model.js";
import { PeriodModel } from "../modules/periods/period.model.js";
import { PartyModel } from "../modules/masterdata/parties.model.js";
import { CoaAccountModel } from "../modules/coa/coa.model.js";
import {
  BillLineModel,
  BillModel,
  DebitNoteModel,
  PaymentAllocationModel,
  PaymentModel,
} from "../modules/purchases/purchases.model.js";
import {
  CreditNoteModel,
  InvoiceLineModel,
  InvoiceModel,
  ReceiptAllocationModel,
  ReceiptModel,
} from "../modules/sales/sales.model.js";
import {
  BankAccountModel,
  StatementLineModel,
  TransferModel,
} from "../modules/banking/banking.model.js";
import { TaxCertificateModel, TaxChallanModel } from "../modules/tax/tax.model.js";
import {
  StockBalanceModel,
  StockMovementModel,
  StocktakeModel,
} from "../modules/inventory/inventory.model.js";
import { DepreciationRunModel, FixedAssetModel } from "../modules/fixed-assets/assets.model.js";
import { AdvanceAdjustmentModel, AdvanceModel } from "../modules/advances/advances.model.js";
import {
  LoanInstallmentModel,
  PayrollRunModel,
  PayslipModel,
  StaffLoanModel,
  StaffModel,
} from "../modules/payroll/payroll.model.js";

export type CheckStatus = "pass" | "fail" | "skipped";

export interface CheckResult {
  id: string;
  title: string;
  /** The plan's phase that introduced the invariant. */
  since: string;
  status: CheckStatus;
  checked: number;
  findings: string[];
}

export interface IntegrityReport {
  ok: boolean;
  ran_at: string;
  duration_ms: number;
  checks: CheckResult[];
}

type Outcome = Omit<CheckResult, "id" | "title" | "since">;
type CheckFn = () => Promise<Outcome>;

interface Check {
  id: string;
  title: string;
  since: string;
  run: CheckFn;
}

const pass = (checked: number): Outcome => ({ status: "pass", checked, findings: [] });

const fail = (checked: number, findings: string[]): Outcome => ({
  status: "fail",
  checked,
  findings,
});

const skip = (reason: string): Outcome => ({ status: "skipped", checked: 0, findings: [reason] });

/** Reported when a check has no data to judge. Never phrased as a pass — a
 *  vacuous pass reads as evidence, and this file's whole value is that it does
 *  not manufacture evidence. */
const NOT_YET_BUILT = "Skipped: no journal entries exist yet, so there is nothing to check.";

/**
 * Aggregation shared by I1 and I2: per-entry debit and credit totals, for
 * entries that are in the books.
 *
 * Voids are included deliberately — a voided entry and its reversal each
 * balance on their own, and excluding either would hide exactly the corruption
 * this check exists to find. Sums run over Decimal128, never a double, for the
 * same reason the money field stores strings.
 */
const inBooksEntryStatus = ["POSTED", "VOID"];

/**
 * Which control account each party's balance lives on, restricted to one side of
 * the ledger.
 *
 * The restriction is not optional. A document's journal entry tags *every* line
 * with the party — revenue and expense included — so the AR tie-out has to know
 * which of those lines is the receivable, and the AP tie-out which is the
 * payable. Since P4 both kinds of line carry a party tag, so a check that
 * matched purely on "this party's control account code" would count a supplier's
 * payable as if it were a receivable and vice versa: two checks each accusing the
 * other side's documents of being wrong.
 *
 * The side is decided by the control account's **type** (asset vs liability)
 * rather than by its code, because `parties.service.ts` validates a control
 * account the same way — a supplier may legitimately be pointed at any liability
 * account, not only at 2000.
 */
async function controlAccountsByParty(debitNormal: boolean): Promise<Map<string, string>> {
  const [parties, accounts] = await Promise.all([
    PartyModel.find({}).select({ control_account_code: 1 }).lean(),
    CoaAccountModel.find({}).select({ code: 1, type: 1 }).lean(),
  ]);

  const typeByOrgCode = new Map(
    accounts.map((row) => [`${String(row.org_id)}/${row.code}`, row.type] as const),
  );
  const wanted = debitNormal ? "ASSET" : "LIABILITY";

  return new Map(
    parties
      .filter(
        (row) =>
          typeByOrgCode.get(`${String(row.org_id)}/${row.control_account_code}`) === wanted,
      )
      .map((row) => [String(row._id), row.control_account_code] as const),
  );
}

/**
 * What each party's control account holds in the general ledger.
 *
 * `debitNormal` decides which side reads as positive: an asset grows on the
 * debit side, a liability on the credit. Stating it once here is what keeps the
 * AR and AP tie-outs comparable — they differ in a single boolean, not in a
 * separately-maintained sign convention.
 */
async function controlBalances(
  controlByParty: Map<string, string>,
  debitNormal: boolean,
): Promise<Map<string, Decimal>> {
  const glRows = await JournalLineModel.aggregate<{
    _id: { party: string; code: string };
    debit: unknown;
    credit: unknown;
  }>([
    { $match: { party_id: { $ne: "" } } },
    { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
    { $unwind: "$entry" },
    { $match: { "entry.status": { $in: inBooksEntryStatus } } },
    {
      $group: {
        _id: { party: "$party_id", code: "$account_code" },
        debit: { $sum: { $toDecimal: "$debit_bdt" } },
        credit: { $sum: { $toDecimal: "$credit_bdt" } },
      },
    },
    { $addFields: { debit: { $toString: "$debit" }, credit: { $toString: "$credit" } } },
  ]);

  const out = new Map<string, Decimal>();
  for (const row of glRows) {
    // Only the line on *that party's* control account is the sub-ledger balance;
    // the rest is what the balance was raised against.
    if (row._id.code !== controlByParty.get(row._id.party)) continue;
    const debit = new Decimal(String(row.debit));
    const credit = new Decimal(String(row.credit));
    const balance = debitNormal ? debit.minus(credit) : credit.minus(debit);
    out.set(row._id.party, (out.get(row._id.party) ?? new Decimal(0)).plus(balance));
  }
  return out;
}

async function entryTotals(orgId?: unknown): Promise<
  Array<{ _id: mongoose.Types.ObjectId; entry_no: string | null; debit: string; credit: string }>
> {
  return JournalLineModel.aggregate([
    ...(orgId ? [{ $match: { org_id: orgId } }] : []),
    { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
    { $unwind: "$entry" },
    { $match: { "entry.status": { $in: inBooksEntryStatus } } },
    {
      $group: {
        _id: "$entry_id",
        entry_no: { $first: "$entry.entry_no" },
        debit: { $sum: { $toDecimal: "$debit_bdt" } },
        credit: { $sum: { $toDecimal: "$credit_bdt" } },
      },
    },
    { $addFields: { debit: { $toString: "$debit" }, credit: { $toString: "$credit" } } },
  ]);
}

/**
 * Debits and credits per organisation **and account code**, for the control
 * tie-outs that are not per party (P7's VAT and withholding accounts).
 *
 * Keyed by `org/code` because those checks compare a control account's balance
 * against the documents that moved it, and both sides of that comparison are
 * org-scoped — unlike the party-based tie-outs, which can rely on a party id
 * being unique across organisations.
 */
async function accountTotalsByOrgCode(): Promise<
  Map<string, { debit: Decimal; credit: Decimal }>
> {
  const raw = await JournalLineModel.aggregate<{
    _id: { org: unknown; code: string };
    debit: unknown;
    credit: unknown;
  }>([
    { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
    { $unwind: "$entry" },
    { $match: { "entry.status": { $in: inBooksEntryStatus } } },
    {
      $group: {
        _id: { org: "$entry.org_id", code: "$account_code" },
        debit: { $sum: { $toDecimal: "$debit_bdt" } },
        credit: { $sum: { $toDecimal: "$credit_bdt" } },
      },
    },
    { $addFields: { debit: { $toString: "$debit" }, credit: { $toString: "$credit" } } },
  ]);

  const out = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const row of raw) {
    out.set(`${String(row._id.org)}/${row._id.code}`, {
      debit: new Decimal(String(row.debit)),
      credit: new Decimal(String(row.credit)),
    });
  }
  return out;
}

/** One account's balance for one organisation, in the sign its type implies.
 *  A missing account is zero: every finding about it is reported by the tie-out,
 *  not by this helper. */
function accountBalance(
  totals: Map<string, { debit: Decimal; credit: Decimal }>,
  orgId: string,
  code: string,
  debitNormal: boolean,
): Decimal {
  const entry = totals.get(`${orgId}/${code}`);
  if (!entry) return new Decimal(0);
  return debitNormal ? entry.debit.minus(entry.credit) : entry.credit.minus(entry.debit);
}

const CHECKS: Check[] = [
  {
    id: "P0-ORG-OWNER",
    title: "Every organisation has exactly one active owner",
    since: "P0",
    run: async () => {
      const orgs = await OrganizationModel.find().lean();
      if (orgs.length === 0) return pass(0);

      const findings: string[] = [];
      for (const org of orgs) {
        const owners = await OrgMembershipModel.countDocuments({
          org_id: org._id,
          role: "OWNER",
          is_active: true,
        });
        if (owners !== 1) {
          findings.push(
            `org ${String(org._id)} has ${owners} active OWNER memberships (expected exactly 1)`,
          );
        }
      }
      return findings.length === 0 ? pass(orgs.length) : fail(orgs.length, findings);
    },
  },
  {
    id: "P0-ORG-ONE-PER-USER",
    title: "One organisation per user (plan §4, D1)",
    since: "P0",
    run: async () => {
      // The unique index on `owner_uid` already prevents this. The check exists
      // to catch what the index cannot: rows predating it, or a future code path
      // that inserts without going through the service.
      const duplicated = await OrganizationModel.aggregate<{
        _id: string;
        ids: mongoose.Types.ObjectId[];
        count: number;
      }>([
        { $group: { _id: "$owner_uid", ids: { $push: "$_id" }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
      ]);

      const findings = duplicated.map(
        (row) => `uid ${row._id} owns ${row.count} organisations: ${row.ids.join(", ")}`,
      );
      return findings.length === 0
        ? pass(0)
        : fail(duplicated.length, findings);
    },
  },
  {
    id: "P0-MONEY-FORMAT",
    title: "Money fields are canonical 2dp strings, never floats",
    since: "P0",
    run: async () => {
      const findings: string[] = [];
      let checked = 0;

      const inspect = (
        label: string,
        rows: readonly Record<string, unknown>[],
        fields: readonly string[],
      ): void => {
        for (const row of rows) {
          for (const field of fields) {
            const value = row[field];
            if (value === undefined || value === null) continue;
            checked += 1;
            // A number here means BSON stored a double — exactly the corruption
            // shared/db/money-field.ts exists to prevent — and a wrong shape
            // means something bypassed the schema. Either way the value cannot
            // be trusted downstream, so both fail the same check.
            if (typeof value !== "string" || !MONEY_PATTERN.test(value)) {
              findings.push(
                `${label} ${String(row["_id"])}.${field} = ${JSON.stringify(value)} ` +
                  `(expected a "1234.56" string)`,
              );
            }
          }
        }
      };

      inspect("Expense", await ExpenseModel.find({}).lean(), ["amount_bdt"]);
      inspect("Pocket", await PocketModel.find({}).lean(), [
        "target_bdt",
        "monthly_contribution_bdt",
        "saved_bdt",
      ]);
      inspect("Salary", await SalaryModel.find({}).lean(), ["amount_bdt"]);
      // The AR documents (P3). A float here would put a receivable out by a
      // fraction of a paisa, which is exactly the drift this codebase's whole
      // string-money design exists to make impossible.
      inspect("Invoice", await InvoiceModel.find({}).lean(), [
        "subtotal_bdt",
        "discount_total_bdt",
        "tax_total_bdt",
        "total_bdt",
        "paid_bdt",
        "credited_bdt",
      ]);
      inspect("InvoiceLine", await InvoiceLineModel.find({}).lean(), [
        "unit_price_bdt",
        "discount_bdt",
        "net_bdt",
        "tax_rate_snapshot",
        "tax_bdt",
        "line_total_bdt",
      ]);
      inspect("Receipt", await ReceiptModel.find({}).lean(), [
        "amount_bdt",
        "allocated_bdt",
        "unallocated_bdt",
      ]);
      inspect("ReceiptAllocation", await ReceiptAllocationModel.find({}).lean(), ["amount_bdt"]);
      inspect("CreditNote", await CreditNoteModel.find({}).lean(), [
        "subtotal_bdt",
        "tax_total_bdt",
        "total_bdt",
      ]);
      // The AP documents (P4) — the same argument one desk over, and the same
      // reason: a payable out by a fraction of a paisa is a reconciliation
      // nobody can close.
      inspect("Bill", await BillModel.find({}).lean(), [
        "subtotal_bdt",
        "discount_total_bdt",
        "tax_total_bdt",
        "total_bdt",
        "paid_bdt",
        "debited_bdt",
      ]);
      inspect("BillLine", await BillLineModel.find({}).lean(), [
        "unit_price_bdt",
        "discount_bdt",
        "net_bdt",
        "tax_rate_snapshot",
        "tax_bdt",
        "line_total_bdt",
      ]);
      const payments = await PaymentModel.find({}).lean();
      inspect("Payment", payments, [
        "amount_bdt",
        "allocated_bdt",
        "unallocated_bdt",
        "withheld_bdt",
        "cash_bdt",
      ]);
      // Embedded rows are inspected one at a time: `inspect` reads fields off a
      // row, and a withholding lives *inside* the payment that produced it (P7).
      for (const payment of payments) {
        inspect(
          `Payment ${String(payment._id)}.withholdings`,
          (payment.withholdings ?? []) as unknown as Record<string, unknown>[],
          ["tax_rate_snapshot", "amount_bdt"],
        );
      }
      inspect("PaymentAllocation", await PaymentAllocationModel.find({}).lean(), ["amount_bdt"]);
      // The tax documents (P7). A float in a challan is a deposit that does not
      // equal the liability it was meant to clear.
      inspect("TaxChallan", await TaxChallanModel.find({}).lean(), ["amount_bdt"]);
      const certificates = await TaxCertificateModel.find({}).lean();
      inspect("TaxCertificate", certificates, ["amount_bdt"]);
      for (const certificate of certificates) {
        inspect(
          `TaxCertificate ${String(certificate._id)}.withholdings`,
          (certificate.withholdings ?? []) as unknown as Record<string, unknown>[],
          ["tax_rate_snapshot", "amount_bdt"],
        );
      }
      inspect("DebitNote", await DebitNoteModel.find({}).lean(), [
        "subtotal_bdt",
        "tax_total_bdt",
        "total_bdt",
      ]);
      // The stock ledger (P8). Its value is the figure the inventory control
      // account is tied to, so a float here is a balance sheet that cannot
      // reconcile with itself.
      inspect("StockBalance", await StockBalanceModel.find({}).lean(), ["value_bdt", "avg_cost_bdt"]);
      inspect("StockMovement", await StockMovementModel.find({}).lean(), ["value_bdt", "unit_cost_bdt"]);
      const stocktakes = await StocktakeModel.find({}).lean();
      for (const stocktake of stocktakes) {
        inspect(
          `Stocktake ${String(stocktake._id)}.lines`,
          (stocktake.lines ?? []) as unknown as Record<string, unknown>[],
          ["unit_cost_bdt", "variance_value_bdt"],
        );
      }
      // The fixed-asset register (P9). Its cost and its written-down value are
      // the two figures 1500 and 1510 are tied to, so a float here is a balance
      // sheet that cannot reconcile with itself.
      const assets = await FixedAssetModel.find({}).lean();
      inspect("FixedAsset", assets, ["cost_bdt", "salvage_bdt", "accumulated_depreciation_bdt"]);
      for (const asset of assets) {
        if (asset.disposal) {
          inspect(
            `FixedAsset ${String(asset._id)}.disposal`,
            [asset.disposal] as unknown as Record<string, unknown>[],
            ["proceeds_bdt", "cost_bdt", "accumulated_bdt", "nbv_bdt", "gain_bdt", "loss_bdt"],
          );
        }
      }
      inspect("DepreciationRun", await DepreciationRunModel.find({}).lean(), [
        "amount_bdt",
        "cost_bdt",
        "salvage_bdt",
        "accum_before_bdt",
        "accum_after_bdt",
        "nbv_after_bdt",
      ]);
      // The advance sub-ledger (P10). Its amounts are what I6 sums, so a float
      // here is an invariant that cannot be asserted at all.
      inspect("Advance", await AdvanceModel.find({}).lean(), ["amount_bdt"]);
      inspect("AdvanceAdjustment", await AdvanceAdjustmentModel.find({}).lean(), ["amount_bdt"]);
      // The payroll sub-ledger (P11). A float in a payslip would pay somebody
      // a fraction of a taka off, which is exactly the drift this design
      // exists to make impossible.
      inspect("Staff", await StaffModel.find({}).lean(), ["monthly_salary_bdt"]);
      inspect(
        "PayrollRun",
        await PayrollRunModel.find({}).lean(),
        [
          "gross_bdt",
          "deductions_bdt",
          "net_bdt",
          "loan_principal_bdt",
          "advance_bdt",
          "loan_interest_bdt",
          "tax_bdt",
        ],
      );
      inspect(
        "Payslip",
        await PayslipModel.find({}).lean(),
        [
          "basic_bdt",
          "allowances_bdt",
          "gross_bdt",
          "deductions_bdt",
          "loan_principal_bdt",
          "advance_bdt",
          "loan_interest_bdt",
          "tax_bdt",
          "net_bdt",
        ],
      );
      inspect(
        "StaffLoan",
        await StaffLoanModel.find({}).lean(),
        [
          "principal_bdt",
          "interest_rate_percent",
          "total_interest_bdt",
          "installment_bdt",
          "outstanding_bdt",
          "outstanding_principal_bdt",
          "repaid_bdt",
        ],
      );
      const installments = await LoanInstallmentModel.find({}).lean();
      inspect(
        "LoanInstallment",
        installments,
        ["amount_bdt", "principal_bdt", "interest_bdt", "paid_bdt", "paid_before_run_bdt"],
      );
      // A claim's take is an amount too, and it is the one a reversal
      // subtracts from the row — a number there would take the release out by
      // a fraction of a paisa (P11). Embedded rows are inspected one at a time
      // for the same reason the payment withholdings above are.
      for (const installment of installments) {
        inspect(
          `LoanInstallment ${String(installment._id)}.claims`,
          (installment.claims ?? []) as unknown as Record<string, unknown>[],
          ["take_bdt"],
        );
      }

      return findings.length === 0 ? pass(checked) : fail(checked, findings);
    },
  },
  {
    id: "P0-EXPENSE-MONTH",
    title: "Every expense's denormalised month matches its date",
    since: "P0",
    run: async () => {
      // `month` is stored rather than derived so a dashboard read is an equality
      // lookup instead of a collection scan with $substr. That denormalisation is
      // only worth its cost while it is correct, and the only things keeping it
      // correct are the single derivation point in expense.service.ts and this
      // check.
      const mismatches = await ExpenseModel.find({
        $expr: { $ne: ["$month", { $substrCP: ["$date", 0, 7] }] },
      }).lean();

      const findings = mismatches.map(
        (row) => `expense ${String(row._id)}: date ${row.date} but month ${row.month}`,
      );
      return findings.length === 0 ? pass(0) : fail(mismatches.length, findings);
    },
  },
  {
    id: "P1-EXPENSE-BRIDGE",
    title: "Every expense is in the general ledger (plan §4, D3)",
    since: "P1",
    run: async () => {
      // D3 makes the general ledger the single source of truth, so an expense
      // that never reached it is a real defect: the dashboard would show
      // spending the trial balance knows nothing about. The bridge is allowed to
      // fail softly — a closed period is not the typist's problem — which is
      // only defensible because this check makes the gap loud and
      // `POST /expenses/post-to-ledger` makes it fixable.
      const total = await ExpenseModel.countDocuments({});
      if (total === 0) return skip("No expenses exist yet, so there is nothing to check.");

      const unposted = await ExpenseModel.countDocuments({ journal_entry_id: null });
      if (unposted === 0) return pass(total);

      const sample = await ExpenseModel.find({ journal_entry_id: null })
        .sort({ date: 1 })
        .limit(5)
        .lean();

      return fail(total, [
        `${unposted} of ${total} expenses are not in the ledger — ` +
          `post them with POST /api/v1/expenses/post-to-ledger`,
        ...sample.map(
          (row) => `expense ${String(row._id)} (${row.date} ${row.category} ${row.amount_bdt}) has no journal entry`,
        ),
      ]);
    },
  },
  {
    id: "I1-JOURNAL-BALANCED",
    title: "Every POSTED journal entry balances to zero",
    since: "P1",
    run: async () => {
      const totals = await entryTotals();
      if (totals.length === 0) return skip(NOT_YET_BUILT);

      // Compared as decimals, not floats: 0.1 + 0.2 drifting to 0.30000000000000004
      // is precisely the failure this whole codebase is built to prevent, and a
      // balance check that itself used floats would wave it through.
      const findings = totals
        .filter((row) => !new Decimal(row.debit).equals(new Decimal(row.credit)))
        .map((row) => `entry ${row.entry_no ?? String(row._id)}: debits ${row.debit} vs credits ${row.credit}`);

      return findings.length === 0 ? pass(totals.length) : fail(totals.length, findings.slice(0, 20));
    },
  },
  {
    id: "I2-TRIAL-BALANCE",
    title: "Trial balance debits equal credits",
    since: "P1",
    run: async () => {
      const totals = await entryTotals();
      if (totals.length === 0) return skip(NOT_YET_BUILT);

      const debits = totals.reduce((acc, row) => acc.plus(new Decimal(row.debit)), new Decimal(0));
      const credits = totals.reduce((acc, row) => acc.plus(new Decimal(row.credit)), new Decimal(0));

      return debits.equals(credits)
        ? pass(totals.length)
        : fail(totals.length, [`trial balance: debits ${debits.toFixed(2)} vs credits ${credits.toFixed(2)}`]);
    },
  },
  {
    id: "I4-CLOSED-PERIOD",
    title: "Nothing is posted into a period after it was closed",
    since: "P1",
    run: async () => {
      const closed = await PeriodModel.find({ status: "CLOSED" }).lean();
      if (closed.length === 0) return skip("No period has been closed yet.");

      const findings: string[] = [];
      let checked = 0;

      for (const period of closed) {
        if (!period.closed_at) continue;

        const late = await JournalEntryModel.find({
          org_id: period.org_id,
          period_key: period.key,
          status: { $in: inBooksEntryStatus },
          posted_at: { $gt: period.closed_at },
        })
          .limit(10)
          .lean();

        checked += 1;
        for (const entry of late) {
          findings.push(
            `entry ${entry.entry_no ?? String(entry._id)} posted at ${new Date(entry.posted_at!).toISOString()} ` +
              `into ${period.key}, which closed at ${new Date(period.closed_at).toISOString()}`,
          );
        }
      }

      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "P3-AR-IN-LEDGER",
    title: "Every issued receivable document is in the general ledger",
    since: "P3",
    run: async () => {
      // The AR counterpart of P1-EXPENSE-BRIDGE. An invoice marked ISSUED whose
      // posting is missing, or a receipt that never reached the bank account, is
      // a document a customer is holding that the trial balance knows nothing
      // about — the failure this design's transaction-per-document rule exists
      // to prevent, and the reason it is worth watching for anyway.
      const [invoices, receipts, notes] = await Promise.all([
        InvoiceModel.find({ status: { $in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } }).lean(),
        ReceiptModel.find({}).lean(),
        CreditNoteModel.find({ status: "ISSUED" }).lean(),
      ]);

      const checked = invoices.length + receipts.length + notes.length;
      if (checked === 0) {
        return skip("No invoices, receipts or credit notes exist yet, so there is nothing to check.");
      }

      const unposted = [
        ...invoices
          .filter((row) => !row.journal_entry_id)
          .map((row) => `invoice ${row.doc_no ?? String(row._id)} (${row.date}) is ISSUED but has no journal entry`),
        ...receipts
          .filter((row) => !row.journal_entry_id)
          .map((row) => `receipt ${row.doc_no} (${row.date}) has no journal entry`),
        ...notes
          .filter((row) => !row.journal_entry_id)
          .map((row) => `credit note ${row.doc_no} (${row.date}) has no journal entry`),
      ];

      return unposted.length === 0
        ? pass(checked)
        : fail(checked, [
            `${unposted.length} of ${checked} receivable documents have no journal entry`,
            ...unposted.slice(0, 10),
          ]);
    },
  },
  {
    id: "I5-AR-CONTROL",
    title: "The AR control account equals the customer sub-ledger (plan §6)",
    since: "P3",
    run: async () => {
      // I5: the control account is the general ledger's view of the receivable,
      // the invoices and receipts are the sub-ledger's view, and they must agree
      // to the paisa. This is the check the whole per-party `control_account_code`
      // design exists to make answerable.
      const [invoices, receipts, manualAdvances, claims] = await Promise.all([
        InvoiceModel.find({ status: { $in: ["ISSUED", "PARTIALLY_PAID"] } })
          .select({ party_id: 1, total_bdt: 1, paid_bdt: 1, credited_bdt: 1 })
          .lean(),
        ReceiptModel.find({}).select({ party_id: 1, unallocated_bdt: 1 }).lean(),
        // Only *manual* advances need adding here: a receipt-remainder advance
        // is the same credit as that receipt's `unallocated_bdt`, so counting
        // both would double it. A manual advance posted its own entry —
        // `DR cash / CR control` — and no receipt carries it, so the sub-ledger
        // must subtract it explicitly.
        AdvanceModel.find({ source: "MANUAL" }).select({ party_id: 1, amount_bdt: 1 }).lean(),
        // Advance claims against invoices (P10). `paid_bdt` counts a claim as
        // settlement exactly as it counts a receipt, so an open invoice's
        // outstanding is already net of the claims it carries.
        AdvanceAdjustmentModel.find({ document_type: "INVOICE" })
          .select({ party_id: 1, amount_bdt: 1 })
          .lean(),
      ]);

      if (
        invoices.length === 0 &&
        receipts.length === 0 &&
        manualAdvances.length === 0 &&
        claims.length === 0
      ) {
        return skip(
          "No open invoices, receipts, manual advances or advance claims exist yet, so there is no receivable sub-ledger to tie to the control account.",
        );
      }

      // The sub-ledger, derived from the documents themselves rather than from
      // the service that maintains it: a check that asks the same helper the app
      // asks cannot catch that helper being wrong.
      const subLedger = new Map<string, Decimal>();
      const bump = (party: string, delta: Decimal): void => {
        subLedger.set(party, (subLedger.get(party) ?? new Decimal(0)).plus(delta));
      };

      for (const invoice of invoices) {
        bump(
          String(invoice.party_id),
          new Decimal(invoice.total_bdt ?? 0)
            .minus(invoice.paid_bdt ?? 0)
            .minus(invoice.credited_bdt ?? 0),
        );
      }
      // An unallocated receipt is a credit the customer holds with us, and it
      // reduced the control account when it was posted — so it reduces the
      // sub-ledger by the same amount.
      for (const receipt of receipts) {
        bump(String(receipt.party_id), new Decimal(receipt.unallocated_bdt ?? 0).negated());
      }
      // A manual advance (P10) did the same thing with no receipt behind it. Its
      // **gross** is subtracted, not its unadjusted remainder: applying it to an
      // invoice posts nothing, so both the control account and this nominal
      // sub-ledger stay where they were (ADR 0004 §5). Only advances that
      // actually touched *this* control account belong here, though: a MANUAL
      // advance is direction-dependent — a customer's posts `DR cash / CR AR`,
      // a supplier's mirrors into AP — so the party's side is decided by its
      // control account's type, the same rule `parties.service.ts` validates
      // with. (Found by the P10 smoke: a customer's 50000.00 advance was being
      // subtracted from the payables tie-out, where it never posted.)
      const controlByParty = await controlAccountsByParty(true);
      for (const advance of manualAdvances) {
        const party = String(advance.party_id);
        if (!controlByParty.has(party)) continue;
        bump(party, new Decimal(advance.amount_bdt ?? 0).negated());
      }
      // …and the claims are added back, because the same money is now counted
      // twice: the invoice's `paid_bdt` was reduced by the claim (it settles the
      // invoice exactly as a receipt would), while the credit the claim came
      // from was subtracted gross two rows above. One claim, one subtraction —
      // the control account never moved when it was made (ADR 0004 §5). Rows
      // against a voided invoice cannot linger (the void deletes them
      // transactionally), so every row here belongs to a live invoice.
      for (const claim of claims) {
        bump(String(claim.party_id), new Decimal(claim.amount_bdt ?? 0));
      }

      const gl = await controlBalances(controlByParty, true);

      const findings: string[] = [];
      const partyIds = new Set([...subLedger.keys(), ...gl.keys()]);

      for (const party of partyIds) {
        const ledger = gl.get(party) ?? new Decimal(0);
        const sub = subLedger.get(party) ?? new Decimal(0);
        if (!ledger.equals(sub)) {
          findings.push(
            `party ${party}: control account holds ${ledger.toFixed(2)} but the invoices and receipts say ${sub.toFixed(2)}`,
          );
        }
      }

      return findings.length === 0 ? pass(partyIds.size) : fail(partyIds.size, findings.slice(0, 20));
    },
  },
  {
    id: "I5-AP-CONTROL",
    title: "The AP control account equals the supplier sub-ledger (plan §6)",
    since: "P4",
    run: async () => {
      // I5 twice over: the receivables tie-out above, and this one for the
      // payables. The control account is the general ledger's view of what we
      // owe, the bills and payments are the sub-ledger's view, and they must
      // agree to the paisa.
      const [bills, payments, manualAdvances, claims] = await Promise.all([
        BillModel.find({ status: { $in: ["ISSUED", "PARTIALLY_PAID"] } })
          .select({ party_id: 1, total_bdt: 1, paid_bdt: 1, debited_bdt: 1 })
          .lean(),
        PaymentModel.find({}).select({ party_id: 1, unallocated_bdt: 1 }).lean(),
        // Only manual advances: a payment-prepayment advance is the same debit
        // as that payment's `unallocated_bdt`. See the AR check above.
        AdvanceModel.find({ source: "MANUAL" }).select({ party_id: 1, amount_bdt: 1 }).lean(),
        // Prepayment claims against bills (P10); `paid_bdt` counts them exactly
        // as it counts payment allocations.
        AdvanceAdjustmentModel.find({ document_type: "BILL" })
          .select({ party_id: 1, amount_bdt: 1 })
          .lean(),
      ]);

      if (
        bills.length === 0 &&
        payments.length === 0 &&
        manualAdvances.length === 0 &&
        claims.length === 0
      ) {
        return skip(
          "No open bills, payments, manual advances or prepayment claims exist yet, so there is no payable sub-ledger to tie to the control account.",
        );
      }

      // The sub-ledger, derived from the documents themselves rather than from
      // the service that maintains it: a check that asks the same helper the app
      // asks cannot catch that helper being wrong.
      const subLedger = new Map<string, Decimal>();
      const bump = (party: string, delta: Decimal): void => {
        subLedger.set(party, (subLedger.get(party) ?? new Decimal(0)).plus(delta));
      };

      for (const bill of bills) {
        bump(
          String(bill.party_id),
          new Decimal(bill.total_bdt ?? 0)
            .minus(bill.paid_bdt ?? 0)
            .minus(bill.debited_bdt ?? 0),
        );
      }
      // An unallocated payment is money the supplier is holding for us. It
      // debited the control account when it was posted, so it reduces the
      // payable by the same amount.
      for (const payment of payments) {
        bump(String(payment.party_id), new Decimal(payment.unallocated_bdt ?? 0).negated());
      }
      // A manual prepayment (P10) debited the control account with no payment
      // behind it, so it reduces the payable on the same terms. Only for parties
      // whose control account is a liability, though — a customer's MANUAL
      // advance posted to AR and has no business in this sub-ledger, the mirror
      // of the rule stated in the AR check above (found by the P10 smoke).
      const controlByParty = await controlAccountsByParty(false);
      for (const advance of manualAdvances) {
        const party = String(advance.party_id);
        if (!controlByParty.has(party)) continue;
        bump(party, new Decimal(advance.amount_bdt ?? 0).negated());
      }
      // …and the claims are added back for the same reason as on the AR side:
      // the bill's `paid_bdt` already absorbed the claim, so leaving the
      // advance's gross credit subtracted would count it twice (ADR 0004 §5).
      for (const claim of claims) {
        bump(String(claim.party_id), new Decimal(claim.amount_bdt ?? 0));
      }

      const gl = await controlBalances(controlByParty, false);

      const findings: string[] = [];
      const partyIds = new Set([...subLedger.keys(), ...gl.keys()]);

      for (const party of partyIds) {
        const ledger = gl.get(party) ?? new Decimal(0);
        const sub = subLedger.get(party) ?? new Decimal(0);
        if (!ledger.equals(sub)) {
          const control = controlByParty.get(party) ?? "no liability control account";
          findings.push(
            `party ${party} (control ${control}): the control account holds ${ledger.toFixed(2)} but the bills and payments say ${sub.toFixed(2)}`,
          );
        }
      }

      return findings.length === 0 ? pass(partyIds.size) : fail(partyIds.size, findings.slice(0, 20));
    },
  },
  {
    id: "I5-VAT-CONTROL",
    title: "The VAT and withholding control accounts equal the documents behind them (plan §6)",
    since: "P7",
    run: async () => {
      // I5 for tax. The tax on a line is computed once and posted to 2100 or 1300
      // from that same immutable snapshot, and a withholding is posted to 2200
      // from the payment that took it. So each control account and the documents
      // behind it are two readings of one set of facts — and a difference means
      // one of the two writes went somewhere the other does not know about,
      // which is exactly the failure a VAT return filed from the wrong figure
      // would hide behind.
      const [invoices, creditNotes, bills, debitNotes, payments, challans] = await Promise.all([
        InvoiceModel.find({ status: { $ne: "VOID" } }).select({ _id: 1, org_id: 1 }).lean(),
        CreditNoteModel.find({ status: { $ne: "VOID" } }).select({ _id: 1, org_id: 1 }).lean(),
        BillModel.find({ status: { $ne: "VOID" } }).select({ _id: 1, org_id: 1 }).lean(),
        DebitNoteModel.find({ status: { $ne: "VOID" } }).select({ _id: 1, org_id: 1 }).lean(),
        PaymentModel.find({}).select({ _id: 1, org_id: 1, withheld_bdt: 1 }).lean(),
        TaxChallanModel.find({}).select({ _id: 1, org_id: 1, amount_bdt: 1 }).lean(),
      ]);

      const checked =
        invoices.length + creditNotes.length + bills.length + debitNotes.length + payments.length + challans.length;
      if (checked === 0) {
        return skip("No tax-bearing documents exist yet, so there is no tax control account to tie out.");
      }

      // The documents' own view, per organisation. Only documents that are still
      // live count: a voided invoice's entry was reversed, so its tax belongs to
      // neither side of this comparison.
      const liveInvoices = new Map(invoices.map((row) => [String(row._id), String(row.org_id)] as const));
      const liveCreditNotes = new Map(creditNotes.map((row) => [String(row._id), String(row.org_id)] as const));
      const liveBills = new Map(bills.map((row) => [String(row._id), String(row.org_id)] as const));
      const liveDebitNotes = new Map(debitNotes.map((row) => [String(row._id), String(row.org_id)] as const));

      const output = new Map<string, Decimal>();
      const input = new Map<string, Decimal>();
      const bump = (into: Map<string, Decimal>, org: string, delta: Decimal): void => {
        into.set(org, (into.get(org) ?? new Decimal(0)).plus(delta));
      };

      const [invoiceLines, creditNoteLines, billLines, debitNoteLines] = await Promise.all([
        InvoiceLineModel.find({ doc_type: "INVOICE" }).select({ doc_id: 1, tax_bdt: 1 }).lean(),
        InvoiceLineModel.find({ doc_type: "CREDIT_NOTE" }).select({ doc_id: 1, tax_bdt: 1 }).lean(),
        BillLineModel.find({ doc_type: "BILL" }).select({ doc_id: 1, tax_bdt: 1 }).lean(),
        BillLineModel.find({ doc_type: "DEBIT_NOTE" }).select({ doc_id: 1, tax_bdt: 1 }).lean(),
      ]);

      for (const line of invoiceLines) {
        const org = liveInvoices.get(String(line.doc_id));
        if (org) bump(output, org, new Decimal(line.tax_bdt ?? 0));
      }
      for (const line of creditNoteLines) {
        const org = liveCreditNotes.get(String(line.doc_id));
        if (org) bump(output, org, new Decimal(line.tax_bdt ?? 0).negated());
      }
      for (const line of billLines) {
        const org = liveBills.get(String(line.doc_id));
        if (org) bump(input, org, new Decimal(line.tax_bdt ?? 0));
      }
      for (const line of debitNoteLines) {
        const org = liveDebitNotes.get(String(line.doc_id));
        if (org) bump(input, org, new Decimal(line.tax_bdt ?? 0).negated());
      }

      const withheld = new Map<string, Decimal>();
      for (const payment of payments) {
        bump(withheld, String(payment.org_id), new Decimal(payment.withheld_bdt ?? 0));
      }
      for (const challan of challans) {
        bump(withheld, String(challan.org_id), new Decimal(challan.amount_bdt ?? 0).negated());
      }

      const totals = await accountTotalsByOrgCode();

      // Only organisations that still exist are judged. A deleted tenant leaves
      // rows behind that nothing resolves any more — no login, no party, no
      // account — so a difference there is debris rather than a ledger error, and
      // reporting it would drown the findings that matter. Every other check is
      // scoped this way too, if less visibly: they resolve through a party or a
      // chart account, and a deleted organisation has neither.
      const liveOrgs = new Set(
        (await OrganizationModel.find({}).select({ _id: 1 }).lean()).map((row) => String(row._id)),
      );

      const orgs = new Set([
        ...output.keys(),
        ...input.keys(),
        ...withheld.keys(),
        ...[...totals.keys()].map((key) => key.split("/")[0] as string),
      ]);

      const findings: string[] = [];
      const compare = (
        orgId: string,
        label: string,
        code: string,
        debitNormal: boolean,
        fromDocuments: Decimal,
      ): void => {
        if (!liveOrgs.has(orgId)) return;
        const ledger = accountBalance(totals, orgId, code, debitNormal);
        // Nothing on either side is not a difference — it is an organisation
        // that has not traded in tax yet, and reporting it would be noise.
        if (ledger.isZero() && fromDocuments.isZero()) return;
        if (!ledger.equals(fromDocuments)) {
          findings.push(
            `org ${orgId}: ${code} (${label}) holds ${ledger.toFixed(2)} but the documents say ${fromDocuments.toFixed(2)}`,
          );
        }
      };

      for (const orgId of orgs) {
        compare(orgId, "output VAT", "2100", false, output.get(orgId) ?? new Decimal(0));
        compare(orgId, "input VAT", "1300", true, input.get(orgId) ?? new Decimal(0));
        compare(orgId, "source tax withheld", "2200", false, withheld.get(orgId) ?? new Decimal(0));
      }

      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "I5-STOCK",
    title: "Stock valuation equals the inventory control account (plan §6)",
    since: "P8",
    run: async () => {
      // I5 for stock. Every movement moves exactly the value that posted to 1200
      // (the receipt adds the line's own net; the issue relieves the same figure
      // the COGS posting was credited by), so this is a tie-out of one fact
      // written twice rather than two independently maintained records. A
      // difference means a movement and a posting disagree about the same goods.
      const [balances, movementRows] = await Promise.all([
        StockBalanceModel.find({}).select({ org_id: 1, item_id: 1, warehouse_id: 1, qty: 1, value_bdt: 1 }).lean(),
        StockMovementModel.find({}).select({ _id: 1, org_id: 1, qty: 1, value_bdt: 1, direction: 1 }).lean(),
      ]);

      if (balances.length === 0 && movementRows.length === 0) {
        return skip(
          "No stock movements exist yet, so there is no stock ledger to tie to the inventory control account.",
        );
      }

      const findings: string[] = [];

      // A negative balance is a movement that should have been refused. Reported
      // by name rather than netted away: one shelf below zero and another above
      // it is two errors, not a coincidence.
      for (const row of balances) {
        if (new Decimal(row.qty ?? 0).isNegative()) {
          findings.push(
            `stock balance for item ${String(row.item_id)} in warehouse ${String(row.warehouse_id)} holds a negative quantity (${row.qty})`,
          );
        }
      }

      const byOrg = new Map<string, Decimal>();
      for (const row of balances) {
        const org = String(row.org_id);
        byOrg.set(org, (byOrg.get(org) ?? new Decimal(0)).plus(new Decimal(row.value_bdt ?? 0)));
      }

      const totals = await accountTotalsByOrgCode();
      const liveOrgs = new Set(
        (await OrganizationModel.find({}).select({ _id: 1 }).lean()).map((row) => String(row._id)),
      );

      const orgs = new Set([
        ...byOrg.keys(),
        ...[...totals.keys()].map((key) => key.split("/")[0] as string),
      ]);

      for (const orgId of orgs) {
        // The same rule as the tax tie-out: a deleted tenant's rows resolve
        // through nothing, so a difference there is debris rather than a defect.
        if (!liveOrgs.has(orgId)) continue;

        const ledger = accountBalance(totals, orgId, "1200", true);
        const stock = byOrg.get(orgId) ?? new Decimal(0);
        if (ledger.isZero() && stock.isZero()) continue;
        if (!ledger.equals(stock)) {
          findings.push(
            `org ${orgId}: the inventory control account holds ${ledger.toFixed(2)} but the stock ledger values ${stock.toFixed(2)}`,
          );
        }
      }

      const checked = balances.length + movementRows.length;
      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "I5-FIXED-ASSETS",
    title: "Cost − accumulated depreciation = net book value = the ledger's position (plan §6)",
    since: "P9",
    run: async () => {
      // I5 for fixed assets, and the plan's Phase 9 exit gate stated as an
      // assertion. Three claims, all of them about the same rows:
      //
      //   1. every live asset's **cost** adds up to what 1500 holds;
      //   2. every live asset's **accumulated depreciation** adds up to what 1510
      //      holds on its credit side;
      //   3. the accumulated figure cached on each asset is the sum of the runs
      //      that were actually posted against it.
      //
      // Only assets still on the books are counted: a disposal removes the cost
      // from 1500 and clears the accumulated balance in 1510, so a disposed asset
      // belongs to neither side of the comparison. The register keeps its rows —
      // what was owned, what it fetched — but they stop contributing to the
      // balances the moment they leave.
      const assets = await FixedAssetModel.find({}).lean();
      if (assets.length === 0) {
        return skip(
          "No fixed assets are registered yet, so there is no register to tie to the fixed-asset control accounts.",
        );
      }

      const runs = await DepreciationRunModel.find({})
        .select({ asset_id: 1, period_key: 1, amount_bdt: 1, status: 1 })
        .lean();

      const findings: string[] = [];

      // 3a. The cached write-down, recomputed from the runs. A check that asked
      // the service would be asking the thing being checked.
      const runTotals = new Map<string, Decimal>();
      const seenPeriods = new Map<string, string>();
      for (const run of runs) {
        const key = String(run.asset_id);
        if (run.status === "POSTED") {
          runTotals.set(key, (runTotals.get(key) ?? new Decimal(0)).plus(new Decimal(run.amount_bdt ?? 0)));
          // 3b. Twice for one month. The partial unique index prevents it, and
          // this exists for the same reason the others do: the index is the only
          // thing preventing it, and an index can be absent on imported data.
          const periodKey = `${key}/${run.period_key}`;
          const already = seenPeriods.get(periodKey);
          if (already) {
            findings.push(
              `asset ${key} has two posted depreciation runs for ${run.period_key} (${already} and ${String(run._id)})`,
            );
          } else {
            seenPeriods.set(periodKey, String(run._id));
          }
        }
      }

      for (const asset of assets) {
        const cost = new Decimal(asset.cost_bdt ?? 0);
        const salvage = new Decimal(asset.salvage_bdt ?? 0);
        const accumulated = new Decimal(asset.accumulated_depreciation_bdt ?? 0);

        // Never written below salvage. Stored amounts are unsigned everywhere in
        // this codebase, so an over-depreciated asset can only be reported here
        // — there is no sign anywhere for it to hide in.
        if (accumulated.greaterThan(cost.minus(salvage))) {
          findings.push(
            `asset ${asset.code} (${String(asset._id)}) is written down to ${accumulated.toFixed(2)}, past the ${cost.minus(salvage).toFixed(2)} it can be written down to`,
          );
        }

        const fromRuns = runTotals.get(String(asset._id)) ?? new Decimal(0);
        if (!accumulated.equals(fromRuns)) {
          findings.push(
            `asset ${asset.code} (${String(asset._id)}) caches ${accumulated.toFixed(2)} of accumulated depreciation but its posted runs add up to ${fromRuns.toFixed(2)}`,
          );
        }
      }

      // 1 and 2. The register against the control accounts, per organisation.
      const live = assets.filter((asset) => asset.status === "ACTIVE");
      const costByOrg = new Map<string, Decimal>();
      const accumByOrg = new Map<string, Decimal>();
      for (const asset of live) {
        const org = String(asset.org_id);
        costByOrg.set(org, (costByOrg.get(org) ?? new Decimal(0)).plus(new Decimal(asset.cost_bdt ?? 0)));
        accumByOrg.set(
          org,
          (accumByOrg.get(org) ?? new Decimal(0)).plus(new Decimal(asset.accumulated_depreciation_bdt ?? 0)),
        );
      }

      const totals = await accountTotalsByOrgCode();
      const liveOrgs = new Set(
        (await OrganizationModel.find({}).select({ _id: 1 }).lean()).map((row) => String(row._id)),
      );

      const orgs = new Set([
        ...costByOrg.keys(),
        ...accumByOrg.keys(),
        ...[...totals.keys()].map((key) => key.split("/")[0] as string),
      ]);

      for (const orgId of orgs) {
        // The same rule as the tax and stock tie-outs: a deleted tenant's rows
        // resolve through nothing, so a difference there is debris rather than a
        // defect in somebody's books.
        if (!liveOrgs.has(orgId)) continue;

        const cost = costByOrg.get(orgId) ?? new Decimal(0);
        const accumulated = accumByOrg.get(orgId) ?? new Decimal(0);

        const glCost = accountBalance(totals, orgId, "1500", true);
        // 1510 is an asset account holding a credit balance — accumulated
        // depreciation is a contra-asset — so it reads positive on the credit
        // side, which is why the flag is `false` here and `true` for 1500.
        const glAccumulated = accountBalance(totals, orgId, "1510", false);

        if (!glCost.isZero() || !cost.isZero()) {
          if (!glCost.equals(cost)) {
            findings.push(
              `org ${orgId}: the fixed-asset account (1500) holds ${glCost.toFixed(2)} but the register's live assets cost ${cost.toFixed(2)}`,
            );
          }
        }
        if (!glAccumulated.isZero() || !accumulated.isZero()) {
          if (!glAccumulated.equals(accumulated)) {
            findings.push(
              `org ${orgId}: accumulated depreciation (1510) holds ${glAccumulated.toFixed(2)} but the register has written off ${accumulated.toFixed(2)}`,
            );
          }
        }
      }

      const checked = assets.length + runs.length;
      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "I5-ADVANCES",
    title: "Every advance is backed exactly once by the general ledger (plan §6, ADR 0004)",
    since: "P10",
    run: async () => {
      // I5 for advances. An advance is a credit a party holds with us, and the
      // general ledger already knows about every paisa of it — either as its own
      // entry (`MANUAL`) or inside the receipt/payment entry that left the money
      // unallocated. This check makes sure each advance is backed *exactly once*:
      // an advance with no backing is untracked money, and one backed twice is
      // double-counted credit. Applying an advance posts nothing, so neither
      // figure moves when a claim is made — which is what lets it be checked from
      // these rows alone (ADR 0004 §5).
      const advances = await AdvanceModel.find({}).lean();
      if (advances.length === 0) {
        return skip("No advances exist yet, so there is no advance sub-ledger to check.");
      }

      const [adjustments, receipts, payments] = await Promise.all([
        AdvanceAdjustmentModel.find({}).select({ advance_id: 1, amount_bdt: 1 }).lean(),
        ReceiptModel.find({}).select({ party_id: 1, unallocated_bdt: 1 }).lean(),
        PaymentModel.find({}).select({ party_id: 1, unallocated_bdt: 1 }).lean(),
      ]);

      const findings: string[] = [];
      const adjustedByAdvance = new Map<string, Decimal>();
      for (const row of adjustments) {
        const key = String(row.advance_id);
        adjustedByAdvance.set(
          key,
          (adjustedByAdvance.get(key) ?? new Decimal(0)).plus(new Decimal(row.amount_bdt ?? 0)),
        );
      }

      const parkedByParty = new Map<string, Decimal>();
      const prepaidByParty = new Map<string, Decimal>();
      for (const advance of advances) {
        const amount = new Decimal(advance.amount_bdt ?? 0);
        if (!amount.greaterThan(0)) {
          findings.push(`advance ${String(advance._id)} is ${amount.toFixed(2)}; an advance must be more than zero`);
        }

        // Backed exactly once.
        const manual = advance.source === "MANUAL";
        if (manual && !advance.journal_entry_id) {
          findings.push(
            `advance ${String(advance._id)} is MANUAL but carries no journal entry, so nothing put its money in the ledger`,
          );
        }
        if (!manual && advance.journal_entry_id) {
          findings.push(
            `advance ${String(advance._id)} is ${advance.source} but carries its own journal entry — that money is already in the receipt or payment's entry, so it would be counted twice`,
          );
        }

        const party = String(advance.party_id);
        if (advance.source === "RECEIPT_REMAINDER") {
          parkedByParty.set(party, (parkedByParty.get(party) ?? new Decimal(0)).plus(amount));
        }
        if (advance.source === "PAYMENT_PREPAYMENT") {
          prepaidByParty.set(party, (prepaidByParty.get(party) ?? new Decimal(0)).plus(amount));
        }

        // The per-row half of I6: no single advance adjusted past its own amount.
        const adjusted = adjustedByAdvance.get(String(advance._id)) ?? new Decimal(0);
        if (adjusted.greaterThan(amount)) {
          findings.push(
            `advance ${String(advance._id)} is ${amount.toFixed(2)} but ${adjusted.toFixed(2)} has been adjusted against it`,
          );
        }
      }

      // A parked remainder cannot exceed the receipt or payment it came from.
      const unallocatedByParty = new Map<string, Decimal>();
      for (const receipt of receipts) {
        const key = String(receipt.party_id);
        unallocatedByParty.set(
          key,
          (unallocatedByParty.get(key) ?? new Decimal(0)).plus(new Decimal(receipt.unallocated_bdt ?? 0)),
        );
      }
      for (const [party, parked] of parkedByParty) {
        const available = unallocatedByParty.get(party) ?? new Decimal(0);
        if (parked.greaterThan(available)) {
          findings.push(
            `party ${party}: ${parked.toFixed(2)} of receipt remainders are parked as advances but the receipts only left ${available.toFixed(2)} unallocated`,
          );
        }
      }

      const prepaidUnallocated = new Map<string, Decimal>();
      for (const payment of payments) {
        const key = String(payment.party_id);
        prepaidUnallocated.set(
          key,
          (prepaidUnallocated.get(key) ?? new Decimal(0)).plus(new Decimal(payment.unallocated_bdt ?? 0)),
        );
      }
      for (const [party, prepaid] of prepaidByParty) {
        const available = prepaidUnallocated.get(party) ?? new Decimal(0);
        if (prepaid.greaterThan(available)) {
          findings.push(
            `party ${party}: ${prepaid.toFixed(2)} of payment remainders are parked as prepayments but the payments only left ${available.toFixed(2)} unallocated`,
          );
        }
      }

      const checked = advances.length + adjustments.length;
      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "I6-ADVANCE-NONNEGATIVE",
    title: "Σ advances − Σ adjustments ≥ 0 for every party (plan §5.2, ADR 0004)",
    since: "P10",
    run: async () => {
      // The invariant the whole engine exists to protect, asserted over the full
      // range (ADR 0004 §8 — deliberately not per-date: a post-dated advance can
      // make an as-of snapshot read negative without the full-range balance ever
      // going below zero, and that is presentation, not breach).
      const [advances, adjustments] = await Promise.all([
        AdvanceModel.find({}).select({ party_id: 1, amount_bdt: 1 }).lean(),
        AdvanceAdjustmentModel.find({}).select({ party_id: 1, amount_bdt: 1 }).lean(),
      ]);
      if (advances.length === 0 && adjustments.length === 0) {
        return skip("No advances or adjustments exist yet, so the invariant has nothing to range over.");
      }

      const outstanding = new Map<string, Decimal>();
      for (const advance of advances) {
        const key = String(advance.party_id);
        outstanding.set(key, (outstanding.get(key) ?? new Decimal(0)).plus(new Decimal(advance.amount_bdt ?? 0)));
      }
      for (const adjustment of adjustments) {
        const key = String(adjustment.party_id);
        outstanding.set(key, (outstanding.get(key) ?? new Decimal(0)).minus(new Decimal(adjustment.amount_bdt ?? 0)));
      }

      const findings: string[] = [];
      for (const [party, balance] of outstanding) {
        if (balance.isNegative()) {
          findings.push(
            `party ${party} has been adjusted past its advances: Σ advances − Σ adjustments = ${balance.toFixed(2)}`,
          );
        }
      }

      return findings.length === 0 ? pass(outstanding.size) : fail(outstanding.size, findings.slice(0, 20));
    },
  },
  {
    id: "I5-PAYROLL",
    title: "Every payroll run's entry equals its payslips, and 2300 holds the unpaid net (P11)",
    since: "P11",
    run: async () => {
      // I5 for payroll. A run posts one accrual entry and payslips are the
      // per-person detail behind it — two readings of one set of facts, so a
      // difference means either the entry or the slips drifted. The payable
      // account then has an exact meaning by construction: every posted accrual
      // credited it, every payment debited it back, and a reversed run's entry
      // nets to nothing — so what 2300 still holds *is* the unpaid net.
      const runs = await PayrollRunModel.find({}).lean();
      if (runs.length === 0) {
        return skip("No payroll runs exist yet, so there is no payroll sub-ledger to check.");
      }
      const slips = await PayslipModel.find({}).lean();
      const decimal = (value: unknown): Decimal =>
        new Decimal(value === undefined || value === null ? "0.00" : (value as Decimal.Value));
      const findings: string[] = [];

      const slipsByRun = new Map<string, typeof slips>();
      for (const slip of slips) {
        const key = String(slip.run_id);
        slipsByRun.set(key, [...(slipsByRun.get(key) ?? []), slip]);
      }

      for (const run of runs) {
        if (run.status !== "POSTED") continue; // reversed: its entry nets to nothing
        const rows = slipsByRun.get(String(run._id)) ?? [];
        const sum = (field: string): Decimal =>
          rows.reduce((acc, row) => acc.plus(decimal(row[field as keyof typeof row])), new Decimal(0));
        const gross = sum("gross_bdt");
        const deductions = sum("deductions_bdt");
        const net = sum("net_bdt");
        const recovered = sum("loan_principal_bdt").plus(sum("advance_bdt"));

        if (!gross.eq(decimal(run.gross_bdt))) {
          findings.push(
            `run ${run.period_key}: stored gross ${run.gross_bdt} but its payslips sum to ${gross.toFixed(2)}`,
          );
        }
        if (!deductions.eq(decimal(run.deductions_bdt))) {
          findings.push(
            `run ${run.period_key}: stored deductions ${run.deductions_bdt} but its payslips sum to ${deductions.toFixed(2)}`,
          );
        }
        if (!net.eq(decimal(run.net_bdt))) {
          findings.push(
            `run ${run.period_key}: stored net ${run.net_bdt} but its payslips sum to ${net.toFixed(2)}`,
          );
        }
        if (!net.eq(gross.minus(deductions))) {
          findings.push(
            `run ${run.period_key}: gross ${gross.toFixed(2)} − deductions ${deductions.toFixed(2)} ≠ net ${net.toFixed(2)}`,
          );
        }

        for (const row of rows) {
          const g = decimal(row.gross_bdt);
          const d = decimal(row.deductions_bdt);
          const n = decimal(row.net_bdt);
          if (!g.minus(d).eq(n)) {
            findings.push(
              `payslip ${row.doc_no || String(row._id)}: gross ${row.gross_bdt} − deductions ${row.deductions_bdt} ≠ net ${row.net_bdt}`,
            );
          }
          const rowSum = (row.deductions ?? []).reduce(
            (acc, entry) => acc.plus(decimal(entry.amount_bdt)),
            new Decimal(0),
          );
          if (!rowSum.eq(d)) {
            findings.push(
              `payslip ${row.doc_no || String(row._id)}: deduction rows sum to ${rowSum.toFixed(2)} but the slip says ${row.deductions_bdt}`,
            );
          }
        }

        if (!run.journal_entry_id) {
          findings.push(`run ${run.period_key} is POSTED but carries no journal entry`);
          continue;
        }
        const lines = await JournalLineModel.find({ entry_id: run.journal_entry_id }).lean();
        const onSide = (code: string, side: "debit" | "credit"): Decimal =>
          lines
            .filter((line) => line.account_code === code)
            .reduce(
              (acc, line) => acc.plus(decimal(side === "debit" ? line.debit_bdt : line.credit_bdt)),
              new Decimal(0),
            );
        // Zero lines are legitimately omitted from the entry.
        const expectations: [string, "debit" | "credit", Decimal][] = [
          [run.expense_account_code, "debit", gross],
          ["2300", "credit", net],
          ["1600", "credit", recovered],
          ["4100", "credit", sum("loan_interest_bdt")],
          ["2200", "credit", sum("tax_bdt")],
        ];
        for (const [code, side, expected] of expectations) {
          if (!expected.greaterThan(new Decimal(0))) continue;
          const actual = onSide(code, side);
          if (!actual.eq(expected)) {
            findings.push(
              `run ${run.period_key}: the entry ${side}s ${code} ${actual.toFixed(2)} but the payslips say ${expected.toFixed(2)}`,
            );
          }
        }
      }

      const unpaidByOrg = new Map<string, Decimal>();
      for (const run of runs) {
        if (run.status !== "POSTED" || run.paid_on) continue;
        const key = String(run.org_id);
        unpaidByOrg.set(key, (unpaidByOrg.get(key) ?? new Decimal(0)).plus(decimal(run.net_bdt)));
      }
      const glRows = await JournalLineModel.aggregate<{
        _id: { org: string };
        debit: unknown;
        credit: unknown;
      }>([
        { $match: { account_code: "2300" } },
        { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
        { $unwind: "$entry" },
        { $match: { "entry.status": { $in: inBooksEntryStatus } } },
        {
          $group: {
            _id: { org: "$org_id" },
            debit: { $sum: { $toDecimal: "$debit_bdt" } },
            credit: { $sum: { $toDecimal: "$credit_bdt" } },
          },
        },
      ]);
      const glByOrg = new Map<string, Decimal>();
      for (const row of glRows) {
        const key = String(row._id.org);
        const balance = new Decimal(String(row.credit)).minus(new Decimal(String(row.debit)));
        glByOrg.set(key, (glByOrg.get(key) ?? new Decimal(0)).plus(balance));
      }
      for (const org of new Set([...unpaidByOrg.keys(), ...glByOrg.keys()])) {
        const unpaid = unpaidByOrg.get(org) ?? new Decimal(0);
        const held = glByOrg.get(org) ?? new Decimal(0);
        if (!held.eq(unpaid)) {
          findings.push(
            `org ${org}: 2300 Salaries Payable holds ${held.toFixed(2)} but the unpaid runs say ${unpaid.toFixed(2)}`,
          );
        }
      }

      const checked = runs.length + slips.length;
      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "I5-STAFF-LOANS",
    title: "The staff-loan sub-ledger equals what 1600 holds, exactly (plan §6, P11)",
    since: "P11",
    run: async () => {
      // I5 for staff loans. A loan's caches are recomputed from its installment
      // rows after every write, so this check re-derives them independently and
      // then ties the unrecovered principal to 1600 — where the disbursement
      // put it and every repayment (payroll or cash) takes it out. Interest is
      // never on the asset side: it is income only as it is collected, and the
      // schedule sums to the contract exactly, never a paisa more.
      const loans = await StaffLoanModel.find({}).lean();
      if (loans.length === 0) {
        return skip("No staff loans or advances exist yet, so there is nothing to tie to 1600.");
      }
      const installments = await LoanInstallmentModel.find({}).lean();
      const decimal = (value: unknown): Decimal =>
        new Decimal(value === undefined || value === null ? "0.00" : (value as Decimal.Value));
      const findings: string[] = [];

      const byLoan = new Map<string, typeof installments>();
      for (const row of installments) {
        const key = String(row.loan_id);
        byLoan.set(key, [...(byLoan.get(key) ?? []), row]);
      }

      const owedPrincipalByOrg = new Map<string, Decimal>();
      for (const loan of loans) {
        const rows = byLoan.get(String(loan._id)) ?? [];
        const principal = decimal(loan.principal_bdt);
        const interest = decimal(loan.total_interest_bdt);
        const label = loan.doc_no || String(loan._id);

        let repaid = new Decimal(0);
        let principalRecovered = new Decimal(0);
        let schedulePrincipal = new Decimal(0);
        let scheduleInterest = new Decimal(0);
        for (const row of rows) {
          const paid = decimal(row.paid_bdt);
          const rowInterest = decimal(row.interest_bdt);
          const interestPaid = paid.greaterThan(rowInterest) ? rowInterest : paid;
          repaid = repaid.plus(paid);
          principalRecovered = principalRecovered.plus(paid.minus(interestPaid));
          schedulePrincipal = schedulePrincipal.plus(decimal(row.principal_bdt));
          scheduleInterest = scheduleInterest.plus(rowInterest);
          if (paid.greaterThan(decimal(row.amount_bdt))) {
            findings.push(
              `loan ${label}: installment ${row.seq} was paid ${paid.toFixed(2)} against a schedule row of ${row.amount_bdt}`,
            );
          }
        }

        if (!schedulePrincipal.eq(principal)) {
          findings.push(
            `loan ${label}: the schedule's principal sums to ${schedulePrincipal.toFixed(2)} but the contract is ${principal.toFixed(2)}`,
          );
        }
        if (!scheduleInterest.eq(interest)) {
          findings.push(
            `loan ${label}: the schedule's interest sums to ${scheduleInterest.toFixed(2)} but the contract is ${interest.toFixed(2)} — interest is never overstated`,
          );
        }

        const outstanding = principal.plus(interest).minus(repaid);
        const expected = outstanding.greaterThan(new Decimal(0)) ? outstanding : new Decimal(0);
        if (!decimal(loan.outstanding_bdt).eq(expected)) {
          findings.push(
            `loan ${label}: cached outstanding ${loan.outstanding_bdt} but the schedule says ${expected.toFixed(2)}`,
          );
        }
        const outstandingPrincipal = principal.minus(principalRecovered);
        const expectedPrincipal = outstandingPrincipal.greaterThan(new Decimal(0))
          ? outstandingPrincipal
          : new Decimal(0);
        if (!decimal(loan.outstanding_principal_bdt).eq(expectedPrincipal)) {
          findings.push(
            `loan ${label}: cached principal outstanding ${loan.outstanding_principal_bdt} but the schedule says ${expectedPrincipal.toFixed(2)}`,
          );
        }
        const expectedStatus = expected.greaterThan(new Decimal(0)) ? "ACTIVE" : "CLOSED";
        if (loan.status !== expectedStatus) {
          findings.push(
            `loan ${label}: status ${loan.status} but ${expected.toFixed(2)} is still outstanding`,
          );
        }

        const key = String(loan.org_id);
        owedPrincipalByOrg.set(
          key,
          (owedPrincipalByOrg.get(key) ?? new Decimal(0)).plus(expectedPrincipal),
        );
      }

      const glRows = await JournalLineModel.aggregate<{
        _id: { org: string };
        debit: unknown;
        credit: unknown;
      }>([
        { $match: { account_code: "1600" } },
        { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
        { $unwind: "$entry" },
        { $match: { "entry.status": { $in: inBooksEntryStatus } } },
        {
          $group: {
            _id: { org: "$org_id" },
            debit: { $sum: { $toDecimal: "$debit_bdt" } },
            credit: { $sum: { $toDecimal: "$credit_bdt" } },
          },
        },
      ]);
      const glByOrg = new Map<string, Decimal>();
      for (const row of glRows) {
        const key = String(row._id.org);
        const balance = new Decimal(String(row.debit)).minus(new Decimal(String(row.credit)));
        glByOrg.set(key, (glByOrg.get(key) ?? new Decimal(0)).plus(balance));
      }
      for (const org of new Set([...owedPrincipalByOrg.keys(), ...glByOrg.keys()])) {
        const owed = owedPrincipalByOrg.get(org) ?? new Decimal(0);
        const held = glByOrg.get(org) ?? new Decimal(0);
        if (!held.eq(owed)) {
          findings.push(
            `org ${org}: 1600 Staff Loans holds ${held.toFixed(2)} but the loan sub-ledger says ${owed.toFixed(2)}`,
          );
        }
      }

      const checked = loans.length + installments.length;
      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "P4-AP-IN-LEDGER",
    title: "Every issued payable document is in the general ledger",
    since: "P4",
    run: async () => {
      // The AP counterpart of P3-AR-IN-LEDGER. A bill marked ISSUED whose posting
      // is missing, or a payment that never reached the bank account, is a
      // document a supplier is chasing that the trial balance knows nothing
      // about — the failure this design's transaction-per-document rule exists
      // to prevent, and the reason it is worth watching for anyway.
      const [bills, payments, notes] = await Promise.all([
        BillModel.find({ status: { $in: ["ISSUED", "PARTIALLY_PAID", "PAID"] } }).lean(),
        PaymentModel.find({}).lean(),
        DebitNoteModel.find({ status: "ISSUED" }).lean(),
      ]);

      const checked = bills.length + payments.length + notes.length;
      if (checked === 0) {
        return skip("No bills, payments or debit notes exist yet, so there is nothing to check.");
      }

      const unposted = [
        ...bills
          .filter((row) => !row.journal_entry_id)
          .map((row) => `bill ${row.doc_no ?? String(row._id)} (${row.date}) is ISSUED but has no journal entry`),
        ...payments
          .filter((row) => !row.journal_entry_id)
          .map((row) => `payment ${row.doc_no} (${row.date}) has no journal entry`),
        ...notes
          .filter((row) => !row.journal_entry_id)
          .map((row) => `debit note ${row.doc_no} (${row.date}) has no journal entry`),
      ];

      return unposted.length === 0
        ? pass(checked)
        : fail(checked, [
            `${unposted.length} of ${checked} payable documents have no journal entry`,
            ...unposted.slice(0, 10),
          ]);
    },
  },
  {
    id: "P6-BANK-MAPPING",
    title: "Every bank/cash account maps 1:1 onto an asset account (plan §6)",
    since: "P6",
    run: async () => {
      // A treasury row is a *view* of a chart account, so the two things that can
      // go wrong are the account vanishing and two rows claiming it. The second
      // is prevented by a unique index; this check exists because the index is
      // the only thing preventing it, and an index can be missing on imported
      // data. Asset type is checked here too: a treasury row on a revenue account
      // would make the cash position count sales.
      const rows = await BankAccountModel.find({}).lean();
      if (rows.length === 0) {
        return skip("No bank or cash accounts are set up yet, so there is nothing to check.");
      }

      const accounts = await CoaAccountModel.find({}).select({ org_id: 1, code: 1, name: 1, type: 1 }).lean();
      const byOrgCode = new Map<string, (typeof accounts)[number]>();
      for (const account of accounts) {
        byOrgCode.set(`${String(account.org_id)}/${account.code}`, account);
      }

      const findings: string[] = [];
      const claimed = new Map<string, string>();

      for (const row of rows) {
        const key = `${String(row.org_id)}/${row.account_code}`;
        const account = byOrgCode.get(key);

        if (!account) {
          findings.push(
            `bank account ${row.name} points at ${row.account_code}, which no longer exists in this chart`,
          );
          continue;
        }
        if (account.type !== "ASSET") {
          findings.push(
            `bank account ${row.name} points at ${row.account_code} (${account.type}), which is not an asset`,
          );
        }
        const owner = claimed.get(key);
        if (owner) {
          findings.push(`chart account ${row.account_code} is claimed by two bank accounts: ${owner} and ${row.name}`);
        } else {
          claimed.set(key, row.name);
        }
      }

      return findings.length === 0 ? pass(rows.length) : fail(rows.length, findings.slice(0, 20));
    },
  },
  {
    id: "P6-BANK-IN-LEDGER",
    title: "Every transfer and posted bank correction is in the general ledger",
    since: "P6",
    run: async () => {
      // The banking counterpart of P3-AR-IN-LEDGER. A transfer that never posted
      // is money that moved on the screen and not in the books; a correction
      // whose entry is missing leaves a statement line marked explained with
      // nothing behind it. For transfers the arithmetic is checked too — the
      // source is credited the amount *plus* the fee — because that is the one
      // place a fee can be silently dropped.
      const [transfers, corrected] = await Promise.all([
        TransferModel.find({}).lean(),
        StatementLineModel.find({ status: "CORRECTED" }).lean(),
      ]);

      const checked = transfers.length + corrected.length;
      if (checked === 0) {
        return skip("No transfers or corrections exist yet, so there is nothing to check.");
      }

      const findings: string[] = [];

      for (const transfer of transfers) {
        if (!transfer.journal_entry_id) {
          findings.push(`transfer ${transfer.doc_no} has no journal entry`);
          continue;
        }
        const lines = await JournalLineModel.find({ entry_id: transfer.journal_entry_id }).lean();
        if (lines.length === 0) {
          findings.push(`transfer ${transfer.doc_no} points at an entry with no lines`);
          continue;
        }
        const credit = lines
          .filter((line) => line.account_code === transfer.from_account_code)
          .reduce((acc, line) => acc.plus(new Decimal(line.credit_bdt ?? 0)), new Decimal(0));
        const debit = lines
          .filter((line) => line.account_code === transfer.to_account_code)
          .reduce((acc, line) => acc.plus(new Decimal(line.debit_bdt ?? 0)), new Decimal(0));
        const expected = new Decimal(transfer.amount_bdt ?? 0).plus(transfer.fee_bdt ?? 0);

        if (!credit.equals(expected)) {
          findings.push(
            `transfer ${transfer.doc_no}: ${transfer.from_account_code} was credited ${credit.toFixed(2)} but the transfer says ${expected.toFixed(2)}`,
          );
        }
        if (!debit.equals(new Decimal(transfer.amount_bdt ?? 0))) {
          findings.push(
            `transfer ${transfer.doc_no}: ${transfer.to_account_code} was debited ${debit.toFixed(2)} but the transfer moved ${new Decimal(transfer.amount_bdt ?? 0).toFixed(2)}`,
          );
        }
      }

      for (const line of corrected) {
        if (!line.adjustment_entry_id) {
          findings.push(
            `statement line ${String(line._id)} (${line.date}, ${line.direction} ${line.amount_bdt}) is marked corrected but posted nothing`,
          );
        }
      }

      return findings.length === 0 ? pass(checked) : fail(checked, findings.slice(0, 20));
    },
  },
  {
    id: "I3-BALANCE-SHEET",
    title: "Assets = liabilities + equity + revenue − expenses",
    since: "P1",
    run: async () => {
      // The type table is tiny and fixed, so the equation is applied in JS over
      // the four aggregates rather than encoded as nested $switch — readable,
      // and it uses the same decimal library as everything else.
      const byType = new Map<string, { debit: Decimal; credit: Decimal }>();

      const raw = await JournalLineModel.aggregate<{
        _id: string | null;
        debit: unknown;
        credit: unknown;
      }>([
        { $lookup: { from: "journalentries", localField: "entry_id", foreignField: "_id", as: "entry" } },
        { $unwind: "$entry" },
        { $match: { "entry.status": { $in: inBooksEntryStatus } } },
        { $lookup: { from: "coaaccounts", localField: "account_id", foreignField: "_id", as: "account" } },
        { $unwind: "$account" },
        {
          $group: {
            _id: "$account.type",
            debit: { $sum: { $toDecimal: "$debit_bdt" } },
            credit: { $sum: { $toDecimal: "$credit_bdt" } },
          },
        },
        { $addFields: { debit: { $toString: "$debit" }, credit: { $toString: "$credit" } } },
      ]);

      for (const row of raw) {
        if (!row._id) continue;
        byType.set(row._id, { debit: new Decimal(String(row.debit)), credit: new Decimal(String(row.credit)) });
      }

      if (byType.size === 0) return skip(NOT_YET_BUILT);

      const net = (type: string, debitNormal: boolean): Decimal => {
        const entry = byType.get(type);
        if (!entry) return new Decimal(0);
        return debitNormal ? entry.debit.minus(entry.credit) : entry.credit.minus(entry.debit);
      };

      const assets = net("ASSET", true);
      const liabilities = net("LIABILITY", false);
      const equity = net("EQUITY", false);
      const revenue = net("REVENUE", false);
      const expenses = net("EXPENSE", true);

      const equation = assets.minus(liabilities).minus(equity).minus(revenue).plus(expenses);

      return equation.isZero()
        ? pass(raw.length)
        : fail(raw.length, [`accounting equation out by ${equation.toFixed(2)}`]);
    },
  },
];

/**
 * Run every check.
 *
 * Safe against production data: reads only. A check that throws is reported as
 * a failure rather than swallowed, because a broken check silently passing is
 * the same as having no check.
 */
export async function runIntegrityChecks(): Promise<IntegrityReport> {
  const startedAt = Date.now();
  const checks: CheckResult[] = [];

  for (const check of CHECKS) {
    try {
      const outcome = await check.run();
      checks.push({ id: check.id, title: check.title, since: check.since, ...outcome });
    } catch (error) {
      checks.push({
        id: check.id,
        title: check.title,
        since: check.since,
        status: "fail",
        checked: 0,
        findings: [`check errored: ${error instanceof Error ? error.message : String(error)}`],
      });
    }
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    ran_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    checks,
  };
}
