/**
 * Items — what an organisation sells and buys (plan §2, P2).
 *
 * An item is a bundle of defaults, and the service's job is to make sure every
 * one of those defaults resolves *now*, when somebody is filling in a form,
 * rather than later when a document is being issued:
 *
 *   - `tax_code` must name an active tax rate. A retired rate still referenced
 *     by an item would either fail an invoice or — worse — silently apply a
 *     percentage nobody chose for this document.
 *   - The three account codes must exist and be active in this org's chart.
 *     A dead mapping is caught here, where the fix is one field away.
 *
 * `sku` follows the same rule as a party's code: unique per org, immutable
 * after creation, because stock and reports key off it.
 */
import { z } from "zod";

import { ItemModel } from "./items.model.js";
import { requireTaxRateByCode, requireUnit, listUnits, listTaxRates } from "./catalogs.service.js";
import { listAccounts, requireAccountByCode } from "../coa/coa.service.js";
import { writeAudit } from "../../core/audit.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";

const DefaultAccountInput = z.string().trim().max(24);

export const CreateItemSchema = z.object({
  sku: z
    .string()
    .trim()
    .min(1, "An item needs a SKU.")
    .max(32)
    .regex(/^[A-Za-z0-9-]+$/, "A SKU is letters, digits and dashes."),
  name: z.string().trim().min(2, "Give the item a name.").max(120),
  description: z.string().trim().max(500).default(""),
  track_stock: z.boolean().default(false),
  unit_id: z.string().trim().nullable().default(null),
  /** 0 means "only out of stock counts as low"; see the model. */
  reorder_level: z.coerce.number().min(0).max(1_000_000).default(0),
  /** Blank means "no default tax". */
  tax_code: z.string().trim().max(24).default(""),
  income_account_code: DefaultAccountInput.default("4000"),
  cogs_account_code: DefaultAccountInput.default("5000"),
  expense_account_code: DefaultAccountInput.default("5800"),
});

/** The `sku` is absent on purpose — see the header. */
export const UpdateItemSchema = CreateItemSchema.omit({ sku: true }).partial();

export type CreateItemInput = z.output<typeof CreateItemSchema>;
export type UpdateItemInput = z.output<typeof UpdateItemSchema>;

export interface ItemView {
  id: string;
  sku: string;
  name: string;
  description: string;
  track_stock: boolean;
  unit_id: string | null;
  unit_name: string;
  reorder_level: number;
  tax_code: string;
  tax_name: string;
  tax_rate_percent: string;
  income_account_code: string;
  income_account_name: string;
  cogs_account_code: string;
  cogs_account_name: string;
  expense_account_code: string;
  expense_account_name: string;
  is_active: boolean;
}

interface JoinMaps {
  accountNames: Map<string, string>;
  unitNames: Map<string, string>;
  taxNames: Map<string, { name: string; rate_percent: string }>;
}

/** One place builds the join maps, so list and single-row views cannot drift. */
async function joinMaps(orgId: string): Promise<JoinMaps> {
  const [accounts, units, taxRates] = await Promise.all([
    listAccounts(orgId, { includeInactive: true }),
    listUnits(orgId, { includeInactive: true }),
    listTaxRates(orgId, { includeInactive: true }),
  ]);
  return {
    accountNames: new Map(accounts.map((account) => [account.code, account.name])),
    unitNames: new Map(units.map((unit) => [unit.id, unit.name])),
    taxNames: new Map(taxRates.map((rate) => [rate.code, { name: rate.name, rate_percent: rate.rate_percent }])),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(doc: any, joins: JoinMaps): ItemView {
  const tax = doc.tax_code ? joins.taxNames.get(doc.tax_code) : undefined;
  return {
    id: String(doc._id),
    sku: doc.sku,
    name: doc.name,
    description: doc.description ?? "",
    track_stock: Boolean(doc.track_stock),
    unit_id: doc.unit_id ? String(doc.unit_id) : null,
    unit_name: doc.unit_id ? (joins.unitNames.get(String(doc.unit_id)) ?? "") : "",
    reorder_level: Number(doc.reorder_level ?? 0),
    tax_code: doc.tax_code ?? "",
    tax_name: tax?.name ?? "",
    tax_rate_percent: tax?.rate_percent ?? "",
    income_account_code: doc.income_account_code,
    income_account_name: joins.accountNames.get(doc.income_account_code) ?? "",
    cogs_account_code: doc.cogs_account_code,
    cogs_account_name: joins.accountNames.get(doc.cogs_account_code) ?? "",
    expense_account_code: doc.expense_account_code,
    expense_account_name: joins.accountNames.get(doc.expense_account_code) ?? "",
    is_active: doc.is_active !== false,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

function assertId(id: string): void {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) throw notFoundError("That item does not exist.");
}

/** Every account an item maps to, resolved and active, before anything is
 *  written — all three or none, so a half-valid item never exists. */
async function resolveAccounts(orgId: string, input: CreateItemInput | UpdateItemInput, existing?: {
  income_account_code: string;
  cogs_account_code: string;
  expense_account_code: string;
}) {
  const income = await requireAccountByCode(orgId, input.income_account_code ?? existing?.income_account_code ?? "4000");
  const cogs = await requireAccountByCode(orgId, input.cogs_account_code ?? existing?.cogs_account_code ?? "5000");
  const expense = await requireAccountByCode(
    orgId,
    input.expense_account_code ?? existing?.expense_account_code ?? "5800",
  );
  return { income, cogs, expense };
}

export async function listItems(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<ItemView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = true;
  const rows = await ItemModel.find(filter).sort({ sku: 1 }).lean();
  if (rows.length === 0) return [];

  const joins = await joinMaps(orgId);
  return rows.map((row) => toView(row, joins));
}

export async function createItem(
  orgId: string,
  uid: string,
  input: CreateItemInput,
  ip?: string,
): Promise<ItemView> {
  const [accounts, unit] = await Promise.all([
    resolveAccounts(orgId, input),
    requireUnit(orgId, input.unit_id),
  ]);
  if (input.tax_code) await requireTaxRateByCode(orgId, input.tax_code);

  try {
    const created = await ItemModel.create({
      org_id: orgId,
      sku: input.sku,
      name: input.name,
      description: input.description,
      track_stock: input.track_stock,
      unit_id: unit?._id ?? null,
      reorder_level: input.reorder_level,
      tax_code: input.tax_code,
      income_account_code: accounts.income.code,
      cogs_account_code: accounts.cogs.code,
      expense_account_code: accounts.expense.code,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });
    const view = toView(created.toObject(), await joinMaps(orgId));

    await writeAudit({
      orgId,
      uid,
      entity: "masterdata.item",
      entityId: view.id,
      action: "ITEM_CREATED",
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "SKU_TAKEN", `SKU ${input.sku} is already used in this ledger.`);
    }
    throw error;
  }
}

export async function updateItem(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateItemInput,
  ip?: string,
): Promise<ItemView> {
  assertId(id);
  const existing = await ItemModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That item does not exist.");

  const [accounts, unit] = await Promise.all([
    resolveAccounts(orgId, input, existing),
    // `undefined` means "leave the unit alone"; `null` means "clear it".
    input.unit_id === undefined ? Promise.resolve(undefined) : requireUnit(orgId, input.unit_id),
  ]);
  if (input.tax_code) await requireTaxRateByCode(orgId, input.tax_code);

  const patch: Record<string, unknown> = { updated_by: uid };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.description !== undefined) patch["description"] = input.description;
  if (input.track_stock !== undefined) patch["track_stock"] = input.track_stock;
  if (input.reorder_level !== undefined) patch["reorder_level"] = input.reorder_level;
  if (input.tax_code !== undefined) patch["tax_code"] = input.tax_code;
  if (unit !== undefined) patch["unit_id"] = unit?._id ?? null;
  patch["income_account_code"] = accounts.income.code;
  patch["cogs_account_code"] = accounts.cogs.code;
  patch["expense_account_code"] = accounts.expense.code;

  const before = toView(existing, await joinMaps(orgId));
  const updated = await ItemModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw notFoundError("That item does not exist.");

  const view = toView(updated, await joinMaps(orgId));
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.item",
    entityId: view.id,
    action: "ITEM_UPDATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

export async function deactivateItem(orgId: string, uid: string, id: string, ip?: string): Promise<ItemView> {
  assertId(id);
  const existing = await ItemModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That item does not exist.");
  const before = toView(existing, await joinMaps(orgId));

  const updated = await ItemModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: { is_active: false, updated_by: uid } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That item does not exist.");

  const view = toView(updated, await joinMaps(orgId));
  await writeAudit({
    orgId,
    uid,
    entity: "masterdata.item",
    entityId: view.id,
    action: "ITEM_DEACTIVATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}
