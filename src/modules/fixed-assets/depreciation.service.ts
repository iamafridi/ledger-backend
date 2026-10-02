/**
 * Depreciation runs (plan §6, Phase 9).
 *
 * THE ONE RULE THAT MAKES THE EXIT GATE STRUCTURAL
 * A run writes the movement and the posting from one number: the charge it
 * computes is the amount it debits to depreciation expense *and* the amount it
 * credits to accumulated depreciation, on every asset, every month. So
 * "cost − accumulated depreciation = net book value = the ledger's position" is
 * not a coincidence to be hoped for — it is a consequence of writing both sides
 * from the same figure, which is why `I5-FIXED-ASSETS` can assert it to the paisa.
 *
 * IDEMPOTENT PER ASSET PER PERIOD
 * The guarantee lives in a partial unique index on `(org, asset, period)` for
 * rows whose status is POSTED, not in this file's memory. Three things follow,
 * and all three are wanted:
 *
 *   - **Re-running a month charges only what is missing.** A batch covers the
 *     assets it covers; running the same month again after registering an asset
 *     bought that month charges *that asset* and skips the rest, instead of
 *     double-charging everything or refusing to help.
 *   - **Reversing and re-running is the normal repair.** A reversed row no longer
 *     occupies the index, so a corrected run for the same month can be posted —
 *     and the reversal is a voided journal entry, so the history shows both.
 *   - **A preview cannot promise something the post refuses.** Preview and post
 *     run the same eligibility test off the same rows, so a line shown as
 *     eligible is a line that will post.
 *
 * WHAT A RUN IS, IN THE LEDGER
 * One journal entry per batch: `DR depreciation expense / CR accumulated
 * depreciation`, grouped by account pair so two classes of asset reported
 * separately stay separate. The rows the run created all point at it, which is
 * what makes a reversal a single void rather than a row-by-row unpicking.
 *
 * CLOSED PERIODS ARE BLOCKED TWICE
 * `postJournal` refuses to write into a closed period — that is the ledger's own
 * rule and it holds for every module. This service also refuses *before* it
 * computes anything, so the screen can say "November 2026 is closed" instead of
 * showing a schedule and then failing; and a period that does not exist says so,
 * because a run dated in a month with no fiscal year would otherwise post against
 * nothing.
 */
import { z } from "zod";
import mongoose, { type ClientSession } from "mongoose";

import { DepreciationRunModel, FixedAssetModel, type DepreciationRunStatus } from "./assets.model.js";
import { requireAsset, termsOf, toAssetView, type AssetTermsRow, type AssetView } from "./assets.service.js";
import { PeriodModel } from "../periods/period.model.js";
import {
  chargeForPeriod,
  isPeriodKey,
  monthlyCharge,
  nextPeriod,
  postingDateForPeriod,
  projectSchedule,
  type ScheduleRow,
} from "../../core/depreciation.js";
import { formatMonthLong, monthOf } from "../../core/calendar.js";
import { inTransaction, postJournal, voidEntry, type JournalLineInput } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, ZERO, type Money } from "../../core/money.js";
import { MonthInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

const PeriodField = MonthInput.refine(
  (value) => isPeriodKey(value),
  "A period looks like 2026-09.",
);

export const DepreciationPlanSchema = z.object({
  period: PeriodField,
  /** Blank means every asset that is due. Naming assets is how a screen runs a
   *  subset; it is not a way to run an asset twice, which the index prevents. */
  asset_ids: z.array(ObjectIdInput).max(1000).optional(),
});

/** The preview asks about one month and nothing else — it reports the whole
 *  register, because "what is due" is a question about the books, not about a
 *  selection somebody made on a screen. A run may name a subset. */
export const DepreciationPreviewQuery = z.object({ period: PeriodField });

export const ReverseRunSchema = z.object({
  reason: z.string().trim().min(3, "Say why this run is being reversed.").max(300),
});

export const ListRunsQuery = z.object({
  period_key: PeriodField.optional(),
  asset_id: ObjectIdInput.optional(),
  status: z.enum(["POSTED", "REVERSED"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const ListBatchesQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(24),
});

export type DepreciationPlanInput = z.output<typeof DepreciationPlanSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export type SkipReason = "DISPOSED" | "NOT_YET_IN_SERVICE" | "ALREADY_RUN" | "FULLY_DEPRECIATED";

export const SKIP_REASON_LABEL: Record<SkipReason, string> = {
  DISPOSED: "already left the books",
  NOT_YET_IN_SERVICE: "bought after this month",
  ALREADY_RUN: "already charged for this month",
  FULLY_DEPRECIATED: "fully written down",
};

export interface DepreciationLineView {
  asset_id: string;
  code: string;
  name: string;
  category: string;
  cost_bdt: string;
  salvage_bdt: string;
  monthly_charge_bdt: string;
  accum_before_bdt: string;
  amount_bdt: string;
  accum_after_bdt: string;
  nbv_after_bdt: string;
  days_charged: number;
  days_in_month: number;
  prorated: boolean;
  final: boolean;
  expense_account_code: string;
  accum_account_code: string;
}

export interface SkippedAssetView {
  asset_id: string;
  code: string;
  name: string;
  reason: SkipReason;
  reason_label: string;
}

export type PeriodStatus = "OPEN" | "CLOSED" | "MISSING";

export interface DepreciationPreview {
  period_key: string;
  /** The day the charges will be dated: the last day of the period. */
  date: string;
  period_label: string;
  period_status: PeriodStatus;
  /** True when a run would post: the period is open and something is due. */
  postable: boolean;
  /** Why not, in words, when `postable` is false. */
  blocked_reason: string;
  lines: DepreciationLineView[];
  skipped: SkippedAssetView[];
  total_bdt: string;
  eligible_count: number;
  already_run_count: number;
}

export interface DepreciationRunView {
  id: string;
  batch_id: string;
  period_key: string;
  date: string;
  asset_id: string;
  code: string;
  name: string;
  amount_bdt: string;
  cost_bdt: string;
  accum_before_bdt: string;
  accum_after_bdt: string;
  nbv_after_bdt: string;
  expense_account_code: string;
  accum_account_code: string;
  days_charged: number;
  days_in_month: number;
  prorated: boolean;
  final: boolean;
  status: DepreciationRunStatus;
  journal_entry_id: string;
  reversed_by_entry_id: string | null;
  reason: string;
  created_by: string;
  created_at: string;
}

/** One run as a reader thinks of it: a batch of assets charged in one month,
 *  carried by one journal entry. */
export interface DepreciationBatchView {
  batch_id: string;
  period_key: string;
  date: string;
  journal_entry_id: string;
  asset_count: number;
  total_bdt: string;
  status: DepreciationRunStatus | "MIXED";
  reason: string;
  created_by: string;
  created_at: string;
}

export interface AssetSchedule {
  asset: AssetView;
  /** What has actually been charged, oldest first. */
  history: DepreciationRunView[];
  /** The rest of the asset's life, from `core/depreciation.ts` — the same
   *  function the run posts from. Empty once the asset has left the books. */
  projected: ScheduleRow[];
  /** True when `projected` hit the row cap and is therefore not the whole story. */
  projected_truncated: boolean;
}

/* ── Eligibility ─────────────────────────────────────────────────────────── */

interface PlanContext {
  session: ClientSession | null;
  period: string;
  assets: AssetTermsRow[];
  /** Asset ids with a POSTED run in `period`. */
  alreadyRun: Set<string>;
}

async function loadPlanContext(
  orgId: string,
  input: DepreciationPlanInput,
  session: ClientSession | null,
): Promise<PlanContext> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (input.asset_ids && input.asset_ids.length > 0) filter["_id"] = { $in: input.asset_ids };

  const assets = (await FixedAssetModel.find(filter)
    .sort({ code: 1 })
    .session(session)
    .lean()) as unknown as AssetTermsRow[];

  const runs = await DepreciationRunModel.find({
    org_id: orgId,
    period_key: input.period,
    status: "POSTED",
    ...(input.asset_ids && input.asset_ids.length > 0 ? { asset_id: { $in: input.asset_ids } } : {}),
  })
    .select({ asset_id: 1 })
    .session(session)
    .lean();

  return {
    session,
    period: input.period,
    assets,
    alreadyRun: new Set(runs.map((row) => String(row.asset_id))),
  };
}

/** One asset's charge for one period, as planned. Exported because the stub a
 *  disposal charges is built as the same row — there is one shape for a
 *  depreciation charge, whichever path produced it. */
export interface PlanRow {
  asset: AssetTermsRow;
  /** The month being charged, and the day it is dated — the last day of it. */
  period_key: string;
  date: string;
  amount: Money;
  accumBefore: Money;
  daysCharged: number;
  daysInMonth: number;
  prorated: boolean;
  final: boolean;
}

/**
 * Decide what this period charges, and say why for everything it does not.
 *
 * The skip reasons are checked in a fixed order — disposed, not yet in service,
 * already run, fully written down — and the first true one wins. The order is
 * stated rather than incidental because a screen counts these, and a count that
 * shuffled between two true reasons would be a number nobody could rely on.
 */
function planPeriod(context: PlanContext): { eligible: PlanRow[]; skipped: SkippedAssetView[] } {
  const eligible: PlanRow[] = [];
  const skipped: SkippedAssetView[] = [];

  const skip = (asset: AssetTermsRow, reason: SkipReason): void => {
    skipped.push({
      asset_id: String(asset._id),
      code: asset.code,
      name: asset.name,
      reason,
      reason_label: SKIP_REASON_LABEL[reason],
    });
  };

  for (const asset of context.assets) {
    const id = String(asset._id);

    if (asset.status !== "ACTIVE") {
      skip(asset, "DISPOSED");
      continue;
    }
    if (monthOf(asset.purchase_date) > context.period) {
      skip(asset, "NOT_YET_IN_SERVICE");
      continue;
    }
    if (context.alreadyRun.has(id)) {
      skip(asset, "ALREADY_RUN");
      continue;
    }

    const terms = termsOf(asset);
    const accumBefore = money(asset.accumulated_depreciation_bdt ?? "0.00");
    const charge = chargeForPeriod(terms, accumBefore, context.period, asset.purchase_date);

    if (!charge.amount.greaterThan(ZERO)) {
      skip(asset, "FULLY_DEPRECIATED");
      continue;
    }

    eligible.push({
      asset,
      period_key: context.period,
      date: postingDateForPeriod(context.period),
      amount: charge.amount,
      accumBefore,
      daysCharged: charge.daysCharged,
      daysInMonth: charge.daysInMonth,
      prorated: charge.prorated,
      final: charge.final,
    });
  }

  return { eligible, skipped };
}

async function periodStatus(orgId: string, period: string): Promise<PeriodStatus> {
  const row = await PeriodModel.findOne({ org_id: orgId, key: period }).select({ status: 1 }).lean();
  if (!row) return "MISSING";
  return row.status === "CLOSED" ? "CLOSED" : "OPEN";
}

function blockedReasonFor(status: PeriodStatus, period: string): string {
  if (status === "MISSING") {
    return `There is no accounting period for ${period}. Open a fiscal year covering that month first.`;
  }
  if (status === "CLOSED") {
    return `${formatMonthLong(period)} is closed, so nothing dated in it can be posted. Reopen the period if the correction is genuine.`;
  }
  return "";
}

function toLineView(row: PlanRow): DepreciationLineView {
  const asset = row.asset;
  const accumAfter = row.accumBefore.plus(row.amount);
  return {
    asset_id: String(asset._id),
    code: asset.code,
    name: asset.name,
    category: asset.category ?? "",
    cost_bdt: asset.cost_bdt,
    salvage_bdt: asset.salvage_bdt ?? "0.00",
    monthly_charge_bdt: fmt(monthlyCharge(termsOf(asset))),
    accum_before_bdt: fmt(row.accumBefore),
    amount_bdt: fmt(row.amount),
    accum_after_bdt: fmt(accumAfter),
    nbv_after_bdt: fmt(money(asset.cost_bdt).minus(accumAfter)),
    days_charged: row.daysCharged,
    days_in_month: row.daysInMonth,
    prorated: row.prorated,
    final: row.final,
    expense_account_code: asset.dep_expense_account_code,
    accum_account_code: asset.accum_account_code,
  };
}

/* ── Preview ─────────────────────────────────────────────────────────────── */

/**
 * What a run for this period would charge, without writing anything.
 *
 * Deliberately the same code path as the post: it plans, then reports the plan.
 * A preview built from a second implementation would be a screen that lies the
 * first time anybody changes the schedule.
 */
export async function previewDepreciation(
  orgId: string,
  input: DepreciationPlanInput,
): Promise<DepreciationPreview> {
  const context = await loadPlanContext(orgId, input, null);
  const { eligible, skipped } = planPeriod(context);
  const status = await periodStatus(orgId, input.period);

  const total = eligible.reduce((acc, row) => acc.plus(row.amount), ZERO);
  const alreadyRun = skipped.filter((row) => row.reason === "ALREADY_RUN").length;

  const blocked = blockedReasonFor(status, input.period);
  const postable = status === "OPEN" && eligible.length > 0;

  return {
    period_key: input.period,
    date: postingDateForPeriod(input.period),
    period_label: formatMonthLong(input.period),
    period_status: status,
    postable,
    blocked_reason: blocked
      ? blocked
      : eligible.length === 0
        ? "Nothing is due for this month — every asset is either already charged for it or fully written down."
        : "",
    lines: eligible.map((row) => toLineView(row)),
    skipped,
    total_bdt: fmt(total),
    eligible_count: eligible.length,
    already_run_count: alreadyRun,
  };
}

/* ── The run ─────────────────────────────────────────────────────────────── */

export interface RunBatchResult {
  batch_id: string;
  journal_entry_id: string;
  period_key: string;
  date: string;
  total_bdt: string;
  asset_count: number;
  entry_no: string | null;
}

/**
 * Write a batch of charges and the one journal entry that carries them.
 *
 * Shared by the monthly run and the stub a disposal charges for its own month, so
 * there is exactly one place that writes a depreciation row and updates the cached
 * accumulated figure — and therefore exactly one place a future change has to get
 * right.
 *
 * The entry groups by the account pair an asset posts to, so two classes of asset
 * with their own expense and accumulated accounts produce two pairs of lines
 * rather than one blended figure. Either way the entry balances: the debits are
 * the same amounts as the credits.
 */
export async function recordDepreciationBatch(
  orgId: string,
  uid: string,
  rows: readonly PlanRow[],
  description: string,
  session: ClientSession,
): Promise<RunBatchResult> {
  const batchId = new mongoose.Types.ObjectId().toString();

  const byPair = new Map<string, { expense: string; accum: string; amount: Money }>();
  for (const row of rows) {
    const expense = row.asset.dep_expense_account_code;
    const accum = row.asset.accum_account_code;
    const key = `${expense}|${accum}`;
    const bucket = byPair.get(key) ?? { expense, accum, amount: ZERO };
    bucket.amount = bucket.amount.plus(row.amount);
    byPair.set(key, bucket);
  }

  const lines: JournalLineInput[] = [];
  for (const bucket of byPair.values()) {
    lines.push({
      account_code: bucket.expense,
      debit_bdt: fmt(bucket.amount),
      credit_bdt: "0.00",
      memo: description,
    });
    lines.push({
      account_code: bucket.accum,
      debit_bdt: "0.00",
      credit_bdt: fmt(bucket.amount),
      memo: description,
    });
  }

  const entry = await postJournal(
    { orgId, uid, date: rows[0]!.date, description, source: "DEPRECIATION", source_id: batchId, lines },
    session,
  );

  const total = rows.reduce((acc, row) => acc.plus(row.amount), ZERO);

  try {
    await DepreciationRunModel.insertMany(
      rows.map((row) => ({
        org_id: orgId,
        asset_id: row.asset._id,
        period_key: row.period_key,
        date: row.date,
        amount_bdt: fmt(row.amount),
        cost_bdt: row.asset.cost_bdt,
        salvage_bdt: row.asset.salvage_bdt ?? "0.00",
        accum_before_bdt: fmt(row.accumBefore),
        accum_after_bdt: fmt(row.accumBefore.plus(row.amount)),
        nbv_after_bdt: fmt(money(row.asset.cost_bdt).minus(row.accumBefore.plus(row.amount))),
        expense_account_code: row.asset.dep_expense_account_code,
        accum_account_code: row.asset.accum_account_code,
        run_batch_id: batchId,
        days_charged: row.daysCharged,
        days_in_month: row.daysInMonth,
        prorated: row.prorated,
        final: row.final,
        journal_entry_id: entry.id,
        status: "POSTED",
        reversed_by_entry_id: null,
        reason: "",
        created_by: uid,
      })),
      { session },
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    ) {
      throw new AppError(
        409,
        "PERIOD_ALREADY_RUN",
        "One of these assets was already charged for that month by another request. Nothing was posted.",
      );
    }
    throw error;
  }

  // The cached figure, written from the row that was just written and never
  // computed from the asset again. `runValidators` on purpose: this is the field
  // `I5-FIXED-ASSETS` ties to the ledger, so a bad string has to be refused at the
  // write rather than discovered by the integrity run (an update skips validators
  // by default — the lesson P8 recorded).
  await Promise.all(
    rows.map((row) =>
      FixedAssetModel.updateOne(
        { _id: row.asset._id, org_id: orgId },
        {
          $set: {
            accumulated_depreciation_bdt: fmt(row.accumBefore.plus(row.amount)),
            last_depreciated_period:
              String(row.asset.last_depreciated_period ?? "") > row.period_key
                ? String(row.asset.last_depreciated_period ?? "")
                : row.period_key,
            updated_by: uid,
          },
        },
        { session, runValidators: true },
      ),
    ),
  );

  return {
    batch_id: batchId,
    journal_entry_id: entry.id,
    period_key: rows[0]!.period_key,
    date: rows[0]!.date,
    total_bdt: fmt(total),
    asset_count: rows.length,
    entry_no: entry.entry_no,
  };
}

/**
 * Post the month's depreciation.
 *
 * The plan is drawn up first and refused as a whole when there is nothing to
 * charge: a run that posted an empty entry would be a journal entry with no
 * amount, which the posting engine refuses for good reason, and a run that posted
 * a partial one would leave a month half written off with nothing saying so.
 */
export async function runDepreciation(
  orgId: string,
  uid: string,
  input: DepreciationPlanInput,
  ip?: string,
): Promise<RunBatchResult & { skipped: SkippedAssetView[] }> {
  const status = await periodStatus(orgId, input.period);
  if (status !== "OPEN") {
    const message = blockedReasonFor(status, input.period);
    throw new AppError(
      422,
      status === "MISSING" ? "PERIOD_MISSING" : "PERIOD_CLOSED",
      message,
    );
  }

  return inTransaction(async (session) => {
    // Planned inside the transaction, so the rows written are the rows judged: a
    // concurrent run is caught by the unique index rather than by a stale plan.
    const context = await loadPlanContext(orgId, input, session);
    const { eligible, skipped } = planPeriod(context);

    if (eligible.length === 0) {
      throw new AppError(
        409,
        "NOTHING_TO_DEPRECIATE",
        `Nothing is due for ${formatMonthLong(input.period)} — every asset is either already charged for it or fully written down.`,
      );
    }

    const result = await recordDepreciationBatch(
      orgId,
      uid,
      eligible,
      `Depreciation — ${formatMonthLong(input.period)}`,
      session,
    );

    await writeAudit({
      orgId,
      uid,
      entity: "assets.depreciation",
      entityId: result.batch_id,
      action: "DEPRECIATION_POSTED",
      after: {
        period_key: input.period,
        date: result.date,
        asset_count: result.asset_count,
        total_bdt: result.total_bdt,
        journal_entry_id: result.journal_entry_id,
      },
      ...(ip ? { ip } : {}),
    });

    return { ...result, skipped };
  });
}

/* ── Reversal ────────────────────────────────────────────────────────────── */

export interface ReversalResult {
  batch_id: string;
  reversal_entry_id: string;
  reversal_entry_no: string | null;
  period_key: string;
  asset_count: number;
  total_bdt: string;
}

/**
 * Reverse a whole run.
 *
 * Whole, not per asset: the batch is one journal entry, and an entry is voided by
 * writing its mirror. Splitting a reversal across the assets inside a batch would
 * mean writing a second entry that posts the opposite of part of the first, which
 * is a correction dressed up as a reversal and much harder to read a year later.
 *
 * The cached accumulated figure is **recomputed from the rows that remain POSTED**
 * rather than decremented by the amount reversed. A subtraction would have to be
 * right every time; a recomputation is right by construction, and it repairs any
 * drift the reversal is being made to fix.
 *
 * A run belonging to an asset that has since been disposed of is refused: the
 * disposal entry already cleared that asset's accumulated depreciation out of the
 * ledger, so reversing the run underneath it would leave 1510 holding a figure the
 * register cannot explain. Correcting a disposed asset is a journal entry, and the
 * refusal says so.
 */
export async function reverseRun(
  orgId: string,
  uid: string,
  batchId: string,
  reason: string,
  ip?: string,
): Promise<ReversalResult> {
  if (!/^[0-9a-fA-F]{24}$/.test(batchId)) {
    throw notFoundError("That run does not exist.");
  }

  return inTransaction(async (session) => {
    const rows = await DepreciationRunModel.find({
      org_id: orgId,
      run_batch_id: batchId,
      status: "POSTED",
    })
      .session(session)
      .lean();
    if (rows.length === 0) {
      throw new AppError(409, "RUN_NOT_POSTED", "That run is not posted, so there is nothing to reverse.");
    }

    const assetIds = [...new Set(rows.map((row) => String(row.asset_id)))];
    const assets = await FixedAssetModel.find({ org_id: orgId, _id: { $in: assetIds } })
      .session(session)
      .lean();

    const disposed = assets.filter((asset) => asset.status !== "ACTIVE");
    if (disposed.length > 0) {
      throw new AppError(
        409,
        "ASSET_DISPOSED",
        `${disposed.map((asset) => asset.code).join(", ")} has already left the books, and the disposal cleared its written-down value. ` +
          "Correct it with a journal entry rather than by reversing the depreciation under it.",
      );
    }

    const total = rows.reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00")), ZERO);
    const periodKey = rows[0]!.period_key;

    const { reversal } = await voidEntry(
      orgId,
      uid,
      String(rows[0]!.journal_entry_id),
      reason,
      ip,
      session,
    );

    await DepreciationRunModel.updateMany(
      { org_id: orgId, run_batch_id: batchId, status: "POSTED" },
      { $set: { status: "REVERSED", reversed_by_entry_id: reversal.id, reason: reason.trim() } },
      { session },
    );

    for (const assetId of assetIds) {
      const posted = await DepreciationRunModel.find({ org_id: orgId, asset_id: assetId, status: "POSTED" })
        .sort({ period_key: -1 })
        .select({ period_key: 1, amount_bdt: 1 })
        .session(session)
        .lean();

      const accumulated = posted.reduce((acc, row) => acc.plus(money(row.amount_bdt ?? "0.00")), ZERO);
      await FixedAssetModel.updateOne(
        { _id: assetId, org_id: orgId },
        {
          $set: {
            accumulated_depreciation_bdt: fmt(accumulated),
            last_depreciated_period: posted[0]?.period_key ?? "",
            updated_by: uid,
          },
        },
        { session, runValidators: true },
      );
    }

    await writeAudit({
      orgId,
      uid,
      entity: "assets.depreciation",
      entityId: batchId,
      action: "DEPRECIATION_REVERSED",
      before: { status: "POSTED", period_key: periodKey, asset_count: rows.length, total_bdt: fmt(total) },
      after: { status: "REVERSED", reversal_entry_id: reversal.id, reason: reason.trim() },
      ...(ip ? { ip } : {}),
    });

    return {
      batch_id: batchId,
      reversal_entry_id: reversal.id,
      reversal_entry_no: reversal.entry_no,
      period_key: periodKey,
      asset_count: rows.length,
      total_bdt: fmt(total),
    };
  });
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toRunView(row: any, label: { code: string; name: string }): DepreciationRunView {
  return {
    id: String(row._id),
    batch_id: row.run_batch_id,
    period_key: row.period_key,
    date: row.date,
    asset_id: String(row.asset_id),
    code: label.code,
    name: label.name,
    amount_bdt: row.amount_bdt,
    cost_bdt: row.cost_bdt ?? "0.00",
    accum_before_bdt: row.accum_before_bdt ?? "0.00",
    accum_after_bdt: row.accum_after_bdt ?? "0.00",
    nbv_after_bdt: row.nbv_after_bdt ?? "0.00",
    expense_account_code: row.expense_account_code,
    accum_account_code: row.accum_account_code,
    days_charged: Number(row.days_charged ?? 0),
    days_in_month: Number(row.days_in_month ?? 0),
    prorated: row.prorated === true,
    final: row.final === true,
    status: row.status,
    journal_entry_id: String(row.journal_entry_id),
    reversed_by_entry_id: row.reversed_by_entry_id ? String(row.reversed_by_entry_id) : null,
    reason: row.reason ?? "",
    created_by: row.created_by ?? "",
    created_at: row.createdAt ? new Date(row.createdAt).toISOString() : "",
  };
}

async function assetLabels(orgId: string, ids: readonly string[]): Promise<Map<string, { code: string; name: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await FixedAssetModel.find({ org_id: orgId, _id: { $in: unique } })
    .select({ code: 1, name: 1 })
    .lean();
  return new Map(rows.map((row) => [String(row._id), { code: row.code, name: row.name }]));
}

/** Every charge, newest first — the register's history. */
export async function listRuns(
  orgId: string,
  query: { period_key?: string; asset_id?: string; status?: DepreciationRunStatus; limit: number },
): Promise<DepreciationRunView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.period_key) filter["period_key"] = query.period_key;
  if (query.asset_id) filter["asset_id"] = query.asset_id;
  if (query.status) filter["status"] = query.status;

  const rows = await DepreciationRunModel.find(filter)
    .sort({ period_key: -1, asset_id: 1 })
    .limit(query.limit)
    .lean();
  if (rows.length === 0) return [];

  const labels = await assetLabels(
    orgId,
    rows.map((row) => String(row.asset_id)),
  );
  return rows.map((row) =>
    toRunView(row, labels.get(String(row.asset_id)) ?? { code: "", name: "" }),
  );
}

/**
 * Runs as a reader thinks of them: one batch, one month, one journal entry.
 *
 * Grouped in the database rather than in memory because a run a month for several
 * years is thousands of rows, and the screen only ever shows the recent ones.
 */
export async function listBatches(orgId: string, limit: number): Promise<DepreciationBatchView[]> {
  const raw = await DepreciationRunModel.aggregate<{
    _id: string;
    period_key: string;
    date: string;
    journal_entry_id: mongoose.Types.ObjectId;
    asset_count: number;
    total: unknown;
    posted: number;
    reason: string;
    created_by: string;
    created_at: Date;
  }>([
    { $match: { org_id: new mongoose.Types.ObjectId(orgId) } },
    {
      $group: {
        _id: "$run_batch_id",
        period_key: { $first: "$period_key" },
        date: { $first: "$date" },
        journal_entry_id: { $first: "$journal_entry_id" },
        asset_count: { $sum: 1 },
        total: { $sum: { $toDecimal: "$amount_bdt" } },
        posted: { $sum: { $cond: [{ $eq: ["$status", "POSTED"] }, 1, 0] } },
        reason: { $first: "$reason" },
        created_by: { $first: "$created_by" },
        created_at: { $max: "$createdAt" },
      },
    },
    { $sort: { created_at: -1 } },
    { $limit: limit },
    { $addFields: { total: { $toString: "$total" } } },
  ]);

  return raw.map((row) => ({
    batch_id: row._id,
    period_key: row.period_key,
    date: row.date,
    journal_entry_id: String(row.journal_entry_id),
    asset_count: row.asset_count,
    total_bdt: String(row.total),
    status: row.posted === row.asset_count ? "POSTED" : row.posted === 0 ? "REVERSED" : "MIXED",
    reason: row.reason ?? "",
    created_by: row.created_by ?? "",
    created_at: row.created_at ? new Date(row.created_at).toISOString() : "",
  }));
}

/** One batch's rows, for the disclosure behind a history line. */
export async function getBatch(orgId: string, batchId: string): Promise<DepreciationRunView[]> {
  if (!/^[0-9a-fA-F]{24}$/.test(batchId)) throw notFoundError("That run does not exist.");

  const rows = await DepreciationRunModel.find({ org_id: orgId, run_batch_id: batchId }).lean();
  if (rows.length === 0) throw notFoundError("That run does not exist.");

  const labels = await assetLabels(
    orgId,
    rows.map((row) => String(row.asset_id)),
  );
  // Sorted by asset tag rather than by amount: the columns are money held as
  // strings, and a string sort of "1000.00" against "900.00" is alphabet, not
  // arithmetic. The order a reader wants is the register's own.
  return rows
    .map((row) => toRunView(row, labels.get(String(row.asset_id)) ?? { code: "", name: "" }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

/**
 * One asset's schedule: what has been charged, and what is left.
 *
 * The projected half is drawn from `core/depreciation.ts` — the same functions the
 * run posts from — starting at the first month not yet written off. It is
 * therefore a *forecast of the next charges* rather than a rewrite of history: a
 * month that was skipped is not back-filled into the projection, because the run
 * that charges it will price it against the average of what was actually written
 * off, and a projection that guessed would disagree with the run that follows it.
 */
export async function assetSchedule(orgId: string, id: string): Promise<AssetSchedule> {
  const asset = await requireAsset(orgId, id);
  const assetId = String(asset._id);

  const history = await listRuns(orgId, { asset_id: assetId, limit: 500 });
  const accumulated = money(asset.accumulated_depreciation_bdt ?? "0.00");
  const lastPeriod = String(asset.last_depreciated_period ?? "");
  const fromPeriod = lastPeriod ? nextPeriod(lastPeriod) : monthOf(asset.purchase_date);

  const projected =
    asset.status === "ACTIVE"
      ? projectSchedule(termsOf(asset), accumulated, asset.purchase_date, fromPeriod)
      : [];

  return {
    asset: toAssetView(asset),
    history,
    projected,
    projected_truncated: projected.length >= 600,
  };
}
