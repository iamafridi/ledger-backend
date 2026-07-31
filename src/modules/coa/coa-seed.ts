/**
 * The reference chart every new organisation starts with.
 *
 * Why a fixed template rather than letting people invent codes: the posting
 * engine resolves accounts by **subtype** at the moment of posting (a receipt
 * needs to know which account is cash), and an empty chart means every module
 * fails in a different, confusing way. A new organisation therefore gets a
 * working chart on signup, can rename any label it dislikes, and can add its
 * own accounts alongside.
 *
 * `system: true` accounts are the ones services resolve by code. Their code,
 * type and normal balance are load-bearing and locked; their name is not.
 *
 * The shape follows the plan's convention — 1xxx assets, 2xxx liabilities,
 * 3xxx equity, 4xxx revenue, 5xxx expenses — because a trial balance should be
 * readable top to bottom without a key.
 */
export interface TemplateAccount {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  subtype: string;
  normal_balance: "DEBIT" | "CREDIT";
  system?: boolean;
}

export const CHART_TEMPLATE: TemplateAccount[] = [
  // ── Assets ────────────────────────────────────────────────────────────────
  { code: "1000", name: "Cash on Hand", type: "ASSET", subtype: "CASH", normal_balance: "DEBIT", system: true },
  { code: "1010", name: "Bank Account", type: "ASSET", subtype: "BANK", normal_balance: "DEBIT", system: true },
  { code: "1100", name: "Accounts Receivable", type: "ASSET", subtype: "AR", normal_balance: "DEBIT", system: true },
  { code: "1200", name: "Inventory", type: "ASSET", subtype: "INVENTORY", normal_balance: "DEBIT", system: true },
  { code: "1300", name: "VAT Receivable", type: "ASSET", subtype: "VAT_INPUT", normal_balance: "DEBIT", system: true },
  { code: "1500", name: "Fixed Assets", type: "ASSET", subtype: "FIXED_ASSET", normal_balance: "DEBIT", system: true },
  { code: "1510", name: "Accumulated Depreciation", type: "ASSET", subtype: "ACCUM_DEPRECIATION", normal_balance: "CREDIT", system: true },
  { code: "1600", name: "Staff Loans & Advances", type: "ASSET", subtype: "STAFF_LOAN", normal_balance: "DEBIT", system: true },

  // ── Liabilities ───────────────────────────────────────────────────────────
  { code: "2000", name: "Accounts Payable", type: "LIABILITY", subtype: "AP", normal_balance: "CREDIT", system: true },
  { code: "2100", name: "VAT Payable", type: "LIABILITY", subtype: "VAT_OUTPUT", normal_balance: "CREDIT", system: true },
  { code: "2200", name: "Source Tax Payable", type: "LIABILITY", subtype: "WITHHOLDING", normal_balance: "CREDIT", system: true },
  { code: "2300", name: "Salaries Payable", type: "LIABILITY", subtype: "PAYROLL_PAYABLE", normal_balance: "CREDIT", system: true },
  { code: "2500", name: "Loan Payable", type: "LIABILITY", subtype: "LOAN", normal_balance: "CREDIT", system: true },

  // ── Equity ────────────────────────────────────────────────────────────────
  { code: "3000", name: "Owner's Equity", type: "EQUITY", subtype: "CAPITAL", normal_balance: "CREDIT", system: true },
  { code: "3100", name: "Retained Earnings", type: "EQUITY", subtype: "RETAINED", normal_balance: "CREDIT", system: true },

  // ── Revenue ───────────────────────────────────────────────────────────────
  { code: "4000", name: "Sales Revenue", type: "REVENUE", subtype: "SALES", normal_balance: "CREDIT", system: true },
  { code: "4100", name: "Other Income", type: "REVENUE", subtype: "OTHER_INCOME", normal_balance: "CREDIT", system: true },

  // ── Expenses ──────────────────────────────────────────────────────────────
  { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE", subtype: "COGS", normal_balance: "DEBIT", system: true },
  { code: "5100", name: "Salaries Expense", type: "EXPENSE", subtype: "PAYROLL", normal_balance: "DEBIT", system: true },
  { code: "5200", name: "Rent Expense", type: "EXPENSE", subtype: "RENT", normal_balance: "DEBIT", system: true },
  { code: "5300", name: "Utilities Expense", type: "EXPENSE", subtype: "UTILITIES", normal_balance: "DEBIT", system: true },
  { code: "5400", name: "Depreciation Expense", type: "EXPENSE", subtype: "DEPRECIATION", normal_balance: "DEBIT", system: true },
  { code: "5500", name: "Bank Charges", type: "EXPENSE", subtype: "BANK_CHARGE", normal_balance: "DEBIT", system: true },
  { code: "5600", name: "Waste & Shrinkage", type: "EXPENSE", subtype: "WASTE", normal_balance: "DEBIT", system: true },
  { code: "5700", name: "Insurance Expense", type: "EXPENSE", subtype: "INSURANCE", normal_balance: "DEBIT", system: true },
  { code: "5800", name: "Miscellaneous Expense", type: "EXPENSE", subtype: "MISC", normal_balance: "DEBIT", system: true },
];

/**
 * The expense account each personal-ledger category posts to (plan §4, D3 —
 * personal expenses hit the general ledger so the dashboard and the books
 * cannot disagree).
 *
 * Categories without a natural home land in 5800 rather than being dropped:
 * an unmapped category would mean a real expense that never reaches the trial
 * balance, which is precisely the silent failure this whole design avoids.
 */
export const CATEGORY_ACCOUNT_CODE: Record<string, string> = {
  Clothing: "5800",
  Education: "5800",
  Entertainment: "5800",
  Food: "5800",
  Groceries: "5000",
  Health: "5800",
  Mobile: "5300",
  Rent: "5200",
  Transport: "5800",
  Utilities: "5300",
  Other: "5800",
};

/** Codes that must exist before a given phase can post. Used by the integrity
 *  run and by services that resolve a control account and need a clear answer
 *  when the tenant has deactivated it. */
export const CONTROL_ACCOUNT = {
  CASH: "1000",
  BANK: "1010",
  AR: "1100",
  INVENTORY: "1200",
  VAT_INPUT: "1300",
  AP: "2000",
  VAT_OUTPUT: "2100",
  WITHHOLDING: "2200",
  CAPITAL: "3000",
  RETAINED: "3100",
  SALES: "4000",
  COGS: "5000",
  /** Where a stock adjustment or a stocktake variance posts (P8). 5600 Waste &
   *  Shrinkage is exactly what a write-off is, and a count that finds *more*
   *  than the book says simply reverses it. */
  STOCK_ADJUSTMENT: "5600",
  /** The fixed-asset register (P9). 1500 holds the cost of everything owned and
   *  not yet disposed of, 1510 holds the total written off against it, and the
   *  difference is the net book value the register reports. The integrity run
   *  asserts those two balances equal the register line for line. */
  FIXED_ASSET: "1500",
  ACCUM_DEPRECIATION: "1510",
  /** Where a month's write-down posts, against the accumulated account above. */
  DEPRECIATION_EXPENSE: "5400",
  /** Payroll (P11). A run posts `DR 5100 Salaries Expense (gross) / CR 2300
   *  Salaries Payable (net) / CR 1600 Staff Loans (recoveries) / CR 4100 (loan
   *  interest) / CR 2200 (withheld tax)`; paying the run moves the payable to
   *  cash. A loan to a member of staff is money the organisation is owed, so it
   *  lives on the asset side in 1600 — 2500 Loan Payable is what the
   *  organisation owes its lenders, the other direction entirely. */
  SALARY_EXPENSE: "5100",
  PAYROLL_PAYABLE: "2300",
  STAFF_LOAN: "1600",
  /** A disposal's default destinations, and deliberately the two accounts the
   *  chart already has rather than a dedicated pair. A chart template only seeds
   *  at signup, so inventing 5900/4200 would leave every ledger created before
   *  this phase without them and refuse a disposal. An asset that wants its own
   *  gain or loss account names one, and both are per asset for exactly that
   *  reason. */
  OTHER_INCOME: "4100",
  MISC_EXPENSE: "5800",
} as const;
