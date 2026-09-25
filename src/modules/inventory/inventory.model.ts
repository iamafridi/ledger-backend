/**
 * Inventory — the four collections of plan §6, Phase 8.
 *
 * A STOCK LEDGER, NOT A STOCK FIELD
 * The temptation with stock is to put a `qty_on_hand` column on the item and
 * increment it. That number can never be explained: it cannot say when the goods
 * arrived, what they cost, or who moved them. So the truth is a **movement** —
 * an append-only row saying "this many of this item entered or left this
 * warehouse on this date, at this value, because of this document" — and
 * everything else is a reading of it.
 *
 *   warehouses      where stock physically sits
 *   stockMovements  what happened, once, permanently
 *   stockBalances   quantity and value on hand, per item per warehouse — a
 *                   *cache* of the movements, rewritten only by the service
 *   stocktakes      a counted worksheet, and the variance it posted
 *
 * WHY MOVEMENTS ARE NEVER DELETED
 * A voided bill does not remove the movement that received its goods; it writes
 * the opposite movement, exactly as `posting.ts` voiding writes a reversing
 * entry rather than deleting one. The full history stays readable, and a
 * movement that has already been reversed says so.
 *
 * A TRANSFER IS TWO MOVEMENTS AND NO JOURNAL ENTRY
 * Moving goods between two of your own warehouses changes where they are, not
 * what they are worth, so the shop's inventory control account is untouched. The
 * pair of movements keeps each warehouse's own average honest while the total
 * value is unchanged — which is the property the exit gate's `I5-STOCK` check
 * confirms.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField, DATE_PATTERN } from "../../shared/db/money-field.js";

/* ── Warehouses ──────────────────────────────────────────────────────────── */

/**
 * Where stock sits. A business with one storehouse still has one of these, so
 * there is no "no warehouse" case to special-case anywhere: a sale consumes from
 * a warehouse, a bill puts goods into a warehouse, and which one is a fact
 * somebody chooses rather than an absence.
 */
const warehouseSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    /** Short human-typed identity, unique per org and fixed after creation. */
    code: { type: String, required: true, trim: true, maxlength: 16 },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    address: { type: String, trim: true, maxlength: 300, default: "" },

    /** The warehouse a document that names none means. Only one per org, and the
     *  service maintains that — a default is a convenience, not a constraint. */
    is_default: { type: Boolean, default: false },

    is_active: { type: Boolean, default: true, index: true },

    created_by: { type: String, default: "" },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

warehouseSchema.index({ org_id: 1, code: 1 }, { unique: true });
warehouseSchema.index({ org_id: 1, name: 1 });

/* ── Stock movements ─────────────────────────────────────────────────────── */

export const MOVEMENT_DIRECTIONS = ["IN", "OUT"] as const;
export type MovementDirection = (typeof MOVEMENT_DIRECTIONS)[number];

/** What produced a movement. A `BILL` puts goods on the shelf, an `INVOICE`
 *  takes them off, and the rest are the ways stock changes without a trade. */
export const MOVEMENT_SOURCES = [
  "BILL",
  "INVOICE",
  "ADJUSTMENT",
  "TRANSFER",
  "STOCKTAKE",
  "OPENING",
  "REVERSAL",
] as const;
export type MovementSource = (typeof MOVEMENT_SOURCES)[number];

/**
 * One change to what is on a shelf.
 *
 * `value_bdt` is the movement's own amount and is never negative: the direction
 * says which way it went, exactly as a journal line's side does. `unit_cost_bdt`
 * is stored for readability — it is the value divided by the quantity, and it is
 * what an issue was costed at before the average moved on.
 *
 * `reversed` is set on the movement a void *undoes*, and the void writes a new
 * row pointing back at it through `reverses_movement_id`. Both rows stay: the
 * pair nets to nothing, and an auditor can see that the goods went in, and then
 * that they were taken back out, and why.
 */
const stockMovementSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    item_id: { type: Schema.Types.ObjectId, ref: "Item", required: true, index: true },
    warehouse_id: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true, index: true },

    date: { type: String, required: true, match: DATE_PATTERN, index: true },

    direction: { type: String, enum: MOVEMENT_DIRECTIONS, required: true },

    /** A physical quantity (1.5 kg is legitimate), not money — so a Number, as
     *  on a document line, and multiplied into a money value by decimal
     *  arithmetic rather than stored as one. */
    qty: { type: Number, required: true, min: 0 },
    value_bdt: moneyField(),
    unit_cost_bdt: moneyField(false),

    source: { type: String, enum: MOVEMENT_SOURCES, required: true },
    /** The document that caused it — a bill or invoice id. Blank for a movement
     *  with no document behind it (an opening balance, say). */
    source_id: { type: String, default: "", maxlength: 64 },
    doc_no: { type: String, default: "", maxlength: 32 },

    /** Why, for the movements whose reason is not a document: an adjustment
     *  must say what it is for, and the service refuses a blank one. */
    reason: { type: String, trim: true, maxlength: 300, default: "" },
    memo: { type: String, trim: true, maxlength: 300, default: "" },

    reverses_movement_id: { type: Schema.Types.ObjectId, ref: "StockMovement", default: null },
    reversed: { type: Boolean, default: false },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

stockMovementSchema.index({ org_id: 1, date: -1, createdAt: -1 });
stockMovementSchema.index({ org_id: 1, item_id: 1, date: -1 });
stockMovementSchema.index({ org_id: 1, source: 1, source_id: 1, reversed: 1 });

/* ── Stock balances ──────────────────────────────────────────────────────── */

/**
 * What is on hand, per item per warehouse.
 *
 * A cache, and the service is its only writer — the same rule the invoice
 * settlement cache follows. It exists because a stock screen reads every item at
 * once and must not replay the whole movement history to answer "how many are
 * there?". Recomputing from the movements is the repair path; this row is the
 * fast path.
 *
 * The unit of the average is (item, warehouse), not item: two warehouses hold
 * goods that arrived in different lots at different prices, and pretending they
 * share one average would misstate the cost of the next sale from either.
 */
const stockBalanceSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    item_id: { type: Schema.Types.ObjectId, ref: "Item", required: true, index: true },
    warehouse_id: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true, index: true },

    qty: { type: Number, required: true, default: 0, min: 0 },
    value_bdt: moneyField(false),
    /** `value_bdt ÷ qty`, stored so a screen can show what the next unit costs
     *  without dividing a string. Derived, never authoritative. */
    avg_cost_bdt: moneyField(false),

    last_movement_at: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
);

stockBalanceSchema.index({ org_id: 1, item_id: 1, warehouse_id: 1 }, { unique: true });
stockBalanceSchema.index({ org_id: 1, warehouse_id: 1 });

/* ── Stocktakes ──────────────────────────────────────────────────────────── */

/**
 * One line of a count.
 *
 * The expected quantity and the unit cost are **snapshotted** when the worksheet
 * is drawn up, for the same reason a document snapshots its tax rate: what the
 * count is compared against must be the figure that was true when somebody was
 * standing in the warehouse, not whatever the book says a week later when the
 * worksheet is finally posted.
 *
 * The variance value is stored unsigned — its direction is `variance_qty`'s sign,
 * the same rule every other amount in this codebase follows.
 */
const stocktakeLineSchema = new Schema(
  {
    item_id: { type: Schema.Types.ObjectId, ref: "Item", required: true },
    label_snapshot: { type: String, trim: true, maxlength: 160, default: "" },
    sku_snapshot: { type: String, trim: true, maxlength: 32, default: "" },

    expected_qty: { type: Number, required: true, default: 0, min: 0 },
    counted_qty: { type: Number, required: true, default: 0, min: 0 },
    /** Signed: counted − expected. A Number, like every quantity. */
    variance_qty: { type: Number, required: true, default: 0 },

    /** What the variance is valued at — the item's average when the worksheet
     *  was drawn up, unless the counter supplied a cost for stock that was not
     *  on the book at all. */
    unit_cost_bdt: moneyField(false),
    variance_value_bdt: moneyField(false),
  },
  { _id: false },
);

/**
 * A counted worksheet, DRAFT until it is posted.
 *
 * Posting is a separate act with its own permission and a required reason: a
 * stocktake variance is the one way the value of the balance sheet can move
 * without a document behind it, so it is signed for rather than saved.
 */
const stocktakeSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    warehouse_id: { type: Schema.Types.ObjectId, ref: "Warehouse", required: true, index: true },

    date: { type: String, required: true, match: DATE_PATTERN },
    status: { type: String, enum: ["DRAFT", "POSTED"], default: "DRAFT", index: true },

    memo: { type: String, trim: true, maxlength: 300, default: "" },
    lines: { type: [stocktakeLineSchema], default: [] },

    /** The variance posting. Null on a worksheet whose lines all counted true. */
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },

    created_by: { type: String, required: true },
    posted_by: { type: String, default: "" },
    posted_at: { type: Date },
  },
  { timestamps: true, versionKey: false },
);

stocktakeSchema.index({ org_id: 1, date: -1 });

export type WarehouseDocument = InferSchemaType<typeof warehouseSchema>;
export type StockMovementDocument = InferSchemaType<typeof stockMovementSchema>;
export type StockBalanceDocument = InferSchemaType<typeof stockBalanceSchema>;
export type StocktakeDocument = InferSchemaType<typeof stocktakeSchema>;

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled model
 *  instead of throwing OverwriteModelError on re-registration. */
export const WarehouseModel =
  (mongoose.models["Warehouse"] as Model<WarehouseDocument> | undefined) ??
  mongoose.model<WarehouseDocument>("Warehouse", warehouseSchema);

export const StockMovementModel =
  (mongoose.models["StockMovement"] as Model<StockMovementDocument> | undefined) ??
  mongoose.model<StockMovementDocument>("StockMovement", stockMovementSchema);

export const StockBalanceModel =
  (mongoose.models["StockBalance"] as Model<StockBalanceDocument> | undefined) ??
  mongoose.model<StockBalanceDocument>("StockBalance", stockBalanceSchema);

export const StocktakeModel =
  (mongoose.models["Stocktake"] as Model<StocktakeDocument> | undefined) ??
  mongoose.model<StocktakeDocument>("Stocktake", stocktakeSchema);
