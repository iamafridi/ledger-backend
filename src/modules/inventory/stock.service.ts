/**
 * The stock ledger (plan §6, Phase 8).
 *
 * THE ONE RULE THAT MAKES THE TIE-OUT STRUCTURAL
 * Stock movements are created for exactly the lines that posted to the
 * inventory control account, and the value moved is exactly the amount that
 * posted. A bill line that hit 1200 puts goods on the shelf worth that line's
 * net; a sale credits 1200 by the value it relieves. So "stock valuation equals
 * the inventory control account" is not a coincidence to be checked hopefully —
 * it is a consequence of writing both sides from one number, which is why
 * `I5-STOCK` can assert an equality to the paisa and the exit gate can lean on it.
 *
 * WHAT COSTS WHAT
 * A receipt carries its own value and the average is derived from it (see
 * `core/stock.ts`). An issue is costed at the moving average of the (item,
 * warehouse) it comes out of — two stores that bought at different prices are
 * two averages, because they are two shelves. A transfer is an issue at the
 * source cost and a receipt at that same value, so the shop's total is unchanged
 * and no journal entry is written: the goods moved, they did not change what
 * they are worth.
 *
 * DIRECTION IS NEVER A SIGN
 * Every stored amount is non-negative. An issue's sign lives in `direction`, a
 * stocktake variance's in `variance_qty`, and a journal line's in which side it
 * sits on — the same rule as everywhere else in this codebase.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO YET
 * A credit note does not return goods to the shelf, and a debit note does not
 * send them back to the supplier. Whether a return is restockable is a decision
 * the document has to state (a broken item comes back to a scrap bin, not to
 * stock), and the plan's Phase 8 does not model that field. Leaving both out
 * keeps the ledger honest — revenue and cost both reverse, nothing pretends the
 * goods came back — and the omission is visible here rather than being a
 * surprise in a report.
 */
import { z } from "zod";
import type { ClientSession } from "mongoose";

import { ItemModel } from "../masterdata/items.model.js";
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import {
  StockBalanceModel,
  StockMovementModel,
  StocktakeModel,
  WarehouseModel,
  type MovementDirection,
  type MovementSource,
} from "./inventory.model.js";
import { defaultWarehouse, requireWarehouse } from "./warehouse.service.js";
import {
  averageCost,
  canIssue,
  issueValue,
  receiptValue,
  storedPosition,
  toStored,
  type Position,
} from "../../core/stock.js";
import { inTransaction, postJournal, type JournalLineInput } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { Decimal, fmt, money, toPaisa, ZERO, type Money } from "../../core/money.js";
import { DateInput, MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const ListMovementsQuery = z.object({
  item_id: ObjectIdInput.optional(),
  warehouse_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const Quantity = z.coerce
  .number()
  .refine((value) => Number.isFinite(value), "A quantity must be a number.")
  .refine((value) => Math.abs(value) <= 1_000_000, "That quantity is not plausible.");

export const CreateAdjustmentSchema = z.object({
  item_id: ObjectIdInput,
  /** Blank means the organisation's default warehouse. */
  warehouse_id: ObjectIdInput.optional(),
  date: DateInput,
  /** Signed: positive adds stock, negative writes it off. */
  qty_delta: Quantity.refine(
    (value) => value !== 0,
    "An adjustment must change the quantity — positive to add stock, negative to write it off.",
  ),
  /** Required when nothing is on the book to average against; see the service. */
  unit_cost_bdt: MoneyInput.optional(),
  reason: z.string().trim().min(3, "Say why this adjustment is being made.").max(300),
  memo: z.string().trim().max(300).default(""),
});

export const CreateStockTransferSchema = z.object({
  item_id: ObjectIdInput,
  from_warehouse_id: ObjectIdInput,
  to_warehouse_id: ObjectIdInput,
  date: DateInput,
  qty: Quantity.refine((value) => value > 0, "A transfer needs a quantity greater than zero."),
  memo: z.string().trim().max(300).default(""),
});

const StocktakeLineInput = z.object({
  item_id: ObjectIdInput,
  counted_qty: z.coerce.number().min(0, "A counted quantity cannot be negative.").max(1_000_000),
  /** Optional: supplied when stock was found that the book has no cost for. */
  unit_cost_bdt: MoneyInput.optional(),
});

export const CreateStocktakeSchema = z.object({
  warehouse_id: ObjectIdInput.optional(),
  date: DateInput,
  memo: z.string().trim().max(300).default(""),
  lines: z.array(StocktakeLineInput).min(1, "A stocktake needs at least one counted line.").max(500),
});

export const PostStocktakeSchema = z.object({
  reason: z.string().trim().min(3, "Say why this variance is being posted.").max(300),
});

export const ListStockQuery = z.object({
  warehouse_id: ObjectIdInput.optional(),
  item_id: ObjectIdInput.optional(),
});

export const ListStocktakeQuery = z.object({
  status: z.enum(["DRAFT", "POSTED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type CreateAdjustmentInput = z.output<typeof CreateAdjustmentSchema>;
export type CreateStockTransferInput = z.output<typeof CreateStockTransferSchema>;
export type CreateStocktakeInput = z.output<typeof CreateStocktakeSchema>;
export type ListMovementsInput = z.output<typeof ListMovementsQuery>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface StockBalanceView {
  item_id: string;
  sku: string;
  item_name: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  qty: number;
  value_bdt: string;
  avg_cost_bdt: string;
  reorder_level: number;
  low_stock: boolean;
}

/** One item's position across every warehouse — what a low-stock list is about:
 *  the item is short, not one shelf of it. */
export interface LowStockRow {
  item_id: string;
  sku: string;
  item_name: string;
  on_hand: number;
  value_bdt: string;
  avg_cost_bdt: string;
  reorder_level: number;
}

export interface StockSummary {
  item_count: number;
  tracked_item_count: number;
  warehouse_count: number;
  total_qty: number;
  /** The figure `I5-STOCK` ties to the inventory control account. */
  total_value_bdt: string;
  low_stock_count: number;
}

export interface StockMovementView {
  id: string;
  date: string;
  direction: MovementDirection;
  item_id: string;
  sku: string;
  item_name: string;
  warehouse_id: string;
  warehouse_name: string;
  qty: number;
  value_bdt: string;
  unit_cost_bdt: string;
  source: string;
  source_id: string;
  doc_no: string;
  reason: string;
  memo: string;
  reversed: boolean;
  reverses_movement_id: string | null;
}

export interface StocktakeLineView {
  item_id: string;
  sku_snapshot: string;
  label_snapshot: string;
  expected_qty: number;
  counted_qty: number;
  variance_qty: number;
  unit_cost_bdt: string;
  variance_value_bdt: string;
}

export interface StocktakeView {
  id: string;
  warehouse_id: string;
  warehouse_name: string;
  date: string;
  status: "DRAFT" | "POSTED";
  memo: string;
  lines: StocktakeLineView[];
  variance_qty_total: number;
  /** The absolute value the worksheet moves, whichever way it moves it. */
  variance_value_bdt: string;
  journal_entry_id: string | null;
  posted_by: string;
  posted_at: string | null;
}

/* ── Shared reads ────────────────────────────────────────────────────────── */

/** The fields the stock logic needs from an item, keyed by id. One read for a
 *  whole document rather than one per line. */
interface StockItem {
  id: string;
  sku: string;
  name: string;
  track_stock: boolean;
  cogs_account_code: string;
}

async function itemMap(orgId: string, ids: readonly unknown[]): Promise<Map<string, StockItem>> {
  const unique = [...new Set(ids.map((id) => String(id)))].filter(Boolean);
  if (unique.length === 0) return new Map();

  const rows = await ItemModel.find({ org_id: orgId, _id: { $in: unique } }).lean();
  return new Map(
    rows.map((row) => [
      String(row._id),
      {
        id: String(row._id),
        sku: row.sku,
        name: row.name,
        track_stock: row.track_stock === true,
        cogs_account_code: row.cogs_account_code,
      },
    ]),
  );
}

/** An item that stock can be moved for. Refused otherwise, with the fix named —
 *  "not tracked" is a setting somebody can turn on, not a broken record. */
async function requireTrackedItem(orgId: string, id: string): Promise<StockItem> {
  assertObjectId(id, "That item does not exist.");
  const item = await ItemModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!item) throw notFoundError("That item does not exist.");
  if (item.track_stock !== true) {
    throw new AppError(
      422,
      "ITEM_NOT_TRACKED",
      `${item.name} is not stock-tracked, so it has no quantity on hand. Turn on “track quantity on hand” for it first.`,
    );
  }
  return {
    id: String(item._id),
    sku: item.sku,
    name: item.name,
    track_stock: true,
    cogs_account_code: item.cogs_account_code,
  };
}

async function readPosition(
  orgId: string,
  itemId: string,
  warehouseId: string,
  session?: ClientSession | null,
): Promise<Position> {
  const row = await StockBalanceModel.findOne({ org_id: orgId, item_id: itemId, warehouse_id: warehouseId })
    .session(session ?? null)
    .lean();
  return storedPosition(row);
}

async function writePosition(
  orgId: string,
  itemId: string,
  warehouseId: string,
  position: Position,
  session?: ClientSession | null,
): Promise<void> {
  const stored = toStored(position);
  await StockBalanceModel.findOneAndUpdate(
    { org_id: orgId, item_id: itemId, warehouse_id: warehouseId },
    { $set: { ...stored, last_movement_at: new Date() } },
    // `runValidators` on purpose: a quantity is written on every movement and
    // the value is the figure `I5-STOCK` ties the ledger to, so a bad string must
    // be refused at the write rather than discovered by the integrity run. An
    // update skips validators by default, which is how a "NaN" could otherwise
    // sit in a balance for ever.
    { upsert: true, new: true, setDefaultsOnInsert: true, runValidators: true, ...(session ? { session } : {}) },
  );
}

interface MovementInput {
  itemId: string;
  warehouseId: string;
  date: string;
  direction: MovementDirection;
  qty: Decimal;
  value: Money;
  source: MovementSource;
  sourceId?: string;
  docNo?: string;
  reason?: string;
  memo?: string;
  reversesId?: string | null;
}

/** Append one movement and return its id, so the caller can point a journal
 *  entry or an audit row at it. */
async function recordMovement(
  orgId: string,
  uid: string,
  input: MovementInput,
  session?: ClientSession | null,
): Promise<string> {
  // Quantities are compared against ZERO, never by `isPositive()` — decimal.js
  // signs zero as positive, so `isPositive()` would divide by zero here.
  const unitCost = input.qty.greaterThan(ZERO) ? input.value.dividedBy(input.qty) : ZERO;
  const created = await StockMovementModel.create(
    [
      {
        org_id: orgId,
        item_id: input.itemId,
        warehouse_id: input.warehouseId,
        date: input.date,
        direction: input.direction,
        qty: Number(input.qty.toString()),
        value_bdt: fmt(input.value),
        unit_cost_bdt: fmt(unitCost),
        source: input.source,
        source_id: input.sourceId ?? "",
        doc_no: input.docNo ?? "",
        reason: input.reason ?? "",
        memo: input.memo ?? "",
        reverses_movement_id: input.reversesId ?? null,
        reversed: false,
        created_by: uid,
      },
    ],
    session ? { session } : {},
  ).then((rows) => rows[0]!);

  return String(created._id);
}

interface MoveContext {
  itemId: string;
  itemLabel: string;
  warehouseId: string;
  warehouseLabel?: string;
  date: string;
  qty: Decimal;
  source: MovementSource;
  sourceId?: string;
  docNo?: string;
  reason?: string;
  memo?: string;
  reversesId?: string | null;
}

/** Put goods on a shelf. The value is the caller's, and it is the figure the
 *  inventory control account was debited by — see the header. */
async function receiveStock(
  orgId: string,
  uid: string,
  context: MoveContext,
  value: Money,
  session?: ClientSession | null,
): Promise<{ value: Money; position: Position; movementId: string }> {
  if (!context.qty.greaterThan(ZERO)) {
    throw new AppError(422, "QTY_REQUIRED", "A stock movement needs a quantity greater than zero.");
  }

  const position = await readPosition(orgId, context.itemId, context.warehouseId, session);
  const next: Position = { qty: position.qty.plus(context.qty), value: position.value.plus(value) };
  if (next.value.isNegative()) {
    throw new AppError(422, "NEGATIVE_STOCK_VALUE", "That would value the stock below zero, which cannot be right.");
  }

  await writePosition(orgId, context.itemId, context.warehouseId, next, session);
  const movementId = await recordMovement(
    orgId,
    uid,
    {
      itemId: context.itemId,
      warehouseId: context.warehouseId,
      date: context.date,
      direction: "IN",
      qty: context.qty,
      value,
      source: context.source,
      ...(context.sourceId ? { sourceId: context.sourceId } : {}),
      ...(context.docNo ? { docNo: context.docNo } : {}),
      ...(context.reason ? { reason: context.reason } : {}),
      ...(context.memo ? { memo: context.memo } : {}),
      ...(context.reversesId ? { reversesId: context.reversesId } : {}),
    },
    session,
  );

  return { value, position: next, movementId };
}

/**
 * Take goods off a shelf, costed at this warehouse's moving average.
 *
 * Negative stock is refused here, at the moment of the write, which is what
 * makes "negative stock blocked at sale posting" true rather than aspirational:
 * the sale either costs what is really there or it does not happen.
 */
async function issueStock(
  orgId: string,
  uid: string,
  context: MoveContext,
  session?: ClientSession | null,
): Promise<{ value: Money; position: Position; movementId: string }> {
  if (!context.qty.greaterThan(ZERO)) {
    throw new AppError(422, "QTY_REQUIRED", "A stock movement needs a quantity greater than zero.");
  }

  const position = await readPosition(orgId, context.itemId, context.warehouseId, session);
  if (!canIssue(position, context.qty)) {
    const where = context.warehouseLabel ? ` in ${context.warehouseLabel}` : "";
    throw new AppError(
      422,
      "INSUFFICIENT_STOCK",
      `${context.itemLabel} has ${position.qty.toString()} on hand${where} and this needs ${context.qty.toString()}. ` +
        "Stock is never allowed to go negative — receive the goods, or adjust the count, first.",
    );
  }

  const value = issueValue(position, context.qty);
  const next: Position = { qty: position.qty.minus(context.qty), value: position.value.minus(value) };
  // Emptying a shelf relieves its whole value (see `core/stock.ts`), so this is
  // zero rather than a rounding residue. Guarded anyway: a negative balance
  // would be the one state nothing downstream could interpret.
  if (next.value.isNegative()) next.value = ZERO;

  await writePosition(orgId, context.itemId, context.warehouseId, next, session);
  const movementId = await recordMovement(
    orgId,
    uid,
    {
      itemId: context.itemId,
      warehouseId: context.warehouseId,
      date: context.date,
      direction: "OUT",
      qty: context.qty,
      value,
      source: context.source,
      ...(context.sourceId ? { sourceId: context.sourceId } : {}),
      ...(context.docNo ? { docNo: context.docNo } : {}),
      ...(context.reason ? { reason: context.reason } : {}),
      ...(context.memo ? { memo: context.memo } : {}),
      ...(context.reversesId ? { reversesId: context.reversesId } : {}),
    },
    session,
  );

  return { value, position: next, movementId };
}

/* ── Wired into the buying and selling documents ─────────────────────────── */

/** The line fields the stock side of a document reads. Structural, so a stored
 *  line row can be passed straight in. */
export interface StockDocumentLine {
  item_id?: unknown;
  qty?: number | null;
  net_bdt?: string | null;
  account_code?: string | null;
}

/**
 * A bill's stock: every line that posted to the inventory control account.
 *
 * Selected by the account the line *posted to*, not by looking the item up
 * again: the two must agree, and keying off the posting is what makes them. A
 * line billed straight to an expense account — a deliberate choice somebody made
 * on that document — moves no stock, and says so by not moving any.
 */
export async function stockInFromBill(
  orgId: string,
  uid: string,
  doc: { id: string; date: string; docNo: string; lines: readonly StockDocumentLine[] },
  session?: ClientSession | null,
): Promise<number> {
  const stocked = doc.lines.filter(
    (line) => line.account_code === CONTROL_ACCOUNT.INVENTORY && line.item_id && Number(line.qty ?? 0) > 0,
  );
  if (stocked.length === 0) return 0;

  const items = await itemMap(orgId, stocked.map((line) => line.item_id));
  const warehouse = await defaultWarehouse(orgId, uid, session);

  let moved = 0;
  for (const line of stocked) {
    const item = items.get(String(line.item_id));
    if (!item || !item.track_stock) continue;

    await receiveStock(
      orgId,
      uid,
      {
        itemId: item.id,
        itemLabel: item.name,
        warehouseId: warehouse.id,
        warehouseLabel: warehouse.name,
        date: doc.date,
        qty: new Decimal(String(line.qty ?? 0)),
        source: "BILL",
        sourceId: doc.id,
        docNo: doc.docNo,
        memo: `${doc.docNo} — ${item.sku}`,
      },
      money(line.net_bdt ?? "0.00"),
      session,
    );
    moved += 1;
  }
  return moved;
}

/**
 * A sale's cost: what the goods leaving the shelf cost, as journal lines.
 *
 * Returns `DR <the item's COGS account> / CR 1200 Inventory` — one debit per
 * distinct COGS account, because two items sold together may be costed to two
 * different places on the income statement. The invoice's own entry is written
 * first and these are appended, so the completed entry still balances: the
 * mileage the sale added to COGS is met by the value it took off the shelf.
 */
export async function stockOutForInvoice(
  orgId: string,
  uid: string,
  doc: { id: string; date: string; docNo: string; lines: readonly StockDocumentLine[] },
  session?: ClientSession | null,
): Promise<JournalLineInput[]> {
  const candidates = doc.lines.filter((line) => line.item_id && Number(line.qty ?? 0) > 0);
  if (candidates.length === 0) return [];

  const items = await itemMap(orgId, candidates.map((line) => line.item_id));
  const tracked = candidates.filter((line) => items.get(String(line.item_id))?.track_stock === true);
  if (tracked.length === 0) return [];

  const warehouse = await defaultWarehouse(orgId, uid, session);
  const byAccount = new Map<string, Money>();
  let total: Money = ZERO;

  for (const line of tracked) {
    const item = items.get(String(line.item_id))!;
    const { value } = await issueStock(
      orgId,
      uid,
      {
        itemId: item.id,
        itemLabel: item.name,
        warehouseId: warehouse.id,
        warehouseLabel: warehouse.name,
        date: doc.date,
        qty: new Decimal(String(line.qty ?? 0)),
        source: "INVOICE",
        sourceId: doc.id,
        docNo: doc.docNo,
        memo: `${doc.docNo} — ${item.sku}`,
      },
      session,
    );

    byAccount.set(item.cogs_account_code, (byAccount.get(item.cogs_account_code) ?? ZERO).plus(value));
    total = total.plus(value);
  }

  // Nothing to cost: a shelf of zero-cost goods. There is no entry to add, and
  // posting a zero one would be refused by the engine for good reason.
  if (total.isZero()) return [];

  const lines: JournalLineInput[] = [];
  for (const [accountCode, amount] of byAccount) {
    if (amount.isZero()) continue;
    lines.push({
      account_code: accountCode,
      debit_bdt: fmt(amount),
      credit_bdt: "0.00",
      memo: `${doc.docNo} — cost of goods sold`,
    });
  }
  lines.push({
    account_code: CONTROL_ACCOUNT.INVENTORY,
    debit_bdt: "0.00",
    credit_bdt: fmt(total),
    memo: `${doc.docNo} — inventory released`,
  });
  return lines;
}

/**
 * Undo the stock a document moved, by writing its opposite.
 *
 * Refused, as a whole, when the goods have since left the shelf: a bill whose
 * stock has already been sold cannot be voided out of existence, because the
 * cost of that sale was taken from a shelf whose contents would then be
 * imaginary. Every plan is checked before any of them is written, so the act
 * either happens or it does not — and the refusal names the fix.
 */
export async function reverseStockForSource(
  orgId: string,
  uid: string,
  source: "BILL" | "INVOICE",
  sourceId: string,
  reason: string,
  session?: ClientSession | null,
): Promise<number> {
  const movements = await StockMovementModel.find({
    org_id: orgId,
    source,
    source_id: sourceId,
    reversed: false,
  })
    .sort({ date: 1, createdAt: 1 })
    .session(session ?? null)
    .lean();
  if (movements.length === 0) return 0;

  const plans: Array<{
    itemId: string;
    warehouseId: string;
    date: string;
    docNo: string;
    inverse: MovementDirection;
    qty: Decimal;
    value: Money;
    movementId: string;
  }> = [];

  for (const movement of movements) {
    const qty = new Decimal(String(movement.qty ?? 0));
    if (!qty.greaterThan(ZERO)) continue;
    const value = money(movement.value_bdt ?? "0.00");
    const inverse: MovementDirection = movement.direction === "IN" ? "OUT" : "IN";

    if (inverse === "OUT") {
      const position = await readPosition(orgId, String(movement.item_id), String(movement.warehouse_id), session);
      if (!canIssue(position, qty) || value.greaterThan(position.value)) {
        throw new AppError(
          409,
          "STOCK_CONSUMED",
          "The goods on that document have since been sold or moved, so reversing it would drive stock negative. " +
            "Bring the quantity back with a stock adjustment instead.",
        );
      }
      // The subtle one, and the reason a weighted average cannot always
      // un-receive: if this receipt is the whole of what is on the shelf but the
      // shelf is worth more than the receipt was, some of that value came from
      // goods that are no longer there — and removing the quantity would leave
      // money on an empty shelf. Refused rather than approximated, because a
      // book value with no goods behind it is worse than a refusal.
      if (qty.equals(position.qty) && !value.equals(position.value)) {
        throw new AppError(
          409,
          "STOCK_CONSUMED",
          "Those goods have since been averaged with stock received or sold, so removing them would leave value " +
            "on an empty shelf. Correct the quantity with a stock adjustment instead of voiding the document.",
        );
      }
    }

    plans.push({
      itemId: String(movement.item_id),
      warehouseId: String(movement.warehouse_id),
      date: movement.date,
      docNo: movement.doc_no ?? "",
      inverse,
      qty,
      value,
      movementId: String(movement._id),
    });
  }

  for (const plan of plans) {
    const position = await readPosition(orgId, plan.itemId, plan.warehouseId, session);
    const next: Position =
      plan.inverse === "IN"
        ? { qty: position.qty.plus(plan.qty), value: position.value.plus(plan.value) }
        : { qty: position.qty.minus(plan.qty), value: position.value.minus(plan.value) };

    await writePosition(orgId, plan.itemId, plan.warehouseId, next, session);
    await recordMovement(
      orgId,
      uid,
      {
        itemId: plan.itemId,
        warehouseId: plan.warehouseId,
        date: plan.date,
        direction: plan.inverse,
        qty: plan.qty,
        value: plan.value,
        source,
        sourceId,
        docNo: plan.docNo,
        reason,
        memo: "Reversal",
        reversesId: plan.movementId,
      },
      session,
    );
    await StockMovementModel.updateOne(
      { _id: plan.movementId, org_id: orgId },
      { $set: { reversed: true } },
      session ? { session } : {},
    );
  }

  return plans.length;
}

/* ── Adjustments ─────────────────────────────────────────────────────────── */

export interface AdjustmentView {
  id: string;
  date: string;
  item_id: string;
  sku: string;
  item_name: string;
  warehouse_id: string;
  warehouse_name: string;
  direction: MovementDirection;
  qty: number;
  unit_cost_bdt: string;
  value_bdt: string;
  reason: string;
  journal_entry_id: string | null;
}

/**
 * Write stock on or off with no document behind it.
 *
 * The reason is required and the permission is a narrow one, because this is the
 * one place the value of the balance sheet can move without a trade to explain
 * it. A write-on with nothing on the book has no average to use, so it must name
 * a unit cost — averaging against zero would value the goods at nothing and
 * quietly understate inventory.
 */
export async function createAdjustment(
  orgId: string,
  uid: string,
  input: CreateAdjustmentInput,
  ip?: string,
): Promise<AdjustmentView> {
  return inTransaction(async (session) => {
    const item = await requireTrackedItem(orgId, input.item_id);
    const warehouse = input.warehouse_id
      ? await requireWarehouse(orgId, input.warehouse_id, session)
      : await defaultWarehouse(orgId, uid, session);

    const delta = new Decimal(String(input.qty_delta));
    const direction: MovementDirection = delta.greaterThan(ZERO) ? "IN" : "OUT";
    const qty = delta.abs();

    let value: Money;
    let movementId: string;

    if (direction === "IN") {
      const position = await readPosition(orgId, item.id, warehouse.id, session);
      const unitCost = input.unit_cost_bdt !== undefined ? money(input.unit_cost_bdt) : averageCost(position);
      if (unitCost.isZero() && input.unit_cost_bdt === undefined) {
        throw new AppError(
          422,
          "UNIT_COST_REQUIRED",
          `Nothing is on the book for ${item.name}, so there is no cost to value the found stock at. Give the adjustment a unit cost.`,
        );
      }
      value = receiptValue(qty, unitCost);
      const result = await receiveStock(
        orgId,
        uid,
        {
          itemId: item.id,
          itemLabel: item.name,
          warehouseId: warehouse.id,
          warehouseLabel: warehouse.name,
          date: input.date,
          qty,
          source: "ADJUSTMENT",
          reason: input.reason,
          memo: input.memo,
        },
        value,
        session,
      );
      movementId = result.movementId;
    } else {
      const result = await issueStock(
        orgId,
        uid,
        {
          itemId: item.id,
          itemLabel: item.name,
          warehouseId: warehouse.id,
          warehouseLabel: warehouse.name,
          date: input.date,
          qty,
          source: "ADJUSTMENT",
          reason: input.reason,
          memo: input.memo,
        },
        session,
      );
      value = result.value;
      movementId = result.movementId;
    }

    const description = `Stock adjustment — ${item.name} ${direction === "IN" ? "+" : "-"}${fmt(qty)} (${warehouse.name})`;

    // The ledger side. A gain debits inventory and credits the adjustment
    // account; a loss does the reverse. Nothing posts when nothing is worth
    // anything — a movement of free goods is still a movement, but there is no
    // amount for an entry to carry.
    let journalEntryId: string | null = null;
    if (!value.isZero()) {
      const entry = await postJournal(
        {
          orgId,
          uid,
          date: input.date,
          description,
          source: "STOCK_ADJUSTMENT",
          source_id: movementId,
          lines: [
            {
              account_code: direction === "IN" ? CONTROL_ACCOUNT.INVENTORY : CONTROL_ACCOUNT.STOCK_ADJUSTMENT,
              debit_bdt: fmt(value),
              credit_bdt: "0.00",
              memo: direction === "IN" ? description : input.reason,
            },
            {
              account_code: direction === "IN" ? CONTROL_ACCOUNT.STOCK_ADJUSTMENT : CONTROL_ACCOUNT.INVENTORY,
              debit_bdt: "0.00",
              credit_bdt: fmt(value),
              memo: direction === "IN" ? input.reason : description,
            },
          ],
          ...(ip ? { ip } : {}),
        },
        session,
      );
      journalEntryId = entry.id;
    }

    await writeAudit(
      {
        orgId,
        uid,
        entity: "inventory.movement",
        entityId: movementId,
        action: "STOCK_ADJUSTED",
        after: {
          item_id: item.id,
          sku: item.sku,
          warehouse_id: warehouse.id,
          direction,
          qty: Number(qty.toString()),
          value_bdt: fmt(value),
          reason: input.reason,
          journal_entry_id: journalEntryId,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return {
      id: movementId,
      date: input.date,
      item_id: item.id,
      sku: item.sku,
      item_name: item.name,
      warehouse_id: warehouse.id,
      warehouse_name: warehouse.name,
      direction,
      qty: Number(qty.toString()),
      unit_cost_bdt: fmt(qty.greaterThan(ZERO) ? value.dividedBy(qty) : ZERO),
      value_bdt: fmt(value),
      reason: input.reason,
      journal_entry_id: journalEntryId,
    };
  });
}

/* ── Transfers ───────────────────────────────────────────────────────────── */

export interface TransferView {
  date: string;
  item_id: string;
  sku: string;
  item_name: string;
  from_warehouse_id: string;
  from_warehouse_name: string;
  to_warehouse_id: string;
  to_warehouse_name: string;
  qty: number;
  value_bdt: string;
  out_movement_id: string;
  in_movement_id: string;
}

/**
 * Move goods between two of the organisation's own warehouses.
 *
 * No journal entry: the control account's total is unchanged, so writing one
 * would be a posting that says nothing. The value travels with the goods at the
 * cost they left at, so the destination's average reflects what they actually
 * cost rather than today's price elsewhere.
 */
export async function createStockTransfer(
  orgId: string,
  uid: string,
  input: CreateStockTransferInput,
  ip?: string,
): Promise<TransferView> {
  if (input.from_warehouse_id === input.to_warehouse_id) {
    throw new AppError(
      422,
      "SAME_WAREHOUSE",
      "A transfer needs two different warehouses — moving goods to where they already are changes nothing.",
    );
  }

  return inTransaction(async (session) => {
    const item = await requireTrackedItem(orgId, input.item_id);
    const from = await requireWarehouse(orgId, input.from_warehouse_id, session);
    const to = await requireWarehouse(orgId, input.to_warehouse_id, session);
    const qty = new Decimal(String(input.qty));

    const out = await issueStock(
      orgId,
      uid,
      {
        itemId: item.id,
        itemLabel: item.name,
        warehouseId: from.id,
        warehouseLabel: from.name,
        date: input.date,
        qty,
        source: "TRANSFER",
        memo: `Transfer to ${to.name}${input.memo ? ` — ${input.memo}` : ""}`,
      },
      session,
    );

    const into = await receiveStock(
      orgId,
      uid,
      {
        itemId: item.id,
        itemLabel: item.name,
        warehouseId: to.id,
        warehouseLabel: to.name,
        date: input.date,
        qty,
        source: "TRANSFER",
        memo: `Transfer from ${from.name}${input.memo ? ` — ${input.memo}` : ""}`,
      },
      out.value,
      session,
    );

    await writeAudit({
      orgId,
      uid,
      entity: "inventory.transfer",
      entityId: out.movementId,
      action: "STOCK_TRANSFERRED",
      after: {
        item_id: item.id,
        sku: item.sku,
        from_warehouse_id: from.id,
        to_warehouse_id: to.id,
        qty: Number(qty.toString()),
        value_bdt: fmt(out.value),
      },
      ...(ip ? { ip } : {}),
    });

    return {
      date: input.date,
      item_id: item.id,
      sku: item.sku,
      item_name: item.name,
      from_warehouse_id: from.id,
      from_warehouse_name: from.name,
      to_warehouse_id: to.id,
      to_warehouse_name: to.name,
      qty: Number(qty.toString()),
      value_bdt: fmt(out.value),
      out_movement_id: out.movementId,
      in_movement_id: into.movementId,
    };
  });
}

/* ── Stocktakes ──────────────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStocktakeView(doc: any, warehouseName: string): StocktakeView {
  const lines: StocktakeLineView[] = (doc.lines ?? []).map((line: Record<string, unknown>) => ({
    item_id: String(line["item_id"]),
    sku_snapshot: (line["sku_snapshot"] as string) ?? "",
    label_snapshot: (line["label_snapshot"] as string) ?? "",
    expected_qty: Number(line["expected_qty"] ?? 0),
    counted_qty: Number(line["counted_qty"] ?? 0),
    variance_qty: Number(line["variance_qty"] ?? 0),
    unit_cost_bdt: (line["unit_cost_bdt"] as string) ?? "0.00",
    variance_value_bdt: (line["variance_value_bdt"] as string) ?? "0.00",
  }));

  const qtyTotal = Number((doc.lines ?? []).reduce(
    (acc: number, line: Record<string, unknown>) => acc + Number(line["variance_qty"] ?? 0),
    0,
  ));
  const valueTotal = (doc.lines ?? []).reduce(
    (acc: Money, line: Record<string, unknown>) => acc.plus(money((line["variance_value_bdt"] as string) ?? "0.00")),
    ZERO,
  );

  return {
    id: String(doc._id),
    warehouse_id: String(doc.warehouse_id),
    warehouse_name: warehouseName,
    date: doc.date,
    status: doc.status,
    memo: doc.memo ?? "",
    lines,
    variance_qty_total: qtyTotal,
    variance_value_bdt: fmt(valueTotal),
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    posted_by: doc.posted_by ?? "",
    posted_at: doc.posted_at ? new Date(doc.posted_at).toISOString() : null,
  };
}

/**
 * Draw up a count: what the book says now, against what somebody counted.
 *
 * The expected quantity and the cost are snapshotted here, so the worksheet
 * compares the count against the book as it was when the count was taken. A
 * worksheet that recomputed its own expectation later would quietly move the
 * goalposts to wherever the book had drifted to.
 */
export async function createStocktake(
  orgId: string,
  uid: string,
  input: CreateStocktakeInput,
  ip?: string,
): Promise<StocktakeView> {
  return inTransaction(async (session) => {
    const warehouse = input.warehouse_id
      ? await requireWarehouse(orgId, input.warehouse_id, session)
      : await defaultWarehouse(orgId, uid, session);

    const items = await itemMap(
      orgId,
      input.lines.map((line) => line.item_id),
    );

    const lines = await Promise.all(
      input.lines.map(async (line) => {
        const item = items.get(line.item_id);
        if (!item) throw new AppError(422, "ITEM_NOT_FOUND", "A counted line names an item that does not exist here.");
        if (!item.track_stock) {
          throw new AppError(
            422,
            "ITEM_NOT_TRACKED",
            `${item.name} is not stock-tracked, so there is nothing to count against.`,
          );
        }

        const position = await readPosition(orgId, item.id, warehouse.id, session);
        const expected = Number(position.qty.toString());
        const unitCost = line.unit_cost_bdt !== undefined ? money(line.unit_cost_bdt) : toPaisa(averageCost(position));
        const variance = line.counted_qty - expected;
        const varianceValue = toPaisa(unitCost.times(Math.abs(variance)));

        return {
          item_id: item.id,
          label_snapshot: item.name,
          sku_snapshot: item.sku,
          expected_qty: expected,
          counted_qty: line.counted_qty,
          variance_qty: variance,
          unit_cost_bdt: fmt(unitCost),
          variance_value_bdt: fmt(varianceValue),
        };
      }),
    );

    const created = await StocktakeModel.create(
      [
        {
          org_id: orgId,
          warehouse_id: warehouse.id,
          date: input.date,
          status: "DRAFT",
          memo: input.memo,
          lines,
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    const view = toStocktakeView(created.toObject(), warehouse.name);

    await writeAudit(
      {
        orgId,
        uid,
        entity: "inventory.stocktake",
        entityId: view.id,
        action: "STOCKTAKE_DRAFTED",
        after: {
          warehouse_id: warehouse.id,
          date: input.date,
          line_count: lines.length,
          variance_qty_total: view.variance_qty_total,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}

/**
 * Post the count.
 *
 * Every variance becomes a movement, and the net of them becomes one journal
 * entry against 5600 Waste & Shrinkage — a shortfall is a cost, a surplus
 * reverses it. A count that finds exactly what the book said posts nothing: the
 * worksheet is still recorded, because a count that agreed is a fact worth
 * having, but there is no amount for an entry to carry.
 *
 * The values written back onto the worksheet are the ones the movements actually
 * moved, not the estimates drawn up with it: a shortfall is costed at the
 * average as it stands at posting, and the worksheet should say so rather than
 * keep a figure nothing was ever posted at.
 */
export async function postStocktake(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<StocktakeView> {
  assertObjectId(id, "That stocktake does not exist.");

  return inTransaction(async (session) => {
    const stocktake = await StocktakeModel.findOne({ _id: id, org_id: orgId })
      .session(session)
      .lean();
    if (!stocktake) throw notFoundError("That stocktake does not exist.");
    if (stocktake.status === "POSTED") {
      throw new AppError(409, "STOCKTAKE_POSTED", "That stocktake has already been posted.");
    }

    const warehouse = await requireWarehouse(orgId, String(stocktake.warehouse_id), session);
    const items = await itemMap(
      orgId,
      (stocktake.lines ?? []).map((line) => line.item_id),
    );

    const written: Array<Record<string, unknown>> = [];
    let net: Money = ZERO;

    for (const line of stocktake.lines ?? []) {
      const variance = new Decimal(String(line.variance_qty ?? 0));
      const unitCost = money(line.unit_cost_bdt ?? "0.00");
      const item = items.get(String(line.item_id));

      if (variance.isZero() || !item) {
        written.push({ ...(line as unknown as Record<string, unknown>) });
        continue;
      }

      const qty = variance.abs();
      const context = {
        itemId: item.id,
        itemLabel: item.name,
        warehouseId: warehouse.id,
        warehouseLabel: warehouse.name,
        date: stocktake.date,
        qty,
        source: "STOCKTAKE" as const,
        sourceId: id,
        reason,
        memo: stocktake.memo,
      };

      // A count that finds stock the book has no cost for must value it, the
      // same as an adjustment does.
      if (variance.greaterThan(ZERO) && unitCost.isZero()) {
        throw new AppError(
          422,
          "UNIT_COST_REQUIRED",
          `The count found ${item.name} that the book has no cost for, so there is nothing to value it at. Give that line a unit cost.`,
        );
      }

      const applied = variance.greaterThan(ZERO)
        ? await receiveStock(orgId, uid, context, receiptValue(qty, unitCost), session)
        : await issueStock(orgId, uid, context, session);

      net = net.plus(variance.greaterThan(ZERO) ? applied.value : applied.value.negated());
      written.push({
        ...(line as unknown as Record<string, unknown>),
        unit_cost_bdt: fmt(qty.greaterThan(ZERO) ? applied.value.dividedBy(qty) : unitCost),
        variance_value_bdt: fmt(applied.value),
      });
    }

    const description = `Stocktake variance — ${warehouse.name} ${stocktake.date}`;
    let journalEntryId: string | null = null;
    if (!net.isZero()) {
      const gained = net.greaterThan(ZERO);
      const amount = net.abs();
      const entry = await postJournal(
        {
          orgId,
          uid,
          date: stocktake.date,
          description,
          source: "STOCKTAKE",
          source_id: id,
          lines: [
            {
              account_code: gained ? CONTROL_ACCOUNT.INVENTORY : CONTROL_ACCOUNT.STOCK_ADJUSTMENT,
              debit_bdt: fmt(amount),
              credit_bdt: "0.00",
              memo: description,
            },
            {
              account_code: gained ? CONTROL_ACCOUNT.STOCK_ADJUSTMENT : CONTROL_ACCOUNT.INVENTORY,
              debit_bdt: "0.00",
              credit_bdt: fmt(amount),
              memo: reason,
            },
          ],
          ...(ip ? { ip } : {}),
        },
        session,
      );
      journalEntryId = entry.id;
    }

    const updated = await StocktakeModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: "DRAFT" },
      {
        $set: {
          status: "POSTED",
          lines: written,
          journal_entry_id: journalEntryId,
          posted_by: uid,
          posted_at: new Date(),
        },
      },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "STOCKTAKE_POSTED", "That stocktake was posted by another request a moment ago.");
    }

    const view = toStocktakeView(updated, warehouse.name);

    await writeAudit(
      {
        orgId,
        uid,
        entity: "inventory.stocktake",
        entityId: id,
        action: "STOCKTAKE_POSTED",
        before: { status: "DRAFT" },
        after: {
          status: "POSTED",
          variance_qty_total: view.variance_qty_total,
          variance_value_bdt: view.variance_value_bdt,
          journal_entry_id: journalEntryId,
          reason,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

async function warehouseNames(orgId: string): Promise<Map<string, { code: string; name: string }>> {
  const rows = await WarehouseModel.find({ org_id: orgId }).select({ code: 1, name: 1 }).lean();
  return new Map(rows.map((row) => [String(row._id), { code: row.code, name: row.name }]));
}

async function itemLabels(orgId: string): Promise<Map<string, { sku: string; name: string }>> {
  const rows = await ItemModel.find({ org_id: orgId }).select({ sku: 1, name: 1 }).lean();
  return new Map(rows.map((row) => [String(row._id), { sku: row.sku, name: row.name }]));
}

/** What is on hand, per item per warehouse, with the totals the screen's header
 *  shows and the low-stock reading that only means something per item. */
export async function listStock(
  orgId: string,
  query: { warehouse_id?: string; item_id?: string },
): Promise<{ balances: StockBalanceView[]; low_stock: LowStockRow[]; summary: StockSummary }> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.warehouse_id) filter["warehouse_id"] = query.warehouse_id;
  if (query.item_id) filter["item_id"] = query.item_id;

  const [balanceRows, trackedItems, warehouses] = await Promise.all([
    StockBalanceModel.find(filter).sort({ item_id: 1 }).lean(),
    ItemModel.find({ org_id: orgId, track_stock: true })
      .select({ sku: 1, name: 1, reorder_level: 1 })
      .lean(),
    warehouseNames(orgId),
  ]);

  const labels = await itemLabels(orgId);
  const itemReorders = new Map(trackedItems.map((item) => [String(item._id), Number(item.reorder_level ?? 0)]));

  const balances: StockBalanceView[] = balanceRows.map((row) => {
    const itemId = String(row.item_id);
    const label = labels.get(itemId);
    const warehouse = warehouses.get(String(row.warehouse_id));
    const reorder = itemReorders.get(itemId) ?? 0;
    const qty = Number(row.qty ?? 0);
    return {
      item_id: itemId,
      sku: label?.sku ?? "",
      item_name: label?.name ?? "",
      warehouse_id: String(row.warehouse_id),
      warehouse_code: warehouse?.code ?? "",
      warehouse_name: warehouse?.name ?? "",
      qty,
      value_bdt: row.value_bdt ?? "0.00",
      avg_cost_bdt: row.avg_cost_bdt ?? "0.00",
      reorder_level: reorder,
      low_stock: qty <= reorder,
    };
  });

  // The low-stock reading is per item, across every warehouse: an item is short
  // when the business is short of it, not when one shelf of it is.
  const byItem = new Map<string, { qty: number; value: Money }>();
  for (const row of balanceRows) {
    const key = String(row.item_id);
    const existing = byItem.get(key) ?? { qty: 0, value: ZERO };
    byItem.set(key, {
      qty: existing.qty + Number(row.qty ?? 0),
      value: existing.value.plus(money(row.value_bdt ?? "0.00")),
    });
  }

  const low_stock: LowStockRow[] = trackedItems
    .map((item) => {
      const id = String(item._id);
      const held = byItem.get(id) ?? { qty: 0, value: ZERO };
      const reorder = Number(item.reorder_level ?? 0);
      return {
        item_id: id,
        sku: item.sku,
        item_name: item.name,
        on_hand: held.qty,
        value_bdt: fmt(held.value),
        avg_cost_bdt: fmt(held.qty > 0 ? held.value.dividedBy(held.qty) : ZERO),
        reorder_level: reorder,
      };
    })
    .filter((row) => row.on_hand <= row.reorder_level)
    .sort((a, b) => a.on_hand - b.on_hand || a.sku.localeCompare(b.sku));

  const total_value = balanceRows.reduce((acc, row) => acc.plus(money(row.value_bdt ?? "0.00")), ZERO);

  return {
    balances,
    low_stock,
    summary: {
      item_count: byItem.size,
      tracked_item_count: trackedItems.length,
      warehouse_count: warehouses.size,
      total_qty: balanceRows.reduce((acc, row) => acc + Number(row.qty ?? 0), 0),
      total_value_bdt: fmt(total_value),
      low_stock_count: low_stock.length,
    },
  };
}

/** The movement ledger — what happened, newest first, with the labels a reader
 *  needs so the screen is not a list of ids. */
export async function listMovements(
  orgId: string,
  query: ListMovementsInput,
): Promise<StockMovementView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.item_id) filter["item_id"] = query.item_id;
  if (query.warehouse_id) filter["warehouse_id"] = query.warehouse_id;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await StockMovementModel.find(filter)
    .sort({ date: -1, createdAt: -1 })
    .limit(query.limit)
    .lean();
  if (rows.length === 0) return [];

  const [labels, warehouses] = await Promise.all([itemLabels(orgId), warehouseNames(orgId)]);

  return rows.map((row) => {
    const label = labels.get(String(row.item_id));
    return {
      id: String(row._id),
      date: row.date,
      direction: row.direction,
      item_id: String(row.item_id),
      sku: label?.sku ?? "",
      item_name: label?.name ?? "",
      warehouse_id: String(row.warehouse_id),
      warehouse_name: warehouses.get(String(row.warehouse_id))?.name ?? "",
      qty: Number(row.qty ?? 0),
      value_bdt: row.value_bdt ?? "0.00",
      unit_cost_bdt: row.unit_cost_bdt ?? "0.00",
      source: row.source,
      source_id: row.source_id ?? "",
      doc_no: row.doc_no ?? "",
      reason: row.reason ?? "",
      memo: row.memo ?? "",
      reversed: row.reversed === true,
      reverses_movement_id: row.reverses_movement_id ? String(row.reverses_movement_id) : null,
    };
  });
}

export async function listStocktakes(
  orgId: string,
  query: { status?: "DRAFT" | "POSTED"; limit: number },
): Promise<StocktakeView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.status) filter["status"] = query.status;

  const rows = await StocktakeModel.find(filter).sort({ date: -1, createdAt: -1 }).limit(query.limit).lean();
  if (rows.length === 0) return [];

  const warehouses = await warehouseNames(orgId);
  return rows.map((row) => toStocktakeView(row, warehouses.get(String(row.warehouse_id))?.name ?? ""));
}

export async function getStocktake(orgId: string, id: string): Promise<StocktakeView> {
  assertObjectId(id, "That stocktake does not exist.");

  const doc = await StocktakeModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That stocktake does not exist.");

  const warehouses = await warehouseNames(orgId);
  return toStocktakeView(doc, warehouses.get(String(doc.warehouse_id))?.name ?? "");
}
