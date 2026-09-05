/**
 * The catalogs: units of measure, tax rates and categories — plus the seed
 * every new organisation starts with.
 *
 * Two rules run through all three:
 *
 * 1. **Codes and names are identity; labels are not.** A tax rate's `code` is
 *    what items and document lines reference, so it is fixed after creation
 *    while its name and percentage stay editable — `VAT15` can become 12%
 *    without breaking a stored document, each of which snapshots the rate it
 *    was issued under (plan §5.4).
 *
 * 2. **Nothing is deleted, only deactivated.** A unit or category already
 *    printed on a document must keep resolving for as long as that document is
 *    in the books.
 *
 * Seeding is idempotent by the unique indexes: a re-run that finds a row
 * already present moves on rather than failing. That is what lets the same
 * function serve signup (`org.service.ts`) and the "seed defaults" button a
 * pre-P2 organisation sees on the catalogs screen.
 */
import { z } from "zod";
import type { Types } from "mongoose";

import {
  MasterCategoryModel,
  TaxRateModel,
  UnitModel,
  type TaxRateDocument,
  type UnitDocument,
} from "./catalogs.model.js";
import { CATEGORY_ACCOUNT_CODE } from "../coa/coa-seed.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { listAccounts, requireAccountByCode } from "../coa/coa.service.js";
import { CATEGORIES } from "../../shared/ocr/types.js";
import { RateInput } from "../../shared/validation/schemas.js";
import { writeAudit } from "../../core/audit.js";
import { AppError, notFoundError, validationError } from "../../shared/errors/app-error.js";

/* ── Schemas ─────────────────────────────────────────────────────────────── */

export const CreateUnitSchema = z.object({
  name: z.string().trim().min(1, "A unit needs a name.").max(40),
  symbol: z.string().trim().min(1, "Give the unit a short symbol.").max(8),
});

export const UpdateUnitSchema = CreateUnitSchema.partial();

/** Which of the two jobs a rate does — see `catalogs.model.ts`. */
export const TaxKindSchema = z.enum(["VAT", "WITHHOLDING"]);

export const CreateTaxRateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "A tax rate needs a code.")
    .max(24)
    .regex(/^[A-Za-z0-9-]+$/, "Codes are letters, digits and dashes."),
  name: z.string().trim().min(1, "Give the rate a name.").max(60),
  rate_percent: RateInput.refine((value) => Number(value) <= 100, "A rate above 100% is not a tax rate."),
  /** Defaulted to VAT so every existing caller and every existing rate keeps
   *  behaving exactly as it did before withholding existed. */
  kind: TaxKindSchema.default("VAT"),
});

/** The `code` is deliberately absent: it is what documents reference. */
export const UpdateTaxRateSchema = z
  .object({
    name: z.string().trim().min(1, "Give the rate a name.").max(60),
    rate_percent: RateInput.refine((value) => Number(value) <= 100, "A rate above 100% is not a tax rate."),
    /** Editable, unlike the code: no stored document points at a *kind*, they
     *  point at the code and snapshot the percentage, so re-classifying a rate
     *  affects the next document rather than restating the last one. */
    kind: TaxKindSchema,
  })
  .partial();

export const CreateCategorySchema = z.object({
  name: z.string().trim().min(1, "A category needs a name.").max(40),
  kind: z.enum(["EXPENSE", "INCOME"]).default("EXPENSE"),
  /** Blank means "use the mapping this name already has in the chart seed". */
  account_code: z.string().trim().max(24).default(""),
});

export const UpdateCategorySchema = CreateCategorySchema.partial();

export type CreateUnitInput = z.output<typeof CreateUnitSchema>;
export type UpdateUnitInput = z.output<typeof UpdateUnitSchema>;
export type CreateTaxRateInput = z.output<typeof CreateTaxRateSchema>;
export type UpdateTaxRateInput = z.output<typeof UpdateTaxRateSchema>;
export type CreateCategoryInput = z.output<typeof CreateCategorySchema>;
export type UpdateCategoryInput = z.output<typeof UpdateCategorySchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface UnitView {
  id: string;
  name: string;
  symbol: string;
  is_active: boolean;
}

export interface TaxRateView {
  id: string;
  code: string;
  name: string;
  /** VAT (adds tax to a line) or WITHHOLDING (deducted from a payment). */
  kind: "VAT" | "WITHHOLDING";
  /** Canonical 2dp string — a rate feeds money arithmetic, so it is never a number. */
  rate_percent: string;
  is_active: boolean;
}

export interface CategoryView {
  id: string;
  name: string;
  kind: "EXPENSE" | "INCOME";
  account_code: string;
  account_name: string;
  is_active: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toUnitView(doc: any): UnitView {
  return { id: String(doc._id), name: doc.name, symbol: doc.symbol, is_active: doc.is_active !== false };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTaxRateView(doc: any): TaxRateView {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    kind: doc.kind === "WITHHOLDING" ? "WITHHOLDING" : "VAT",
    rate_percent: doc.rate_percent,
    is_active: doc.is_active !== false,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toCategoryView(doc: any, accountName = ""): CategoryView {
  return {
    id: String(doc._id),
    name: doc.name,
    kind: doc.kind,
    account_code: doc.account_code,
    account_name: accountName,
    is_active: doc.is_active !== false,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

/** Guard for `:id` paths: a malformed id would otherwise reach Mongo and come
 *  back as a CastError, which the error handler reports as a 500. */
function assertId(id: string): void {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) throw notFoundError("That record does not exist.");
}

/* ── Seeds ───────────────────────────────────────────────────────────────── */

/**
 * Plan §2 P2 seeded 0 / 5 / 15. Plan §6 Phase 7 adds the withholding side:
 * source tax, VDS and AIT are the three the register groups, and they are seeded
 * with plausible rates so the register has something to show before anybody
 * configures it. Every one of them is editable and deactivatable like the VAT
 * rates — a published rate is a policy, not a constant.
 */
const TAX_SEED: Array<{ code: string; name: string; rate_percent: string; kind: "VAT" | "WITHHOLDING" }> = [
  { code: "VAT0", name: "Zero rated", rate_percent: "0.00", kind: "VAT" },
  { code: "VAT5", name: "VAT 5%", rate_percent: "5.00", kind: "VAT" },
  { code: "VAT15", name: "VAT 15%", rate_percent: "15.00", kind: "VAT" },
  { code: "VDS", name: "VAT Deduction at Source (VDS)", rate_percent: "5.00", kind: "WITHHOLDING" },
  { code: "AIT", name: "Advance Income Tax (AIT)", rate_percent: "5.00", kind: "WITHHOLDING" },
  { code: "SRCTAX", name: "Source Tax", rate_percent: "3.00", kind: "WITHHOLDING" },
];

const UNIT_SEED: Array<{ name: string; symbol: string }> = [
  { name: "Piece", symbol: "pc" },
  { name: "Kilogram", symbol: "kg" },
  { name: "Litre", symbol: "L" },
  { name: "Hour", symbol: "hr" },
  { name: "Service", symbol: "svc" },
];

/**
 * The personal-ledger categories, with the accounts `coa-seed.ts` already maps
 * them to. Seeding them as rows means the category screen, the expense bridge
 * and the chart all agree from the first request — and that a user who remaps a
 * category in the screen actually changes where the next expense posts.
 */
const CATEGORY_SEED: Array<{ name: string; account_code: string }> = CATEGORIES.map((name) => ({
  name,
  account_code: CATEGORY_ACCOUNT_CODE[name] ?? "5800",
}));

/** Where a newly invented category posts when its name has no mapping. */
const CATEGORY_DEFAULT_ACCOUNT: Record<"EXPENSE" | "INCOME", string> = {
  EXPENSE: "5800",
  INCOME: "4100",
};

/**
 * Give an organisation its starting catalogs. Idempotent: unique indexes pick
 * the winner and the loser moves on, so signup, self-heal and the manual seed
 * button can all call it without coordinating.
 */
export async function ensureMasterData(
  orgId: string | Types.ObjectId,
  uid: string,
): Promise<{ tax_rates: number; units: number; categories: number }> {
  let taxRates = 0;
  let units = 0;
  let categories = 0;

  for (const seed of TAX_SEED) {
    try {
      await TaxRateModel.create({ org_id: orgId, ...seed, is_active: true, created_by: uid, updated_by: uid });
      taxRates += 1;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  for (const seed of UNIT_SEED) {
    try {
      await UnitModel.create({ org_id: orgId, ...seed, is_active: true, created_by: uid, updated_by: uid });
      units += 1;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  for (const seed of CATEGORY_SEED) {
    try {
      await MasterCategoryModel.create({
        org_id: orgId,
        name: seed.name,
        kind: "EXPENSE",
        account_code: seed.account_code,
        is_active: true,
        created_by: uid,
        updated_by: uid,
      });
      categories += 1;
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }

  return { tax_rates: taxRates, units, categories };
}

/* ── Units ───────────────────────────────────────────────────────────────── */

export async function listUnits(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<UnitView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = true;
  const rows = await UnitModel.find(filter).sort({ name: 1 }).lean();
  return rows.map(toUnitView);
}

export async function createUnit(
  orgId: string,
  uid: string,
  input: CreateUnitInput,
  ip?: string,
): Promise<UnitView> {
  try {
    const created = await UnitModel.create({
      org_id: orgId,
      name: input.name,
      symbol: input.symbol,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });
    const view = toUnitView(created.toObject());
    await writeAudit({
      orgId,
      uid,
      entity: "masterdata.unit",
      entityId: view.id,
      action: "UNIT_CREATED",
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "UNIT_NAME_TAKEN", `A unit called ${input.name} already exists.`);
    }
    throw error;
  }
}

export async function updateUnit(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateUnitInput,
  ip?: string,
): Promise<UnitView> {
  assertId(id);
  const existing = await UnitModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That unit does not exist.");
  const before = toUnitView(existing);

  const patch: Record<string, unknown> = { updated_by: uid };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.symbol !== undefined) patch["symbol"] = input.symbol;

  try {
    const updated = await UnitModel.findOneAndUpdate(
      { _id: id, org_id: orgId },
      { $set: patch },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) throw notFoundError("That unit does not exist.");

    const view = toUnitView(updated);
    await writeAudit({
      orgId,
      uid,
      entity: "masterdata.unit",
      entityId: view.id,
      action: "UNIT_UPDATED",
      before,
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "UNIT_NAME_TAKEN", `A unit called ${input.name} already exists.`);
    }
    throw error;
  }
}

export async function deactivateUnit(orgId: string, uid: string, id: string, ip?: string): Promise<UnitView> {
  assertId(id);
  const existing = await UnitModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That unit does not exist.");
  const before = toUnitView(existing);

  const updated = await UnitModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: { is_active: false, updated_by: uid } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That unit does not exist.");

  const view = toUnitView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.unit",
    entityId: view.id,
    action: "UNIT_DEACTIVATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

/* ── Tax rates ───────────────────────────────────────────────────────────── */

export async function listTaxRates(
  orgId: string,
  options: { includeInactive?: boolean; kind?: "VAT" | "WITHHOLDING" } = {},
): Promise<TaxRateView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = true;
  if (options.kind) filter["kind"] = options.kind;
  const rows = await TaxRateModel.find(filter).sort({ code: 1 }).lean();
  return rows.map(toTaxRateView);
}

export async function createTaxRate(
  orgId: string,
  uid: string,
  input: CreateTaxRateInput,
  ip?: string,
): Promise<TaxRateView> {
  try {
    const created = await TaxRateModel.create({
      org_id: orgId,
      code: input.code,
      name: input.name,
      kind: input.kind,
      rate_percent: input.rate_percent,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });
    const view = toTaxRateView(created.toObject());
    await writeAudit({
      orgId,
      uid,
      entity: "masterdata.taxRate",
      entityId: view.id,
      action: "TAX_RATE_CREATED",
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "TAX_CODE_TAKEN", `Code ${input.code} is already used by another tax rate.`);
    }
    throw error;
  }
}

export async function updateTaxRate(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateTaxRateInput,
  ip?: string,
): Promise<TaxRateView> {
  assertId(id);
  const existing = await TaxRateModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That tax rate does not exist.");
  const before = toTaxRateView(existing);

  const patch: Record<string, unknown> = { updated_by: uid };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.rate_percent !== undefined) patch["rate_percent"] = input.rate_percent;
  if (input.kind !== undefined) patch["kind"] = input.kind;

  const updated = await TaxRateModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw notFoundError("That tax rate does not exist.");

  const view = toTaxRateView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.taxRate",
    entityId: view.id,
    action: "TAX_RATE_UPDATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

export async function deactivateTaxRate(
  orgId: string,
  uid: string,
  id: string,
  ip?: string,
): Promise<TaxRateView> {
  assertId(id);
  const existing = await TaxRateModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That tax rate does not exist.");
  const before = toTaxRateView(existing);

  const updated = await TaxRateModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: { is_active: false, updated_by: uid } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That tax rate does not exist.");

  const view = toTaxRateView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.taxRate",
    entityId: view.id,
    action: "TAX_RATE_DEACTIVATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

/**
 * Resolve a rate by its code for an item default. Inactive rates are refused
 * here rather than at document time: an item still pointing at a rate somebody
 * retired should say so while the item is being edited, not weeks later on an
 * invoice form.
 */
export async function requireTaxRateByCode(
  orgId: string | Types.ObjectId,
  code: string,
): Promise<TaxRateDocument & { _id: Types.ObjectId }> {
  const rate = await TaxRateModel.findOne({ org_id: orgId, code, is_active: true }).lean();
  if (!rate) {
    throw new AppError(422, "TAX_RATE_NOT_FOUND", `No active tax rate with code ${code} exists.`);
  }
  return rate as TaxRateDocument & { _id: Types.ObjectId };
}

/** Resolve a unit an item points at. Returns null for "no unit" — a service
 *  legitimately has none. */
export async function requireUnit(
  orgId: string | Types.ObjectId,
  unitId: string | null,
): Promise<(UnitDocument & { _id: Types.ObjectId }) | null> {
  if (!unitId) return null;
  if (!/^[0-9a-fA-F]{24}$/.test(unitId)) {
    throw validationError("That unit is not a valid record.");
  }
  const unit = await UnitModel.findOne({ _id: unitId, org_id: orgId }).lean();
  if (!unit) throw validationError("That unit does not exist.");
  return unit as UnitDocument & { _id: Types.ObjectId };
}

/* ── Categories ──────────────────────────────────────────────────────────── */

export async function listCategories(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<CategoryView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = true;
  const rows = await MasterCategoryModel.find(filter).sort({ kind: 1, name: 1 }).lean();
  if (rows.length === 0) return [];

  const accounts = await listAccounts(orgId, { includeInactive: true });
  const names = new Map(accounts.map((account) => [account.code, account.name]));
  return rows.map((row) => toCategoryView(row, names.get(row.account_code) ?? ""));
}

/**
 * The account a category posts to, validated against its kind.
 *
 * The type check is the whole reason categories are trustworthy: an expense
 * category wired to a revenue account would produce a trial balance that still
 * balances (debits equal credits either way) while every margin figure in it is
 * wrong. Refusing at configuration time is the only moment that error is cheap.
 */
async function resolveCategoryAccount(
  orgId: string,
  kind: "EXPENSE" | "INCOME",
  accountCode: string,
) {
  const account = await requireAccountByCode(orgId, accountCode);
  const requiredType = kind === "EXPENSE" ? "EXPENSE" : "REVENUE";
  if (account.type !== requiredType) {
    throw validationError(
      kind === "EXPENSE"
        ? `“${account.name}” is a ${account.type.toLowerCase()} account. Expense categories post to expense accounts.`
        : `“${account.name}” is a ${account.type.toLowerCase()} account. Income categories post to revenue accounts.`,
    );
  }
  return account;
}

/** The account name for a stored category code, best effort — used only to
 *  fill the audit row, so an account that has since been renamed away simply
 *  shows blank rather than failing the write. */
async function accountNameFor(orgId: string, code: string): Promise<string> {
  const account = await CoaAccountModel.findOne({ org_id: orgId, code }).lean();
  return account?.name ?? "";
}

function defaultCategoryAccount(kind: "EXPENSE" | "INCOME", name: string): string {
  return CATEGORY_ACCOUNT_CODE[name] ?? CATEGORY_DEFAULT_ACCOUNT[kind];
}

export async function createCategory(
  orgId: string,
  uid: string,
  input: CreateCategoryInput,
  ip?: string,
): Promise<CategoryView> {
  const accountCode = input.account_code || defaultCategoryAccount(input.kind, input.name);
  const account = await resolveCategoryAccount(orgId, input.kind, accountCode);

  try {
    const created = await MasterCategoryModel.create({
      org_id: orgId,
      name: input.name,
      kind: input.kind,
      account_code: account.code,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });
    const view = toCategoryView(created.toObject(), account.name);
    await writeAudit({
      orgId,
      uid,
      entity: "masterdata.category",
      entityId: view.id,
      action: "CATEGORY_CREATED",
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(
        409,
        "CATEGORY_TAKEN",
        `A ${input.kind.toLowerCase()} category called ${input.name} already exists.`,
      );
    }
    throw error;
  }
}

export async function updateCategory(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateCategoryInput,
  ip?: string,
): Promise<CategoryView> {
  assertId(id);
  const existing = await MasterCategoryModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That category does not exist.");
  const before = toCategoryView(existing, await accountNameFor(orgId, existing.account_code));

  const name = input.name ?? existing.name;
  const kind = input.kind ?? existing.kind;
  const accountCode = input.account_code !== undefined && input.account_code !== ""
    ? input.account_code
    : existing.account_code;
  const account = await resolveCategoryAccount(orgId, kind, accountCode);

  try {
    const updated = await MasterCategoryModel.findOneAndUpdate(
      { _id: id, org_id: orgId },
      { $set: { name, kind, account_code: account.code, updated_by: uid } },
      { new: true, runValidators: true },
    ).lean();
    if (!updated) throw notFoundError("That category does not exist.");

    const view = toCategoryView(updated, account.name);
    await writeAudit({
      orgId,
      uid,
      entity: "masterdata.category",
      entityId: view.id,
      action: "CATEGORY_UPDATED",
      before,
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "CATEGORY_TAKEN", `A ${kind.toLowerCase()} category called ${name} already exists.`);
    }
    throw error;
  }
}

export async function deactivateCategory(
  orgId: string,
  uid: string,
  id: string,
  ip?: string,
): Promise<CategoryView> {
  assertId(id);
  const existing = await MasterCategoryModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That category does not exist.");
  const before = toCategoryView(existing, await accountNameFor(orgId, existing.account_code));

  const updated = await MasterCategoryModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: { is_active: false, updated_by: uid } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That category does not exist.");

  const view = toCategoryView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.category",
    entityId: view.id,
    action: "CATEGORY_DEACTIVATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}
