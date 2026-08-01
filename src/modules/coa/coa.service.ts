/**
 * Chart of accounts — the service every posting path resolves through.
 *
 * Two rules do most of the work here:
 *
 * 1. **System accounts are locked by code and type, not by name.** Services find
 *    them by code (see `CONTROL_ACCOUNT`), so allowing a code to change would
 *    break posting for that organisation in a way that only surfaces on the next
 *    receipt. Relabelling one is harmless and stays allowed.
 *
 * 2. **Nothing with history is deleted.** An account that has postings or
 *    children is deactivated instead. Deleting it would leave every historical
 *    report that joins to it orphaned — the balances would still sum, they would
 *    just have nowhere to point, which is worse than an obvious failure.
 */
import { z } from "zod";
import type { Types } from "mongoose";

import { CoaAccountModel, type CoaAccountDocument } from "./coa.model.js";
import { MasterCategoryModel } from "../masterdata/catalogs.model.js";
import { CHART_TEMPLATE, CATEGORY_ACCOUNT_CODE, CONTROL_ACCOUNT } from "./coa-seed.js";
import { writeAudit } from "../../core/audit.js";
import { AppError, notFoundError, validationError } from "../../shared/errors/app-error.js";

export const AccountTypeInput = z.enum(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"]);
export const NormalBalanceInput = z.enum(["DEBIT", "CREDIT"]);

export const CreateAccountSchema = z.object({
  code: z.string().trim().min(1, "An account needs a code.").max(24),
  name: z.string().trim().min(2, "Give the account a name.").max(120),
  type: AccountTypeInput,
  subtype: z.string().trim().max(40).default(""),
  parent_code: z.string().trim().max(24).optional(),
  normal_balance: NormalBalanceInput,
});

export const UpdateAccountSchema = z
  .object({
    name: z.string().trim().min(2, "Give the account a name.").max(120),
    subtype: z.string().trim().max(40),
    parent_code: z.string().trim().max(24).nullable(),
    is_active: z.boolean(),
  })
  .partial();

export type CreateAccountInput = z.output<typeof CreateAccountSchema>;
export type UpdateAccountInput = z.output<typeof UpdateAccountSchema>;

export interface AccountView {
  id: string;
  code: string;
  name: string;
  type: string;
  subtype: string;
  parent_id: string | null;
  normal_balance: string;
  is_system: boolean;
  is_active: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(doc: any): AccountView {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    type: doc.type,
    subtype: doc.subtype ?? "",
    parent_id: doc.parent_id ? String(doc.parent_id) : null,
    normal_balance: doc.normal_balance,
    is_system: Boolean(doc.is_system),
    is_active: doc.is_active !== false,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

/**
 * Give an organisation its starting chart.
 *
 * Idempotent by the unique (org, code) index: a re-run that finds the code
 * already present moves on rather than failing or duplicating. Seeding is
 * therefore safe to call from more than one place — and it is called from org
 * creation, where a retry after a partial write must not leave a half chart.
 */
export async function ensureChartOfAccounts(
  orgId: string | Types.ObjectId,
  uid: string,
): Promise<number> {
  let created = 0;

  for (const template of CHART_TEMPLATE) {
    try {
      await CoaAccountModel.create({
        org_id: orgId,
        code: template.code,
        name: template.name,
        type: template.type,
        subtype: template.subtype,
        parent_id: null,
        normal_balance: template.normal_balance,
        is_system: Boolean(template.system),
        is_active: true,
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

export async function listAccounts(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<AccountView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = true;

  const rows = await CoaAccountModel.find(filter).sort({ code: 1 }).lean();
  return rows.map(toView);
}

/** Resolve one account by its code, or throw a message that names the code. */
export async function requireAccountByCode(
  orgId: string | Types.ObjectId,
  code: string,
  options: { mustBeActive?: boolean } = {},
): Promise<CoaAccountDocument & { _id: Types.ObjectId }> {
  const account = await CoaAccountModel.findOne({ org_id: orgId, code }).lean();
  if (!account) {
    throw new AppError(422, "ACCOUNT_NOT_FOUND", `No account with code ${code} exists in this ledger.`);
  }
  if (options.mustBeActive !== false && account.is_active === false) {
    throw new AppError(422, "ACCOUNT_INACTIVE", `Account ${code} (${account.name}) is inactive.`);
  }
  return account as CoaAccountDocument & { _id: Types.ObjectId };
}

/** The account a personal-ledger category posts to (plan §4, D3). */
export async function accountForCategory(
  orgId: string | Types.ObjectId,
  category: string,
): Promise<CoaAccountDocument & { _id: Types.ObjectId }> {
  // The organisation's own category row wins: the catalog screen lets a user
  // remap "Food" to a different expense account, and a mapping that is editable
  // in the UI but ignored by the posting path would be a lie. The model is
  // imported directly rather than through the catalogs service to keep this
  // module free of a cycle — that service validates against this one.
  const master = await MasterCategoryModel.findOne({
    org_id: orgId,
    kind: "EXPENSE",
    name: category,
    is_active: true,
  }).lean();

  const templateCode = CATEGORY_ACCOUNT_CODE[category] ?? CONTROL_ACCOUNT.CASH;
  if (!master || master.account_code === templateCode) {
    return requireAccountByCode(orgId, templateCode);
  }

  try {
    return await requireAccountByCode(orgId, master.account_code);
  } catch {
    // The custom mapping points at an account that has since been deactivated.
    // Falling back keeps the expense bridge working (an unmapped expense is the
    // silent failure this whole design avoids); the user's edit is what is
    // stale, not the transaction.
    console.warn(
      `[coa] category ${category} maps to ${master.account_code}, which no longer resolves — using ${templateCode}.`,
    );
    return requireAccountByCode(orgId, templateCode);
  }
}

export async function createAccount(
  orgId: string,
  uid: string,
  input: CreateAccountInput,
  ip?: string,
): Promise<AccountView> {
  let parent_id: Types.ObjectId | null = null;
  if (input.parent_code) {
    parent_id = (await requireAccountByCode(orgId, input.parent_code))._id;
  }

  try {
    const created = await CoaAccountModel.create({
      org_id: orgId,
      code: input.code,
      name: input.name,
      type: input.type,
      subtype: input.subtype,
      parent_id,
      normal_balance: input.normal_balance,
      is_system: false,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });
    const view = toView(created.toObject());

    await writeAudit({
      orgId,
      uid,
      entity: "coa.account",
      entityId: view.id,
      action: "ACCOUNT_CREATED",
      after: view,
      ...(ip ? { ip } : {}),
    });

    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "ACCOUNT_CODE_TAKEN", `Code ${input.code} is already used in this ledger.`);
    }
    throw error;
  }
}

/**
 * PATCH semantics. A system account accepts only its name — everything else
 * about it is what the posting engine resolves on, and silently repointing it
 * would move every future receipt to a different account while old reports
 * still read the old one.
 */
export async function updateAccount(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateAccountInput,
  ip?: string,
): Promise<AccountView> {
  const existing = await CoaAccountModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That account does not exist.");

  const before = toView(existing);
  const patch: Record<string, unknown> = {};

  if (input.name !== undefined) patch["name"] = input.name;

  if (existing.is_system !== true) {
    if (input.subtype !== undefined) patch["subtype"] = input.subtype;
    if (input.is_active !== undefined) patch["is_active"] = input.is_active;
    if (input.parent_code !== undefined) {
      patch["parent_id"] = input.parent_code
        ? (await requireAccountByCode(orgId, input.parent_code))._id
        : null;
    }
  } else if (
    input.subtype !== undefined ||
    input.is_active !== undefined ||
    input.parent_code !== undefined
  ) {
    throw new AppError(
      422,
      "SYSTEM_ACCOUNT_LOCKED",
      "This account is part of the ledger's own structure. Its name can be changed; its code, type and active state cannot.",
    );
  }

  if (Object.keys(patch).length === 0) return before;
  patch["updated_by"] = uid;

  const updated = await CoaAccountModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw notFoundError("That account does not exist.");

  const view = toView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "coa.account",
    entityId: view.id,
    action: "ACCOUNT_UPDATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

/**
 * Deactivate — never delete.
 *
 * Refused while anything still points at the account: a balance on it, or a
 * child beneath it. Both would leave an orphan, and an orphaned balance is the
 * failure mode that makes a trial balance quietly stop adding up.
 */
export async function deactivateAccount(
  orgId: string,
  uid: string,
  id: string,
  ip?: string,
): Promise<AccountView> {
  const existing = await CoaAccountModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That account does not exist.");

  if (existing.is_system === true) {
    throw new AppError(
      422,
      "SYSTEM_ACCOUNT_LOCKED",
      "This account is part of the ledger's own structure and cannot be deactivated.",
    );
  }

  const [children, postings] = await Promise.all([
    CoaAccountModel.countDocuments({ org_id: orgId, parent_id: existing._id }),
    countPostings(orgId, existing._id),
  ]);

  if (children > 0) {
    throw validationError("Move or remove its sub-accounts first — this one still has children under it.");
  }
  if (postings > 0) {
    throw validationError(
      "This account already has entries against it. Deactivate it instead of removing it so its history stays readable.",
    );
  }

  const before = toView(existing);
  const updated = await CoaAccountModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: { is_active: false, updated_by: uid } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That account does not exist.");

  const view = toView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "coa.account",
    entityId: view.id,
    action: "ACCOUNT_DEACTIVATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

/**
 * Postings against an account.
 *
 * The journal module does not exist until the same phase as this file, so the
 * count is taken lazily — an account service that hard-imported journals would
 * create a cycle (journals resolve accounts through here).
 */
async function countPostings(orgId: string | Types.ObjectId, accountId: unknown): Promise<number> {
  const { JournalLineModel } = await import("../journals/journal.model.js");
  return JournalLineModel.countDocuments({ org_id: orgId, account_id: accountId });
}
