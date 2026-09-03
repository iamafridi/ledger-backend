/**
 * Parties — customers and suppliers (plan §2, P2).
 *
 * What this module refuses to do is as important as what it does:
 *
 *   - **No hard delete.** A party that has ever been named on a document must
 *     keep resolving, so the only removal is deactivation.
 *   - **The code is fixed after creation.** It is the handle documents quote,
 *     and a code that changes meaning is worse than no code at all.
 *   - **The control account must suit the party's kind.** A customer's balance
 *     is an asset (money owed to you), a supplier's is a liability (money you
 *     owe). Accepting either for either would let the sub-ledger and the control
 *     account disagree — which is exactly the drift integrity check I5 exists to
 *     catch, and much cheaper to prevent here than to reconcile there.
 */
import { z } from "zod";

import { PartyModel } from "./parties.model.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { listAccounts, requireAccountByCode } from "../coa/coa.service.js";
import { writeAudit } from "../../core/audit.js";
import { AppError, notFoundError, validationError } from "../../shared/errors/app-error.js";
import { MoneyInput } from "../../shared/validation/schemas.js";

export const PartyKindInput = z.enum(["CUSTOMER", "SUPPLIER", "BOTH"]);

/** Blank e-mail is allowed and common; a present one must look like one. */
const EmailInput = z
  .string()
  .trim()
  .max(200)
  .refine((value) => value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value), "That does not look like an e-mail address.")
  .default("");

export const CreatePartySchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "A party needs a code.")
    .max(24)
    .regex(/^[A-Za-z0-9-]+$/, "Codes are letters, digits and dashes."),
  name: z.string().trim().min(2, "Give the party a name.").max(120),
  kind: PartyKindInput.default("BOTH"),
  email: EmailInput,
  phone: z.string().trim().max(40).default(""),
  address: z.string().trim().max(300).default(""),
  /** Blank picks the conventional control account for the kind (1100 / 2000). */
  control_account_code: z.string().trim().max(24).default(""),
  /** "0.00" means no limit is set; P3 warns rather than blocks either way. */
  credit_limit_bdt: MoneyInput.default("0.00"),
});

/** The `code` is absent on purpose — see the header. */
export const UpdatePartySchema = CreatePartySchema.omit({ code: true }).partial();

export type CreatePartyInput = z.output<typeof CreatePartySchema>;
export type UpdatePartyInput = z.output<typeof UpdatePartySchema>;

export interface PartyView {
  id: string;
  code: string;
  name: string;
  kind: "CUSTOMER" | "SUPPLIER" | "BOTH";
  email: string;
  phone: string;
  address: string;
  control_account_code: string;
  control_account_name: string;
  credit_limit_bdt: string;
  is_active: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(doc: any, controlAccountName = ""): PartyView {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    kind: doc.kind,
    email: doc.email ?? "",
    phone: doc.phone ?? "",
    address: doc.address ?? "",
    control_account_code: doc.control_account_code,
    control_account_name: controlAccountName,
    credit_limit_bdt: doc.credit_limit_bdt ?? "0.00",
    is_active: doc.is_active !== false,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

function assertId(id: string): void {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) throw notFoundError("That party does not exist.");
}

/** The control account's display name for an audit row, best effort — an
 *  account renamed or removed since never fails the write, it just shows blank. */
async function accountNameFor(orgId: string, code: string): Promise<string> {
  const account = await CoaAccountModel.findOne({ org_id: orgId, code }).lean();
  return account?.name ?? "";
}

/** The conventional control account when a form leaves the field blank. */
const CONTROL_BY_KIND: Record<"CUSTOMER" | "SUPPLIER" | "BOTH", string> = {
  CUSTOMER: "1100",
  SUPPLIER: "2000",
  BOTH: "1100",
};

const ACCOUNT_TYPE_BY_KIND = {
  CUSTOMER: ["ASSET"],
  SUPPLIER: ["LIABILITY"],
  BOTH: ["ASSET", "LIABILITY"],
} as const;

async function resolveControlAccount(
  orgId: string,
  kind: "CUSTOMER" | "SUPPLIER" | "BOTH",
  code: string,
) {
  const account = await requireAccountByCode(orgId, code || CONTROL_BY_KIND[kind]);
  if (!(ACCOUNT_TYPE_BY_KIND[kind] as readonly string[]).includes(account.type)) {
    throw validationError(
      kind === "SUPPLIER"
        ? `A supplier's balance is money you owe, so ${account.code} (${account.name}) is the wrong side of the ledger — use a liability account such as 2000 Accounts Payable.`
        : `A customer's balance is money owed to you, so ${account.code} (${account.name}) is the wrong side of the ledger — use an asset account such as 1100 Accounts Receivable.`,
    );
  }
  return account;
}

export async function listParties(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<PartyView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = true;
  const rows = await PartyModel.find(filter).sort({ code: 1 }).lean();
  if (rows.length === 0) return [];

  const accounts = await listAccounts(orgId, { includeInactive: true });
  const names = new Map(accounts.map((account) => [account.code, account.name]));
  return rows.map((row) => toView(row, names.get(row.control_account_code) ?? ""));
}

export async function createParty(
  orgId: string,
  uid: string,
  input: CreatePartyInput,
  ip?: string,
): Promise<PartyView> {
  const account = await resolveControlAccount(orgId, input.kind, input.control_account_code);

  try {
    const created = await PartyModel.create({
      org_id: orgId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      email: input.email,
      phone: input.phone,
      address: input.address,
      control_account_code: account.code,
      credit_limit_bdt: input.credit_limit_bdt,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });
    const view = toView(created.toObject(), account.name);

    await writeAudit({
      orgId,
      uid,
      entity: "masterdata.party",
      entityId: view.id,
      action: "PARTY_CREATED",
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "PARTY_CODE_TAKEN", `Code ${input.code} is already used in this ledger.`);
    }
    throw error;
  }
}

export async function updateParty(
  orgId: string,
  uid: string,
  id: string,
  input: UpdatePartyInput,
  ip?: string,
): Promise<PartyView> {
  assertId(id);
  const existing = await PartyModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That party does not exist.");

  const kind = input.kind ?? existing.kind;
  const before = toView(existing, await accountNameFor(orgId, existing.control_account_code));

  const patch: Record<string, unknown> = { updated_by: uid };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.kind !== undefined) patch["kind"] = input.kind;
  if (input.email !== undefined) patch["email"] = input.email;
  if (input.phone !== undefined) patch["phone"] = input.phone;
  if (input.address !== undefined) patch["address"] = input.address;
  if (input.credit_limit_bdt !== undefined) patch["credit_limit_bdt"] = input.credit_limit_bdt;

  let controlAccountName = "";
  if (input.control_account_code !== undefined || input.kind !== undefined) {
    const account = await resolveControlAccount(
      orgId,
      kind,
      input.control_account_code ?? existing.control_account_code,
    );
    patch["control_account_code"] = account.code;
    controlAccountName = account.name;
  }

  const updated = await PartyModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw notFoundError("That party does not exist.");

  const view = toView(updated, controlAccountName);
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.party",
    entityId: view.id,
    action: "PARTY_UPDATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

export async function deactivateParty(orgId: string, uid: string, id: string, ip?: string): Promise<PartyView> {
  assertId(id);
  const existing = await PartyModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That party does not exist.");
  const before = toView(existing, await accountNameFor(orgId, existing.control_account_code));

  const updated = await PartyModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: { is_active: false, updated_by: uid } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That party does not exist.");

  const view = toView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.party",
    entityId: view.id,
    action: "PARTY_DEACTIVATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}
