/**
 * Warehouses — where stock sits (plan §6, Phase 8).
 *
 * A WAREHOUSE IS A PLACE, NOT A FEATURE FLAG
 * Every organisation that holds stock has at least one, and rather than seeding
 * one for everybody at signup, the first thing that needs a warehouse creates it:
 * `defaultWarehouse`. An organisation that sells only services never gets a
 * warehouse row it will never look at, and one that starts holding stock today
 * is not stopped mid-sale to go and set one up. That single lazy write is the
 * only place a read path may create a row, and it is stated here rather than
 * discovered in a service.
 *
 * WHICH ONE IS THE DEFAULT
 * `is_default` is maintained, not enforced by an index: `createWarehouse` clears
 * the flag on the others when it sets one, so "the default" is always the row
 * with the flag. A ledger with the flag on two rows would make a document's
 * destination depend on which one a query happened to return first — which is
 * exactly the kind of nondeterminism a stock ledger cannot afford.
 *
 * The value a warehouse holds is *read* from its stock balances, never stored
 * here: a cached total on this row would need a writer, and the movements are
 * already the writer of record.
 */
import type { ClientSession } from "mongoose";
import { z } from "zod";

import { StockBalanceModel, WarehouseModel } from "./inventory.model.js";
import { writeAudit } from "../../core/audit.js";
import { Decimal, fmt, money, ZERO } from "../../core/money.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const CreateWarehouseSchema = z.object({
  /** Short human-typed identity, unique per org and fixed after creation. */
  code: z
    .string()
    .trim()
    .min(1, "A warehouse needs a code.")
    .max(16)
    .regex(/^[A-Za-z0-9-]+$/, "A code is letters, digits and dashes."),
  name: z.string().trim().min(2, "Give the warehouse a name.").max(80),
  address: z.string().trim().max(300).default(""),
  is_default: z.boolean().default(false),
});

/** The code is absent on purpose: it is the identity operations key off, so it
 *  is fixed after creation just like an item's SKU. */
export const UpdateWarehouseSchema = CreateWarehouseSchema.omit({ code: true })
  .partial()
  .extend({ is_active: z.boolean().optional() });

export type CreateWarehouseInput = z.output<typeof CreateWarehouseSchema>;
export type UpdateWarehouseInput = z.output<typeof UpdateWarehouseSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface WarehouseView {
  id: string;
  code: string;
  name: string;
  address: string;
  is_default: boolean;
  is_active: boolean;
  /** What this warehouse's stock is worth, read from its balances. */
  total_value_bdt: string;
  total_qty: number;
  item_count: number;
}

/** The fields a document needs from a warehouse, and nothing more. */
export interface WarehouseRef {
  id: string;
  code: string;
  name: string;
  is_default: boolean;
  is_active: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRef(doc: any): WarehouseRef {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    is_default: doc.is_default === true,
    is_active: doc.is_active !== false,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(doc: any, totals: { value: string; qty: number; items: number }): WarehouseView {
  return {
    ...toRef(doc),
    address: doc.address ?? "",
    total_value_bdt: totals.value,
    total_qty: totals.qty,
    item_count: totals.items,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

/**
 * What each warehouse holds, in one read rather than one per warehouse.
 *
 * Read as balances and summed in memory rather than aggregated: the map is
 * bounded by items × warehouses, which is a screen's worth of rows, and going
 * through `core/money.ts` keeps the sum in the same exact decimal arithmetic as
 * everything else.
 */
async function warehouseTotals(orgId: string): Promise<Map<string, { value: string; qty: number; items: number }>> {
  const rows = await StockBalanceModel.find({ org_id: orgId })
    .select({ warehouse_id: 1, qty: 1, value_bdt: 1 })
    .lean();

  const out = new Map<string, { value: string; qty: number; items: number }>();
  const sums = new Map<string, Decimal>();
  for (const row of rows) {
    const key = String(row.warehouse_id);
    sums.set(key, (sums.get(key) ?? ZERO).plus(money(row.value_bdt ?? "0.00")));
    const existing = out.get(key) ?? { value: "0.00", qty: 0, items: 0 };
    out.set(key, { value: existing.value, qty: existing.qty + Number(row.qty ?? 0), items: existing.items + 1 });
  }
  for (const [key, value] of sums) {
    const existing = out.get(key)!;
    out.set(key, { ...existing, value: fmt(value) });
  }
  return out;
}

export async function listWarehouses(
  orgId: string,
  options: { includeInactive?: boolean } = {},
): Promise<WarehouseView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (!options.includeInactive) filter["is_active"] = { $ne: false };

  const rows = await WarehouseModel.find(filter).sort({ is_default: -1, code: 1 }).lean();
  if (rows.length === 0) return [];

  const totals = await warehouseTotals(orgId);
  return rows.map((row) =>
    toView(row, totals.get(String(row._id)) ?? { value: "0.00", qty: 0, items: 0 }),
  );
}

/* ── Writers ─────────────────────────────────────────────────────────────── */

export async function createWarehouse(
  orgId: string,
  uid: string,
  input: CreateWarehouseInput,
  ip?: string,
): Promise<WarehouseView> {
  try {
    if (input.is_default) {
      await WarehouseModel.updateMany({ org_id: orgId }, { $set: { is_default: false } });
    }
    const created = await WarehouseModel.create({
      org_id: orgId,
      code: input.code,
      name: input.name,
      address: input.address,
      is_default: input.is_default,
      is_active: true,
      created_by: uid,
      updated_by: uid,
    });
    const view = toView(created.toObject(), { value: "0.00", qty: 0, items: 0 });

    await writeAudit({
      orgId,
      uid,
      entity: "inventory.warehouse",
      entityId: view.id,
      action: "WAREHOUSE_CREATED",
      after: view,
      ...(ip ? { ip } : {}),
    });
    return view;
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "WAREHOUSE_CODE_TAKEN", `Warehouse ${input.code} already exists in this ledger.`);
    }
    throw error;
  }
}

export async function updateWarehouse(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateWarehouseInput,
  ip?: string,
): Promise<WarehouseView> {
  const existing = await WarehouseModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!existing) throw notFoundError("That warehouse does not exist.");

  const patch: Record<string, unknown> = { updated_by: uid };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.address !== undefined) patch["address"] = input.address;
  if (input.is_active !== undefined) patch["is_active"] = input.is_active;
  if (input.is_default !== undefined) patch["is_default"] = input.is_default;

  // Setting a new default clears the old one in the same breath, so the flag is
  // never on two rows even for the moment between two writes.
  if (input.is_default === true) {
    await WarehouseModel.updateMany({ org_id: orgId, _id: { $ne: id } }, { $set: { is_default: false } });
  }

  const updated = await WarehouseModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw notFoundError("That warehouse does not exist.");

  const totals = await warehouseTotals(orgId);
  const view = toView(updated, totals.get(id) ?? { value: "0.00", qty: 0, items: 0 });

  await writeAudit({
    orgId,
    uid,
    entity: "inventory.warehouse",
    entityId: view.id,
    action: "WAREHOUSE_UPDATED",
    before: toRef(existing),
    after: toRef(view),
    ...(ip ? { ip } : {}),
  });
  return view;
}

/** One warehouse, refused if it is retired — a movement into a warehouse nobody
 *  is looking after is a movement nobody will count. */
export async function requireWarehouse(
  orgId: string,
  id: string,
  session?: ClientSession | null,
): Promise<WarehouseRef> {
  const doc = await WarehouseModel.findOne({ _id: id, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!doc) throw notFoundError("That warehouse does not exist.");
  if (doc.is_active === false) {
    throw new AppError(422, "WAREHOUSE_INACTIVE", `${doc.name} is retired, so nothing can be moved into it.`);
  }
  return toRef(doc);
}

/**
 * The warehouse a movement goes to when the caller names none.
 *
 * Prefers the default, then any active one by code — deterministic, because two
 * runs of the same sale must not put the goods in two different places. Opens
 * the first warehouse if the ledger has never had one; see the header.
 */
export async function defaultWarehouse(
  orgId: string,
  uid: string,
  session?: ClientSession | null,
): Promise<WarehouseRef> {
  const existing = await WarehouseModel.findOne({ org_id: orgId, is_active: { $ne: false } })
    .sort({ is_default: -1, code: 1 })
    .session(session ?? null)
    .lean();
  if (existing) return toRef(existing);

  const created = await WarehouseModel.create(
    [
      {
        org_id: orgId,
        code: "MAIN",
        name: "Main Store",
        address: "",
        is_default: true,
        is_active: true,
        created_by: uid,
        updated_by: uid,
      },
    ],
    session ? { session } : {},
  ).then((rows) => rows[0]!);

  return toRef(created.toObject());
}
