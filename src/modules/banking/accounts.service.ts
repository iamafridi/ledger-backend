/**
 * Bank & cash accounts — the treasury view of the chart (plan §6, Phase 6).
 *
 * A TREASURY ACCOUNT IS A CHART ACCOUNT, SEEN DIFFERENTLY
 * This module deliberately owns no balance. Every figure it returns is read from
 * the journal through `banking.ledger.ts`, so the number on the banking screen
 * and the line on the trial balance are the same number. What it *does* own is
 * the mapping: which chart account is "the City Bank current account", and the
 * details a transfer needs printed (branch, account number, SWIFT). The database
 * enforces that mapping 1:1, because a chart account with two treasury rows
 * behind it would make "the bank balance" ambiguous for good.
 *
 * WHY THE CHART ACCOUNT MUST ALREADY EXIST
 * Cash and bank are asset accounts, and the ledger resolved them by code long
 * before this phase (`CONTROL_ACCOUNT.CASH`/`BANK` are 1000 and 1010, and
 * receipts and payments post to them). If this module invented chart accounts,
 * there would be two ways to create one and two places for the chart to drift.
 * So a new treasury account picks an existing asset account, and the error
 * message says exactly which kind of account it must be.
 */
import { z } from "zod";
import type { Types } from "mongoose";

import { BankAccountModel, StatementLineModel, type BankAccountDocument } from "./banking.model.js";
import { accountBalance } from "./banking.ledger.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import { requireAccountByCode } from "../coa/coa.service.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, sub } from "../../core/money.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const CreateBankAccountSchema = z.object({
  kind: z.enum(["BANK", "CASH"]).default("BANK"),
  name: z.string().trim().min(2, "Give the account a name.").max(120),
  /** The chart account this maps onto. Must be an asset account that is not
   *  already carrying a receivable, stock, VAT or fixed asset. */
  account_code: z.string().trim().min(1, "Pick the chart account this backs onto.").max(24),
  bank_name: z.string().trim().max(120).default(""),
  branch: z.string().trim().max(120).default(""),
  account_number: z.string().trim().max(40).default(""),
  routing_number: z.string().trim().max(40).default(""),
  swift_code: z.string().trim().max(20).default(""),
  memo: z.string().trim().max(300).default(""),
});

export const UpdateBankAccountSchema = CreateBankAccountSchema.omit({ account_code: true })
  .partial()
  .extend({ is_active: z.boolean().optional() });

export type CreateBankAccountInput = z.output<typeof CreateBankAccountSchema>;
export type UpdateBankAccountInput = z.output<typeof UpdateBankAccountSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface BankAccountView {
  id: string;
  kind: "BANK" | "CASH";
  name: string;
  account_code: string;
  account_name: string;
  bank_name: string;
  branch: string;
  account_number: string;
  routing_number: string;
  swift_code: string;
  /** What the ledger says the account holds — never a stored figure. */
  book_balance_bdt: string;
  /** The closing balance of the last imported statement, and the date it was
   *  drawn at. Blank until a statement has been imported. */
  last_statement_balance_bdt: string;
  last_statement_date: string;
  /** The gap reconciliation exists to explain: book − last statement. */
  difference_bdt: string;
  /** Statement lines nobody has decided about yet. A screen that shows a bank
   *  balance without this number is inviting somebody to trust a stale file. */
  unreconciled_count: number;
  is_active: boolean;
  memo: string;
}

/** Chart subtypes that are assets but plainly not treasury. Refusing them is
 *  the difference between "money the bank holds" and "an asset", which is the
 *  only thing a cash position is allowed to mean. */
const NON_TREASURY_SUBTYPES = ["AR", "INVENTORY", "VAT_INPUT", "FIXED_ASSET", "ACCUM_DEPRECIATION"];

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: number }).code === 11000
  );
}

/**
 * Resolve a chart account a treasury row may point at.
 *
 * ASSET and not one of the non-treasury subtypes. A revenue account here would
 * make the cash position count sales, and an AR account would double-count a
 * receivable — both failures that look like a working screen until somebody adds
 * the column up.
 */
export async function requireTreasuryAccount(orgId: string, code: string) {
  const account = await requireAccountByCode(orgId, code);
  if (account.type !== "ASSET") {
    throw new AppError(
      422,
      "ACCOUNT_NOT_ASSET",
      `${account.code} (${account.name}) is a ${account.type.toLowerCase()} account. Cash and bank accounts must be assets — 1000 or 1010 in the standard chart.`,
    );
  }
  if (NON_TREASURY_SUBTYPES.includes(account.subtype ?? "")) {
    throw new AppError(
      422,
      "ACCOUNT_NOT_TREASURY",
      `${account.code} (${account.name}) is a ${account.subtype} control account and cannot be a bank or cash account. Create a plain asset account for it.`,
    );
  }
  return account;
}

/* ── Writes ──────────────────────────────────────────────────────────────── */

export async function createBankAccount(
  orgId: string,
  uid: string,
  input: CreateBankAccountInput,
  ip?: string,
): Promise<BankAccountView> {
  const account = await requireTreasuryAccount(orgId, input.account_code);

  try {
    const created = await BankAccountModel.create({
      org_id: orgId,
      kind: input.kind,
      name: input.name,
      account_code: account.code,
      account_name: account.name,
      bank_name: input.bank_name,
      branch: input.branch,
      account_number: input.account_number,
      routing_number: input.routing_number,
      swift_code: input.swift_code,
      memo: input.memo,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });

    const view = await viewOf(orgId, created.toObject());
    await writeAudit({
      orgId,
      uid,
      entity: "banking.account",
      entityId: view.id,
      action: "BANK_ACCOUNT_CREATED",
      after: { name: view.name, kind: view.kind, account_code: view.account_code },
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(
        409,
        "ACCOUNT_ALREADY_MAPPED",
        `Account ${account.code} is already set up as a bank or cash account. Each chart account maps to one.`,
      );
    }
    throw error;
  }
}

export async function updateBankAccount(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateBankAccountInput,
  ip?: string,
): Promise<BankAccountView> {
  const existing = await BankAccountModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That bank account does not exist.");

  const patch: Record<string, unknown> = {};
  for (const field of ["kind", "name", "bank_name", "branch", "account_number", "routing_number", "swift_code", "memo", "is_active"] as const) {
    if (input[field] !== undefined) patch[field] = input[field];
  }
  if (Object.keys(patch).length === 0) return viewOf(orgId, existing);

  patch["updated_by"] = uid;
  const updated = await BankAccountModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw notFoundError("That bank account does not exist.");

  const before = await viewOf(orgId, existing);
  const view = await viewOf(orgId, updated);
  await writeAudit({
    orgId,
    uid,
    entity: "banking.account",
    entityId: view.id,
    action: "BANK_ACCOUNT_UPDATED",
    before: { name: before.name, kind: before.kind, is_active: before.is_active },
    after: { name: view.name, kind: view.kind, is_active: view.is_active },
    ...(ip ? { ip } : {}),
  });
  return view;
}

/**
 * Deactivate — never delete.
 *
 * A treasury row that disappears takes its statement history with it, and the
 * lines would then be orphaned against an account nobody can open. Deactivating
 * keeps the workspace readable and simply stops the account being picked for new
 * transfers.
 */
export async function deactivateBankAccount(
  orgId: string,
  uid: string,
  id: string,
  ip?: string,
): Promise<BankAccountView> {
  const existing = await BankAccountModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That bank account does not exist.");
  if (existing.is_active === false) return viewOf(orgId, existing);

  const updated = await BankAccountModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: { is_active: false, updated_by: uid } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That bank account does not exist.");

  const view = await viewOf(orgId, updated);
  await writeAudit({
    orgId,
    uid,
    entity: "banking.account",
    entityId: view.id,
    action: "BANK_ACCOUNT_DEACTIVATED",
    before: { is_active: true },
    after: { is_active: false },
    ...(ip ? { ip } : {}),
  });
  return view;
}

/**
 * The two accounts every organisation starts with.
 *
 * Called from org bootstrap, right after the chart is seeded, so a new ledger
 * has a working banking screen instead of an empty one — the same reasoning that
 * gives signup a full chart and a fiscal year. Idempotent by the unique
 * `(org_id, account_code)` index, so a retried bootstrap creates nothing twice.
 */
export async function ensureDefaultBankAccounts(
  orgId: string | Types.ObjectId,
  uid: string,
): Promise<number> {
  const defaults: Array<{ kind: "BANK" | "CASH"; name: string; account_code: string }> = [
    { kind: "CASH", name: "Cash on Hand", account_code: CONTROL_ACCOUNT.CASH },
    { kind: "BANK", name: "Bank Account", account_code: CONTROL_ACCOUNT.BANK },
  ];

  let created = 0;
  for (const item of defaults) {
    const account = await CoaAccountModel.findOne({ org_id: orgId, code: item.account_code }).lean();
    if (!account) continue;

    try {
      await BankAccountModel.create({
        org_id: orgId,
        kind: item.kind,
        name: item.name,
        account_code: account.code,
        account_name: account.name,
        created_by: uid,
        updated_by: uid,
      });
      created += 1;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
  return created;
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function getBankAccount(orgId: string, id: string): Promise<BankAccountView> {
  const doc = await BankAccountModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That bank account does not exist.");
  return viewOf(orgId, doc);
}

export async function listBankAccounts(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<BankAccountView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = true;

  const rows = await BankAccountModel.find(filter).sort({ kind: 1, account_code: 1 }).lean();
  return Promise.all(rows.map((row) => viewOf(orgId, row)));
}

export interface CashPositionView {
  as_of: string;
  accounts: BankAccountView[];
  total_bdt: string;
  /** The same figure read the way the P5 cash-position report reads it (every
   *  cash/bank *chart* account, mapped or not). The two must agree; the smoke
   *  script asserts it, and a gap means an account exists in one view only. */
  ledger_total_bdt: string;
}

/**
 * What is in the till and the bank, right now.
 *
 * `ledger_total_bdt` is deliberately included: it is the same position computed
 * from the chart's own cash/bank accounts rather than from the treasury rows. If
 * somebody has a cash account in the chart with no treasury mapping, the total
 * and this figure differ, and that difference is visible rather than silent.
 */
export async function cashPosition(orgId: string, asOf?: string): Promise<CashPositionView> {
  const to = asOf ?? todayInLedgerZone();
  const accounts = await listBankAccounts(orgId);

  const total = accounts.reduce((acc, account) => acc.plus(money(account.book_balance_bdt)), money(0));

  const chartAccounts = await CoaAccountModel.find({
    org_id: orgId,
    type: "ASSET",
    subtype: { $in: ["CASH", "BANK"] },
  })
    .sort({ code: 1 })
    .lean();

  let ledgerTotal = money(0);
  for (const account of chartAccounts) {
    ledgerTotal = ledgerTotal.plus(await accountBalance(orgId, account.code, to));
  }

  return {
    as_of: to,
    accounts,
    total_bdt: fmt(total),
    ledger_total_bdt: fmt(ledgerTotal),
  };
}

/** Shape one stored row into a view, reading the balances it cannot own. */
async function viewOf(
  orgId: string,
  doc: BankAccountDocument & { _id: Types.ObjectId },
): Promise<BankAccountView> {
  const [balance, unreconciled] = await Promise.all([
    accountBalance(orgId, doc.account_code),
    StatementLineModel.countDocuments({
      org_id: orgId,
      bank_account_id: doc._id,
      status: "UNMATCHED",
    }),
  ]);

  const statementBalance = doc.last_statement_balance_bdt ?? "";
  return {
    id: String(doc._id),
    kind: doc.kind,
    name: doc.name,
    account_code: doc.account_code,
    account_name: doc.account_name ?? "",
    bank_name: doc.bank_name ?? "",
    branch: doc.branch ?? "",
    account_number: doc.account_number ?? "",
    routing_number: doc.routing_number ?? "",
    swift_code: doc.swift_code ?? "",
    book_balance_bdt: fmt(balance),
    last_statement_balance_bdt: statementBalance,
    last_statement_date: doc.last_statement_date ?? "",
    difference_bdt: statementBalance === "" ? "" : fmt(sub(balance, money(statementBalance))),
    unreconciled_count: unreconciled,
    is_active: doc.is_active !== false,
    memo: doc.memo ?? "",
  };
}
