/**
 * The fixed-asset register (plan §6, Phase 9).
 *
 * WHAT A REGISTER IS FOR
 * The fixed-asset control account is one figure. This module is the list behind
 * it: one row per thing the organisation owns, what it cost, how it is being
 * written down, and — when it goes — what it fetched against what the book said
 * it was worth. Every amount the register reports is derived here through
 * `core/depreciation.ts`, the same functions the run posts from, so a screen
 * cannot show one schedule while the ledger records another.
 *
 * TWO WAYS AN ASSET GETS ITS COST ONTO 1500
 *
 *  1. **The register posts it.** `acquisition` on the create body names where the
 *     money came from — cash, bank, the supplier — and the service writes
 *     `DR 1500 cost / CR that account` in the same transaction as the row.
 *
 *  2. **A bill already posted it.** A purchase line naming 1500 by hand
 *     capitalises (see `core/document-lines.ts`), and the asset is then registered
 *     *without* an acquisition posting, because posting it twice would double the
 *     asset. This is the path a real purchase takes: the bill is the document, and
 *     the register records what the bill bought.
 *
 * Nothing here polices which of the two happened — the register states the cost,
 * the ledger states the balance, and `I5-FIXED-ASSETS` names any difference. That
 * is deliberate: a check that can only be satisfied by one code path is a check
 * that stops being true the first time a second path is added.
 *
 * WHY COST IS NORMALLY IMMUTABLE
 * On an asset the register posted, the cost *is* the acquisition entry. Editing it
 * would leave 1500 holding a figure no report can explain, so it is refused with
 * the fix named (correct it in the journal, or dispose and re-register). On an
 * asset registered against somebody else's posting nothing was written from this
 * row, so the cost is a fact being recorded rather than an amount being moved, and
 * correcting a typo there is allowed.
 */
import { z } from "zod";
import type { ClientSession } from "mongoose";

import { DepreciationRunModel, FixedAssetModel, type AssetStatus } from "./assets.model.js";
import { recordDepreciationBatch } from "./depreciation.service.js";
import { JournalEntryModel } from "../journals/journal.model.js";
import { CONTROL_ACCOUNT } from "../coa/coa-seed.js";
import { requireAccountByCode } from "../coa/coa.service.js";
import {
  chargeForPeriod,
  depreciableBase,
  disposalThroughDay,
  monthlyCharge,
  postingDateForPeriod,
} from "../../core/depreciation.js";
import { monthOf } from "../../core/calendar.js";
import { inTransaction, postJournal, voidEntry, type JournalLineInput } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money, ZERO, type Money } from "../../core/money.js";
import { DateInput, MoneyInput } from "../../shared/validation/schemas.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

/**
 * The accounts an asset posts to.
 *
 * Every one is validated for existence, activity *and type* before the asset
 * exists: a depreciation expense pointing at an asset account would balance the
 * trial balance every month while putting the write-down in the wrong place, and
 * a typo here is invisible until somebody reads the balance sheet a year later.
 */
const AccountsSchema = z.object({
  asset_account_code: z.string().trim().max(24).default(CONTROL_ACCOUNT.FIXED_ASSET),
  accum_account_code: z.string().trim().max(24).default(CONTROL_ACCOUNT.ACCUM_DEPRECIATION),
  dep_expense_account_code: z.string().trim().max(24).default(CONTROL_ACCOUNT.DEPRECIATION_EXPENSE),
  gain_account_code: z.string().trim().max(24).default(CONTROL_ACCOUNT.OTHER_INCOME),
  loss_account_code: z.string().trim().max(24).default(CONTROL_ACCOUNT.MISC_EXPENSE),
});

const AcquisitionSchema = z.object({
  /** Where the cost came from: 1000 cash, 1010 bank, 2000 the supplier. */
  credit_account_code: z.string().trim().min(1, "Say which account the money came from.").max(24),
  /** Defaults to the purchase date. */
  date: DateInput.optional(),
  memo: z.string().trim().max(300).default(""),
});

export const CreateAssetSchema = AccountsSchema.extend({
  code: z
    .string()
    .trim()
    .min(1, "An asset needs a tag.")
    .max(24)
    .regex(/^[A-Za-z0-9-]+$/, "A tag is letters, digits and dashes."),
  name: z.string().trim().min(2, "Give the asset a name.").max(120),
  category: z.string().trim().max(60).default(""),
  /** Both the day it was bought and the day it entered service. One date, and
   *  the service says so out loud rather than inventing a second field that the
   *  schedule would silently ignore. */
  purchase_date: DateInput,
  cost_bdt: MoneyInput,
  salvage_bdt: MoneyInput.default("0.00"),
  useful_life_months: z.coerce
    .number()
    .int("Useful life is a whole number of months.")
    .min(1, "Useful life is at least one month.")
    .max(1200, "A useful life beyond a hundred years is not a useful life."),
  acquisition: AcquisitionSchema.optional(),
  /** What the cost came in from, for a reader — a bill number, a voucher. */
  source_doc_no: z.string().trim().max(60).default(""),
  notes: z.string().trim().max(500).default(""),
});

/**
 * PATCH semantics. The tag and the cost are the identity of the row — the tag for
 * operations, the cost for the ledger — and are handled with explicit rules in the
 * service rather than accepted here as ordinary fields.
 */
export const UpdateAssetSchema = AccountsSchema.partial()
  .extend({
    name: z.string().trim().min(2).max(120),
    category: z.string().trim().max(60),
    salvage_bdt: MoneyInput,
    useful_life_months: z.coerce.number().int().min(1).max(1200),
    notes: z.string().trim().max(500),
  })
  .partial();

export const ListAssetsQuery = z.object({
  status: z.enum(["ACTIVE", "DISPOSED"]).optional(),
  category: z.string().trim().max(60).optional(),
  /** Matches the tag or the name. Small ledgers have few enough assets that a
   *  substring scan is the right answer rather than an index. */
  q: z.string().trim().max(60).optional(),
});

export const DisposeAssetSchema = z.object({
  date: DateInput,
  /** Zero is a scrap, which is a disposal like any other. */
  proceeds_bdt: MoneyInput.default("0.00"),
  /** Where the proceeds landed. Defaulted to cash: a disposal that names nothing
   *  is nearly always something sold for cash over the counter. */
  proceeds_account_code: z.string().trim().max(24).default(CONTROL_ACCOUNT.CASH),
  reason: z.string().trim().min(3, "Say why this asset is leaving the books.").max(300),
});

export const VoidDisposalSchema = z.object({
  reason: z.string().trim().min(3, "Say why the disposal is being undone.").max(300),
});

export type CreateAssetInput = z.output<typeof CreateAssetSchema>;
export type UpdateAssetInput = z.output<typeof UpdateAssetSchema>;
export type ListAssetsInput = z.output<typeof ListAssetsQuery>;
export type DisposeAssetInput = z.output<typeof DisposeAssetSchema>;

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface DisposalView {
  date: string;
  proceeds_bdt: string;
  proceeds_account_code: string;
  reason: string;
  cost_bdt: string;
  accumulated_bdt: string;
  nbv_bdt: string;
  gain_bdt: string;
  loss_bdt: string;
  gain_account_code: string;
  loss_account_code: string;
  journal_entry_id: string | null;
  voided_by_entry_id: string | null;
  void_reason: string;
  disposed_by: string;
}

export interface AssetView {
  id: string;
  code: string;
  name: string;
  category: string;
  purchase_date: string;

  cost_bdt: string;
  salvage_bdt: string;
  useful_life_months: number;
  /** "5 years", "18 months" — a label, never a figure anything computes from. */
  useful_life_label: string;
  method: string;

  asset_account_code: string;
  accum_account_code: string;
  dep_expense_account_code: string;
  gain_account_code: string;
  loss_account_code: string;

  journal_entry_id: string | null;
  acquired_via: "POSTED" | "REGISTERED";
  source_doc_no: string;

  /** Everything below is derived here, from the same functions the run posts
   *  from. A client never computes a book value. */
  depreciable_base_bdt: string;
  accumulated_depreciation_bdt: string;
  net_book_value_bdt: string;
  /** One full month's charge, before any proration. */
  monthly_charge_bdt: string;
  remaining_bdt: string;
  fully_depreciated: boolean;

  last_depreciated_period: string;
  status: AssetStatus;
  disposal: DisposalView | null;
  notes: string;
  created_at: string;
}

export interface AssetSummary {
  asset_count: number;
  disposed_count: number;
  total_cost_bdt: string;
  total_accumulated_bdt: string;
  total_net_book_value_bdt: string;
  /** What one more month would charge across every live asset. */
  monthly_charge_bdt: string;
  fully_depreciated_count: number;
}

/** The fields the depreciation maths needs from a stored asset. Structural, so a
 *  lean document can be passed straight in — the same shape `core/depreciation.ts`
 *  asks for, plus the dates. */
export interface AssetTermsRow {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export function termsOf(asset: AssetTermsRow): {
  cost: Money;
  salvage: Money;
  usefulLifeMonths: number;
} {
  return {
    cost: money(asset.cost_bdt ?? "0.00"),
    salvage: money(asset.salvage_bdt ?? "0.00"),
    usefulLifeMonths: Number(asset.useful_life_months ?? 0),
  };
}

/** "5 years" or "18 months". Read by people, computed from the one figure the
 *  arithmetic uses — a label that disagreed with the schedule would be the sort
 *  of detail that gets trusted and is wrong. */
export function lifeLabel(months: number): string {
  if (months >= 12 && months % 12 === 0) {
    const years = months / 12;
    return `${years} ${years === 1 ? "year" : "years"}`;
  }
  return `${months} ${months === 1 ? "month" : "months"}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDisposalView(doc: any): DisposalView | null {
  if (!doc) return null;
  return {
    date: doc.date,
    proceeds_bdt: doc.proceeds_bdt ?? "0.00",
    proceeds_account_code: doc.proceeds_account_code ?? "",
    reason: doc.reason ?? "",
    cost_bdt: doc.cost_bdt ?? "0.00",
    accumulated_bdt: doc.accumulated_bdt ?? "0.00",
    nbv_bdt: doc.nbv_bdt ?? "0.00",
    gain_bdt: doc.gain_bdt ?? "0.00",
    loss_bdt: doc.loss_bdt ?? "0.00",
    gain_account_code: doc.gain_account_code ?? "",
    loss_account_code: doc.loss_account_code ?? "",
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    voided_by_entry_id: doc.voided_by_entry_id ? String(doc.voided_by_entry_id) : null,
    void_reason: doc.void_reason ?? "",
    disposed_by: doc.disposed_by ?? "",
  };
}

/** One stored asset as the API shows it. Exported because the depreciation
 *  service reports assets by the same shape rather than a second one. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toAssetView(doc: any): AssetView {
  const terms = termsOf(doc);
  const base = depreciableBase(terms);
  const accumulated = money(doc.accumulated_depreciation_bdt ?? "0.00");
  const remaining = base.minus(accumulated);

  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    category: doc.category ?? "",
    purchase_date: doc.purchase_date,

    cost_bdt: doc.cost_bdt,
    salvage_bdt: doc.salvage_bdt ?? "0.00",
    useful_life_months: Number(doc.useful_life_months ?? 0),
    useful_life_label: lifeLabel(Number(doc.useful_life_months ?? 0)),
    method: doc.method ?? "STRAIGHT_LINE",

    asset_account_code: doc.asset_account_code,
    accum_account_code: doc.accum_account_code,
    dep_expense_account_code: doc.dep_expense_account_code,
    gain_account_code: doc.gain_account_code,
    loss_account_code: doc.loss_account_code,

    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    acquired_via: doc.acquired_via === "POSTED" ? "POSTED" : "REGISTERED",
    source_doc_no: doc.source_doc_no ?? "",

    depreciable_base_bdt: fmt(base.greaterThan(ZERO) ? base : ZERO),
    accumulated_depreciation_bdt: fmt(accumulated),
    net_book_value_bdt: fmt(money(doc.cost_bdt).minus(accumulated)),
    monthly_charge_bdt: fmt(monthlyCharge(terms)),
    remaining_bdt: fmt(remaining.greaterThan(ZERO) ? remaining : ZERO),
    fully_depreciated: !remaining.greaterThan(ZERO),

    last_depreciated_period: doc.last_depreciated_period ?? "",
    status: doc.status,
    disposal: toDisposalView(doc.disposal),
    notes: doc.notes ?? "",
    created_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : "",
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

/* ── Shared reads ────────────────────────────────────────────────────────── */

/** One asset, scoped to the organisation. */
export async function requireAsset(
  orgId: string,
  id: string,
  session?: ClientSession | null,
): Promise<AssetTermsRow> {
  assertObjectId(id, "That asset does not exist.");
  const doc = await FixedAssetModel.findOne({ _id: id, org_id: orgId })
    .session(session ?? null)
    .lean();
  if (!doc) throw notFoundError("That asset does not exist.");
  return doc as AssetTermsRow;
}

/** An account that exists, is active, and is of the type this role requires. */
async function requireAccountOfType(
  orgId: string,
  code: string,
  type: "ASSET" | "EXPENSE" | "REVENUE",
  what: string,
): Promise<void> {
  const account = await requireAccountByCode(orgId, code);
  if (account.type !== type) {
    throw new AppError(
      422,
      "ACCOUNT_WRONG_TYPE",
      `${what} points at ${code} (${account.name}), which is a ${account.type.toLowerCase()} account. It has to be a ${type.toLowerCase()} account.`,
    );
  }
}

/** Everything a create or an update must have validated before it writes. */
async function checkAccounts(
  orgId: string,
  codes: {
    asset_account_code?: string;
    accum_account_code?: string;
    dep_expense_account_code?: string;
    gain_account_code?: string;
    loss_account_code?: string;
  },
): Promise<void> {
  if (codes.asset_account_code) {
    await requireAccountOfType(orgId, codes.asset_account_code, "ASSET", "The asset account");
  }
  if (codes.accum_account_code) {
    await requireAccountOfType(orgId, codes.accum_account_code, "ASSET", "The accumulated depreciation account");
  }
  if (codes.dep_expense_account_code) {
    await requireAccountOfType(orgId, codes.dep_expense_account_code, "EXPENSE", "The depreciation expense account");
  }
  if (codes.gain_account_code) {
    await requireAccountOfType(orgId, codes.gain_account_code, "REVENUE", "The gain account");
  }
  if (codes.loss_account_code) {
    await requireAccountOfType(orgId, codes.loss_account_code, "EXPENSE", "The loss account");
  }
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listAssets(
  orgId: string,
  query: ListAssetsInput,
): Promise<{ assets: AssetView[]; summary: AssetSummary }> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.status) filter["status"] = query.status;
  if (query.category) filter["category"] = query.category;
  if (query.q) {
    const escaped = query.q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter["$or"] = [
      { code: { $regex: escaped, $options: "i" } },
      { name: { $regex: escaped, $options: "i" } },
    ];
  }

  const rows = await FixedAssetModel.find(filter).sort({ code: 1 }).lean();

  // The summary is always the whole register, whatever the list is filtered to:
  // a header that changed when somebody typed in a search box would be reporting
  // on the search rather than on the books.
  const all = query.status || query.category || query.q
    ? await FixedAssetModel.find({ org_id: orgId }).lean()
    : rows;

  const assets = rows.map(toAssetView);
  const live = all.filter((row) => row.status === "ACTIVE");

  const totalCost = live.reduce((acc, row) => acc.plus(money(row.cost_bdt ?? "0.00")), ZERO);
  const totalAccumulated = live.reduce(
    (acc, row) => acc.plus(money(row.accumulated_depreciation_bdt ?? "0.00")),
    ZERO,
  );
  const totalMonthly = live.reduce((acc, row) => {
    const base = depreciableBase(termsOf(row));
    return acc.plus(base.greaterThan(ZERO) ? monthlyCharge(termsOf(row)) : ZERO);
  }, ZERO);

  return {
    assets,
    summary: {
      asset_count: live.length,
      disposed_count: all.length - live.length,
      total_cost_bdt: fmt(totalCost),
      total_accumulated_bdt: fmt(totalAccumulated),
      total_net_book_value_bdt: fmt(totalCost.minus(totalAccumulated)),
      monthly_charge_bdt: fmt(totalMonthly),
      fully_depreciated_count: live.filter((row) => {
        const base = depreciableBase(termsOf(row));
        return !base.minus(money(row.accumulated_depreciation_bdt ?? "0.00")).greaterThan(ZERO);
      }).length,
    },
  };
}

export async function getAsset(orgId: string, id: string): Promise<AssetView> {
  return toAssetView(await requireAsset(orgId, id));
}

/* ── Create ──────────────────────────────────────────────────────────────── */

/**
 * Register an asset, posting its acquisition when the caller says where the money
 * came from.
 *
 * The row and the entry are one transaction: an asset on the register whose cost
 * never reached 1500 would fail `I5-FIXED-ASSETS`, and a 1500 balance with no
 * asset behind it is the same defect from the other side.
 */
export async function createAsset(
  orgId: string,
  uid: string,
  input: CreateAssetInput,
  ip?: string,
): Promise<AssetView> {
  if (money(input.salvage_bdt).greaterThanOrEqualTo(money(input.cost_bdt))) {
    throw new AppError(
      422,
      "SALVAGE_NOT_BELOW_COST",
      "The salvage value has to be below what the asset cost — an asset that is never written down is not a depreciating asset.",
    );
  }

  return inTransaction(async (session) => {
    await checkAccounts(orgId, input);

    let acquisitionEntryId: string | null = null;
    if (input.acquisition) {
      const date = input.acquisition.date ?? input.purchase_date;
      const source = await requireAccountByCode(orgId, input.acquisition.credit_account_code);
      const description =
        `Asset ${input.code} — ${input.name}` +
        (input.acquisition.memo ? ` (${input.acquisition.memo})` : "");

      const entry = await postJournal(
        {
          orgId,
          uid,
          date,
          description,
          source: "ASSET_ACQUISITION",
          source_id: "",
          lines: [
            {
              account_code: input.asset_account_code,
              debit_bdt: input.cost_bdt,
              credit_bdt: "0.00",
              memo: description,
            },
            {
              account_code: source.code,
              debit_bdt: "0.00",
              credit_bdt: input.cost_bdt,
              memo: description,
            },
          ],
          ...(ip ? { ip } : {}),
        },
        session,
      );
      acquisitionEntryId = entry.id;
    }

    let created;
    try {
      created = await FixedAssetModel.create(
        [
          {
            org_id: orgId,
            code: input.code,
            name: input.name,
            category: input.category,
            purchase_date: input.purchase_date,
            cost_bdt: input.cost_bdt,
            salvage_bdt: input.salvage_bdt,
            useful_life_months: input.useful_life_months,
            method: "STRAIGHT_LINE",
            asset_account_code: input.asset_account_code,
            accum_account_code: input.accum_account_code,
            dep_expense_account_code: input.dep_expense_account_code,
            gain_account_code: input.gain_account_code,
            loss_account_code: input.loss_account_code,
            journal_entry_id: acquisitionEntryId,
            acquired_via: acquisitionEntryId ? "POSTED" : "REGISTERED",
            source_doc_no: input.source_doc_no,
            accumulated_depreciation_bdt: "0.00",
            last_depreciated_period: "",
            status: "ACTIVE",
            disposal: null,
            notes: input.notes,
            created_by: uid,
            updated_by: uid,
          },
        ],
        { session },
      ).then((rows) => rows[0]!);
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new AppError(409, "ASSET_TAG_TAKEN", `Asset tag ${input.code} is already used in this register.`);
      }
      throw error;
    }

    // The acquisition entry records which asset it funded, so the journal reads
    // as a story. Written after the row exists because the id is the pointer.
    if (acquisitionEntryId) {
      await JournalEntryModel.updateOne(
        { _id: acquisitionEntryId, org_id: orgId },
        { $set: { source_id: String(created._id) } },
        { session },
      );
    }

    const view = toAssetView(created.toObject());

    await writeAudit({
      orgId,
      uid,
      entity: "assets.asset",
      entityId: view.id,
      action: "ASSET_REGISTERED",
      after: {
        code: view.code,
        name: view.name,
        cost_bdt: view.cost_bdt,
        salvage_bdt: view.salvage_bdt,
        useful_life_months: view.useful_life_months,
        acquired_via: view.acquired_via,
        journal_entry_id: view.journal_entry_id,
      },
      ...(ip ? { ip } : {}),
    });

    return view;
  });
}

/* ── Update ──────────────────────────────────────────────────────────────── */

/**
 * PATCH. Which fields may move depends on whether anything has been posted from
 * this row, and the two cases are handled explicitly rather than by a rule the
 * reader has to infer.
 */
export async function updateAsset(
  orgId: string,
  uid: string,
  id: string,
  input: UpdateAssetInput,
  ip?: string,
): Promise<AssetView> {
  const existing = await requireAsset(orgId, id);

  if (existing.status === "DISPOSED") {
    throw new AppError(
      422,
      "ASSET_DISPOSED",
      "This asset has already left the books. Undo the disposal first if something about it needs correcting.",
    );
  }

  await checkAccounts(orgId, input);

  const patch: Record<string, unknown> = { updated_by: uid };
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.category !== undefined) patch["category"] = input.category;
  if (input.notes !== undefined) patch["notes"] = input.notes;
  if (input.asset_account_code !== undefined) patch["asset_account_code"] = input.asset_account_code;
  if (input.accum_account_code !== undefined) patch["accum_account_code"] = input.accum_account_code;
  if (input.dep_expense_account_code !== undefined) {
    patch["dep_expense_account_code"] = input.dep_expense_account_code;
  }
  if (input.gain_account_code !== undefined) patch["gain_account_code"] = input.gain_account_code;
  if (input.loss_account_code !== undefined) patch["loss_account_code"] = input.loss_account_code;

  if (input.useful_life_months !== undefined) {
    // Shortening the life below what has already been written off would leave the
    // accumulated figure above the depreciable base — an asset depreciated past
    // its floor. Refused rather than clamped, because clamping would silently
    // leave the register disagreeing with what the runs already posted.
    const base = depreciableBase({
      cost: money(existing.cost_bdt ?? "0.00"),
      salvage: money(input.salvage_bdt ?? existing.salvage_bdt ?? "0.00"),
      usefulLifeMonths: input.useful_life_months,
    });
    if (base.lessThan(money(existing.accumulated_depreciation_bdt ?? "0.00"))) {
      throw new AppError(
        422,
        "LIFE_BELOW_WRITTEN_DOWN",
        "That useful life would put the depreciable amount below what has already been written off. Set a longer life, or correct the runs.",
      );
    }
    patch["useful_life_months"] = input.useful_life_months;
  }

  if (input.salvage_bdt !== undefined) {
    const cost = money(existing.cost_bdt ?? "0.00");
    if (money(input.salvage_bdt).greaterThanOrEqualTo(cost)) {
      throw new AppError(
        422,
        "SALVAGE_NOT_BELOW_COST",
        "The salvage value has to be below what the asset cost.",
      );
    }
    if (money(existing.accumulated_depreciation_bdt ?? "0.00").greaterThan(cost.minus(money(input.salvage_bdt)))) {
      throw new AppError(
        422,
        "SALVAGE_BELOW_WRITTEN_DOWN",
        "That salvage value is below what has already been written off. Raise it, or correct the runs.",
      );
    }
    patch["salvage_bdt"] = input.salvage_bdt;
  }

  const updated = await FixedAssetModel.findOneAndUpdate(
    { _id: id, org_id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();
  if (!updated) throw notFoundError("That asset does not exist.");

  const view = toAssetView(updated);

  await writeAudit({
    orgId,
    uid,
    entity: "assets.asset",
    entityId: id,
    action: "ASSET_UPDATED",
    before: toAssetView(existing),
    after: view,
    ...(ip ? { ip } : {}),
  });
  return view;
}

/* ── Disposal ────────────────────────────────────────────────────────────── */

export interface DisposalResult {
  asset: AssetView;
  /** The month's depreciation charged as part of the disposal, if any — null when
   *  the disposal month had already been run in full. */
  stub_period: string | null;
  stub_amount_bdt: string;
  journal_entry_id: string;
  gain_bdt: string;
  loss_bdt: string;
}

/**
 * Take an asset off the books.
 *
 * FOUR THINGS HAPPEN, IN THIS ORDER, IN ONE TRANSACTION
 *
 *  1. **The disposal month is charged up to the day it left.** An asset sold on
 *     the 10th was in service for ten days of that month, and disposing of it
 *     without charging those days would overstate the proceeds' gain (or
 *     understate the loss) by exactly the missing charge. If that month has
 *     already been run in full, nothing more is charged — the register does not
 *     claw back part of a month it has already written off.
 *
 *  2. **The accumulated depreciation is cleared.** Its balance is debited away.
 *
 *  3. **The cost leaves the asset account**, credited at what it cost.
 *
 *  4. **The difference posts as a gain or a loss** against whatever the disposal
 *     fetched. Proceeds equal to the book value post neither, which is the
 *     arithmetic, not a special case.
 *
 * Months that were never run before the disposal are *not* silently made up: the
 * charge depends on what each month was worth, and inventing one at disposal time
 * would be the register guessing on somebody's behalf. A screen shows the months
 * still due; run them first if they are owed.
 */
export async function disposeAsset(
  orgId: string,
  uid: string,
  id: string,
  input: DisposeAssetInput,
  ip?: string,
): Promise<DisposalResult> {
  const existing = await requireAsset(orgId, id);
  if (existing.status === "DISPOSED") {
    throw new AppError(409, "ALREADY_DISPOSED", "That asset has already left the books.");
  }
  if (input.date < existing.purchase_date) {
    throw new AppError(
      422,
      "DISPOSAL_BEFORE_PURCHASE",
      `That asset was bought on ${existing.purchase_date}, so it cannot be disposed of before then.`,
    );
  }

  return inTransaction(async (session) => {
    // The proceeds account only has to exist and be an asset when there are
    // proceeds to land in it; a scrap names one the schema defaulted, and
    // refusing a scrap because a bank account was renamed would be the guard
    // getting in the way of the event.
    if (money(input.proceeds_bdt).greaterThan(ZERO)) {
      await requireAccountOfType(orgId, input.proceeds_account_code, "ASSET", "The proceeds account");
    }

    const terms = termsOf(existing);
    const period = monthOf(input.date);

    /* 1. The stub charge for the month it left in. */
    let stubPeriod: string | null = null;
    let stubAmount: Money = ZERO;
    let accumulated = money(existing.accumulated_depreciation_bdt ?? "0.00");

    const alreadyRun = await DepreciationRunModel.findOne({
      org_id: orgId,
      asset_id: id,
      period_key: period,
      status: "POSTED",
    })
      .session(session)
      .lean();

    if (!alreadyRun && period >= monthOf(existing.purchase_date)) {
      const charge = chargeForPeriod(
        terms,
        accumulated,
        period,
        existing.purchase_date,
        disposalThroughDay(period, input.date),
      );
      if (charge.amount.greaterThan(ZERO)) {
        await recordDepreciationBatch(
          orgId,
          uid,
          [
            {
              asset: existing,
              period_key: period,
              date: postingDateForPeriod(period),
              amount: charge.amount,
              accumBefore: accumulated,
              daysCharged: charge.daysCharged,
              daysInMonth: charge.daysInMonth,
              prorated: charge.prorated,
              final: charge.final,
            },
          ],
          `Depreciation to disposal — ${existing.code} ${existing.name}`,
          session,
        );
        stubPeriod = period;
        stubAmount = charge.amount;
        accumulated = accumulated.plus(charge.amount);
      }
    }

    /* 2–4. The disposal itself. */
    const cost = money(existing.cost_bdt ?? "0.00");
    const proceeds = money(input.proceeds_bdt);
    const nbv = cost.minus(accumulated);
    const difference = proceeds.minus(nbv);
    const gain = difference.greaterThan(ZERO) ? difference : ZERO;
    const loss = difference.isNegative() ? difference.negated() : ZERO;

    const where = input.proceeds_account_code;
    const description = `Disposal — ${existing.code} ${existing.name}`;
    const lines: JournalLineInput[] = [];

    if (accumulated.greaterThan(ZERO)) {
      lines.push({
        account_code: existing.accum_account_code,
        debit_bdt: fmt(accumulated),
        credit_bdt: "0.00",
        memo: `${description} — accumulated depreciation cleared`,
      });
    }
    lines.push({
      account_code: existing.asset_account_code,
      debit_bdt: "0.00",
      credit_bdt: fmt(cost),
      memo: `${description} — cost removed`,
    });
    if (proceeds.greaterThan(ZERO)) {
      lines.push({
        account_code: where,
        debit_bdt: fmt(proceeds),
        credit_bdt: "0.00",
        memo: `${description} — proceeds`,
      });
    }
    if (gain.greaterThan(ZERO)) {
      lines.push({
        account_code: existing.gain_account_code,
        debit_bdt: "0.00",
        credit_bdt: fmt(gain),
        memo: `${description} — gain on disposal`,
      });
    }
    if (loss.greaterThan(ZERO)) {
      lines.push({
        account_code: existing.loss_account_code,
        debit_bdt: fmt(loss),
        credit_bdt: "0.00",
        memo: `${description} — loss on disposal`,
      });
    }

    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description: `${description} — ${input.reason}`,
        source: "DISPOSAL",
        source_id: id,
        lines,
        ...(ip ? { ip } : {}),
      },
      session,
    );

    const updated = await FixedAssetModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: "ACTIVE" },
      {
        $set: {
          status: "DISPOSED",
          updated_by: uid,
          disposal: {
            date: input.date,
            proceeds_bdt: fmt(proceeds),
            proceeds_account_code: where,
            reason: input.reason,
            cost_bdt: fmt(cost),
            accumulated_bdt: fmt(accumulated),
            nbv_bdt: fmt(nbv),
            gain_bdt: fmt(gain),
            loss_bdt: fmt(loss),
            gain_account_code: existing.gain_account_code,
            loss_account_code: existing.loss_account_code,
            journal_entry_id: entry.id,
            voided_by_entry_id: null,
            void_reason: "",
            disposed_by: uid,
          },
        },
      },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "ALREADY_DISPOSED", "That asset was disposed of by another request a moment ago.");
    }

    await writeAudit({
      orgId,
      uid,
      entity: "assets.asset",
      entityId: id,
      action: "ASSET_DISPOSED",
      before: { status: "ACTIVE", accumulated_depreciation_bdt: existing.accumulated_depreciation_bdt ?? "0.00" },
      after: {
        status: "DISPOSED",
        date: input.date,
        proceeds_bdt: fmt(proceeds),
        nbv_bdt: fmt(nbv),
        gain_bdt: fmt(gain),
        loss_bdt: fmt(loss),
        journal_entry_id: entry.id,
        reason: input.reason,
      },
      ...(ip ? { ip } : {}),
    });

    return {
      asset: toAssetView(updated),
      stub_period: stubPeriod,
      stub_amount_bdt: fmt(stubAmount),
      journal_entry_id: entry.id,
      gain_bdt: fmt(gain),
      loss_bdt: fmt(loss),
    };
  });
}

/**
 * Undo a disposal.
 *
 * The disposal entry is voided by writing its mirror — the same mechanism every
 * other reversal in this codebase uses — and the asset returns to ACTIVE with its
 * accumulated depreciation exactly as it was, because the disposal's own entry is
 * what moved it and the mirror puts it back.
 *
 * The stub charge made as part of the disposal is **not** reversed: it was a
 * correct charge for the days the asset was in service, and undoing the sale does
 * not un-happen those days. If the asset is disposed of again in the same month,
 * the month is already run and no second stub is charged.
 */
export async function voidDisposal(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<AssetView> {
  const existing = await requireAsset(orgId, id);
  if (existing.status !== "DISPOSED" || !existing.disposal) {
    throw new AppError(409, "NOT_DISPOSED", "That asset is still on the books, so there is no disposal to undo.");
  }
  if (existing.disposal.voided_by_entry_id) {
    throw new AppError(409, "DISPOSAL_ALREADY_VOID", "That disposal has already been undone.");
  }

  return inTransaction(async (session) => {
    const { reversal } = await voidEntry(
      orgId,
      uid,
      String(existing.disposal!.journal_entry_id),
      reason,
      ip,
      session,
    );

    const updated = await FixedAssetModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: "DISPOSED" },
      {
        $set: {
          status: "ACTIVE",
          updated_by: uid,
          "disposal.voided_by_entry_id": reversal.id,
          "disposal.void_reason": reason.trim(),
        },
      },
      { new: true, session },
    ).lean();
    if (!updated) throw notFoundError("That asset does not exist.");

    await writeAudit({
      orgId,
      uid,
      entity: "assets.asset",
      entityId: id,
      action: "ASSET_DISPOSAL_VOIDED",
      before: { status: "DISPOSED", journal_entry_id: existing.disposal!.journal_entry_id },
      after: { status: "ACTIVE", reversal_entry_id: reversal.id, reason: reason.trim() },
      ...(ip ? { ip } : {}),
    });

    return toAssetView(updated);
  });
}
