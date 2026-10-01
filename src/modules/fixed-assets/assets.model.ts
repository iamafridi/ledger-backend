/**
 * Fixed assets — the two collections of plan §6, Phase 9.
 *
 * A REGISTER, NOT A BALANCE
 * The fixed-asset control account (1500) is one number on the balance sheet. It
 * cannot answer the only questions anybody asks about fixed assets: which ones do
 * we have, what did each cost, how much of each is left, and when does it finish
 * being written down. So the register holds one row per asset, the depreciation
 * runs are an append-only record of what has been charged, and the control account
 * is read as the *total* of the register — an equality the integrity run asserts
 * (`I5-FIXED-ASSETS`).
 *
 *   fixedAssets       what the organisation owns, and how it is written down
 *   depreciationRuns  one row per asset per period: what was charged, when, and
 *                     which journal entry carried it
 *
 * WHY A RUN IS PER ASSET PER PERIOD, NOT ONE ROW PER MONTH
 * The invariant that matters is "an asset is depreciated once for a given month".
 * A monthly batch row cannot express that — it would have to police its own
 * contents. One row per (asset, period) can, with a unique index, so the guarantee
 * is the database's rather than a service's memory. The rows a single run created
 * share a `run_batch_id` and one journal entry, so a run is still one document in
 * the ledger: `DR depreciation expense / CR accumulated depreciation`.
 *
 * WHY A REVERSED RUN STAYS
 * A run that was wrong is not deleted, for the same reason a voided entry is not:
 * the journal has already printed. The row keeps its figures, gains `status:
 * "REVERSED"`, and the entry behind it is voided by writing its mirror. The unique
 * index is partial on `status: "POSTED"`, which is what lets the corrected run for
 * the same month be posted afterwards — reversing and re-running is the normal way
 * somebody fixes a depreciation mistake.
 *
 * WHAT IS CACHED, AND WHY THAT IS SAFE
 * `accumulated_depreciation_bdt` on the asset is a cache of the runs, kept because
 * every register screen and every eligibility test needs it. It is rewritten only
 * by the service, and three things hold it honest: each run row records
 * `accum_before` and `accum_after`, so the arithmetic is checkable from the rows
 * alone; the integrity run recomputes it from the runs and compares; and the GL
 * balance of 1510 is compared against the same total. A drifting cache is the
 * failure this design is built to make loud.
 */
import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { moneyField, DATE_PATTERN, MONTH_PATTERN } from "../../shared/db/money-field.js";

export const ASSET_STATUSES = ["ACTIVE", "DISPOSED"] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

/** Only one method today. It is stored rather than assumed so a second one
 *  (reducing balance, units of production) can be added without every existing
 *  row silently changing meaning. */
export const DEPRECIATION_METHODS = ["STRAIGHT_LINE"] as const;
export type DepreciationMethod = (typeof DEPRECIATION_METHODS)[number];

export const DEPRECIATION_RUN_STATUSES = ["POSTED", "REVERSED"] as const;
export type DepreciationRunStatus = (typeof DEPRECIATION_RUN_STATUSES)[number];

/* ── Disposal ────────────────────────────────────────────────────────────── */

/**
 * How an asset left the books.
 *
 * `gain_bdt` and `loss_bdt` are two fields rather than one signed one, because
 * they post to two different accounts and an amount's direction in this codebase
 * is never its sign. Exactly one of them is non-zero, and both are zero when the
 * proceeds equalled the net book value.
 *
 * The net book value and the accumulated depreciation at the moment of disposal
 * are **snapshotted**: they are the figures the disposal entry was written from,
 * and reading them back later from the asset would show the state after the entry
 * moved it, which is not what the entry says.
 */
const disposalSchema = new Schema(
  {
    date: { type: String, required: true, match: DATE_PATTERN },
    /** What the asset fetched — zero for something scrapped, which is a
     *  disposal like any other, not a special case. */
    proceeds_bdt: moneyField(false),
    proceeds_account_code: { type: String, trim: true, maxlength: 24, default: "" },
    reason: { type: String, required: true, trim: true, maxlength: 300 },

    cost_bdt: moneyField(false),
    accumulated_bdt: moneyField(false),
    nbv_bdt: moneyField(false),
    gain_bdt: moneyField(false),
    loss_bdt: moneyField(false),
    gain_account_code: { type: String, trim: true, maxlength: 24, default: "" },
    loss_account_code: { type: String, trim: true, maxlength: 24, default: "" },

    /** The disposal posting itself, and the entry that reversed it if the
     *  disposal was undone. Both null together mean "still disposed". */
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    voided_by_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    void_reason: { type: String, trim: true, maxlength: 300, default: "" },

    disposed_by: { type: String, default: "" },
  },
  { _id: false },
);

/* ── Fixed assets ────────────────────────────────────────────────────────── */

const fixedAssetSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },

    /** The tag somebody writes on the machine: unique per org and fixed after
     *  creation, the same rule a warehouse code and an item SKU follow. */
    code: { type: String, required: true, trim: true, maxlength: 24 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    /** Free text grouping — "Vehicles", "Office equipment". Not a catalog: a
     *  fixed-asset category carries no behaviour, only a label. */
    category: { type: String, trim: true, maxlength: 60, default: "" },

    /** Both the day it was bought and the day it entered service (see the
     *  service's note) — one date, because a register that tracks two would
     *  disagree with itself about which one the schedule starts from. */
    purchase_date: { type: String, required: true, match: DATE_PATTERN, index: true },

    cost_bdt: moneyField(),
    /** What it is expected to be worth at the end of its life. Never
     *  depreciated, and refused above cost. */
    salvage_bdt: moneyField(false),
    /** Months, not years: the charge is monthly, so months are the unit the
     *  arithmetic is exact in. A screen shows the years. */
    useful_life_months: { type: Number, required: true, min: 1, max: 1200 },
    method: { type: String, enum: DEPRECIATION_METHODS, default: "STRAIGHT_LINE" },

    /** Where this asset's cost, and its accumulated depreciation, sit. Per asset
     *  rather than hard-coded, so a second class of asset can be reported on its
     *  own line of the balance sheet. */
    asset_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    accum_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    dep_expense_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    /** Where a disposal gain and a loss post. Defaulted rather than seeded: the
     *  chart every organisation starts with has no dedicated pair, and inventing
     *  codes for existing ledgers would leave them missing on the tenants that
     *  were created before this phase. An organisation that disposes of assets
     *  often points these at accounts it creates itself. */
    gain_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    loss_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    /** Where the money came from on a direct acquisition. Blank when the cost
     *  reached the asset account some other way. */
    proceeds_account_code: { type: String, trim: true, maxlength: 24, default: "" },

    /** The acquisition posting, when the register made it. Null when the cost was
     *  already in the control account — a bill line coded to 1500 — because
     *  posting it again would double the asset. */
    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    /** Where the cost came in from, as a label for a reader: a bill number, a
     *  voucher, whatever the person registering it wants on the record. */
    acquired_via: { type: String, enum: ["POSTED", "REGISTERED"], default: "REGISTERED" },
    source_doc_no: { type: String, trim: true, maxlength: 60, default: "" },

    /* ── The cached write-down, and where it got to ─────────────────────── */
    accumulated_depreciation_bdt: moneyField(false),
    /** The last month charged, so the next run knows where to continue from and
     *  an asset that was never run says so with an empty string. */
    last_depreciated_period: { type: String, match: MONTH_PATTERN, default: "" },

    status: { type: String, enum: ASSET_STATUSES, default: "ACTIVE", index: true },
    disposal: { type: disposalSchema, default: null },

    notes: { type: String, trim: true, maxlength: 500, default: "" },

    created_by: { type: String, required: true },
    updated_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

fixedAssetSchema.index({ org_id: 1, code: 1 }, { unique: true });
fixedAssetSchema.index({ org_id: 1, status: 1, purchase_date: 1 });

/* ── Depreciation runs ───────────────────────────────────────────────────── */

/**
 * One asset's depreciation for one period.
 *
 * The unique index is the idempotency guarantee, and it is deliberately **partial
 * on POSTED**: reversing a run and posting a corrected one for the same month is
 * the normal way a mistake is fixed, and a plain unique index would make that
 * impossible without deleting history — which this codebase never does.
 */
const depreciationRunSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    asset_id: { type: Schema.Types.ObjectId, ref: "FixedAsset", required: true, index: true },

    period_key: { type: String, required: true, match: MONTH_PATTERN, index: true },
    /** The day the charge is dated: the last day of the period, so a run made on
     *  the 3rd still lands inside the month it belongs to. */
    date: { type: String, required: true, match: DATE_PATTERN },

    amount_bdt: moneyField(),
    /** Snapshots, so the arithmetic is checkable from the runs alone and a later
     *  edit to the asset cannot rewrite what a past month was charged on. */
    cost_bdt: moneyField(false),
    salvage_bdt: moneyField(false),
    accum_before_bdt: moneyField(false),
    accum_after_bdt: moneyField(false),
    nbv_after_bdt: moneyField(false),

    expense_account_code: { type: String, required: true, trim: true, maxlength: 24 },
    accum_account_code: { type: String, required: true, trim: true, maxlength: 24 },

    /** Ties the rows one run created together: they share a journal entry, and a
     *  reversal undoes the whole batch rather than a row at a time. */
    run_batch_id: { type: String, required: true, maxlength: 64, index: true },

    days_charged: { type: Number, required: true, min: 0 },
    days_in_month: { type: Number, required: true, min: 1 },
    /** Short of a full month: the first month, or a month a disposal cut off. */
    prorated: { type: Boolean, default: false },
    /** True on the charge that finished the asset off. */
    final: { type: Boolean, default: false },

    journal_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", required: true },

    status: { type: String, enum: DEPRECIATION_RUN_STATUSES, default: "POSTED", index: true },
    /** The entry that cancelled this row's charge, when the run was reversed. */
    reversed_by_entry_id: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    reason: { type: String, trim: true, maxlength: 300, default: "" },

    created_by: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);

depreciationRunSchema.index(
  { org_id: 1, asset_id: 1, period_key: 1 },
  { unique: true, partialFilterExpression: { status: "POSTED" } },
);
depreciationRunSchema.index({ org_id: 1, period_key: 1, status: 1 });
depreciationRunSchema.index({ org_id: 1, createdAt: -1 });

export type FixedAssetDocument = InferSchemaType<typeof fixedAssetSchema>;
export type DepreciationRunDocument = InferSchemaType<typeof depreciationRunSchema>;

/** `mongoose.models` first, so a dev-server hot reload reuses the compiled model
 *  instead of throwing OverwriteModelError on re-registration. */
export const FixedAssetModel =
  (mongoose.models["FixedAsset"] as Model<FixedAssetDocument> | undefined) ??
  mongoose.model<FixedAssetDocument>("FixedAsset", fixedAssetSchema);

export const DepreciationRunModel =
  (mongoose.models["DepreciationRun"] as Model<DepreciationRunDocument> | undefined) ??
  mongoose.model<DepreciationRunDocument>("DepreciationRun", depreciationRunSchema);
