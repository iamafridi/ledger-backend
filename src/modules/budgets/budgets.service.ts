import { z } from "zod";
import mongoose from "mongoose";

import { BudgetModel } from "./budgets.model.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { JournalLineModel } from "../journals/journal.model.js";
import { money, fmt, add, sub, mul, div, ZERO, type Money } from "../../core/money.js";
import { MoneyInput } from "../../shared/validation/schemas.js";
import { writeAudit } from "../../core/audit.js";

export const BudgetEntryItemSchema = z.object({
  account_code: z.string().trim().min(1),
  period_key: z.string().trim().min(4),
  budget_bdt: MoneyInput,
  segment_id: z.string().trim().default(""),
  notes: z.string().trim().max(300).default(""),
});

export const BulkUpsertBudgetSchema = z.object({
  entries: z.array(BudgetEntryItemSchema),
});

export type BulkUpsertBudgetInput = z.output<typeof BulkUpsertBudgetSchema>;

export interface BudgetView {
  id: string;
  period_key: string;
  account_code: string;
  account_name: string;
  segment_id: string;
  budget_bdt: string;
  notes: string;
}

export interface BudgetVarianceRow {
  account_code: string;
  account_name: string;
  account_type: string;
  period_key: string;
  segment_id: string;
  budget_bdt: string;
  actual_bdt: string;
  variance_bdt: string;
  variance_pct: string;
  is_favorable: boolean;
}

export async function listBudgets(
  orgId: string,
  params: { periodKey?: string; segmentId?: string },
): Promise<BudgetView[]> {
  const query: Record<string, unknown> = {
    org_id: new mongoose.Types.ObjectId(orgId),
  };
  if (params.periodKey) {
    query["period_key"] = params.periodKey;
  }
  if (params.segmentId !== undefined) {
    query["segment_id"] = params.segmentId;
  }

  const docs = await BudgetModel.find(query).sort({ period_key: 1, account_code: 1 }).lean();
  return docs.map((doc: any) => ({
    id: String(doc._id),
    period_key: doc.period_key,
    account_code: doc.account_code,
    account_name: doc.account_name,
    segment_id: doc.segment_id ?? "",
    budget_bdt: doc.budget_bdt,
    notes: doc.notes ?? "",
  }));
}

export async function bulkUpsertBudgets(
  orgId: string,
  input: BulkUpsertBudgetInput,
  actor: { uid: string; ip: string },
): Promise<{ count: number }> {
  if (!input.entries.length) {
    return { count: 0 };
  }

  const accountCodes = Array.from(new Set(input.entries.map((e) => e.account_code)));
  const accounts = await CoaAccountModel.find({
    org_id: new mongoose.Types.ObjectId(orgId),
    code: { $in: accountCodes },
  }).lean();

  const accountMap = new Map(accounts.map((a) => [a.code, a]));

  const operations = [];
  for (const entry of input.entries) {
    const acc = accountMap.get(entry.account_code);
    if (!acc) continue;

    operations.push({
      updateOne: {
        filter: {
          org_id: new mongoose.Types.ObjectId(orgId),
          period_key: entry.period_key,
          account_code: entry.account_code,
          segment_id: entry.segment_id,
        },
        update: {
          $set: {
            account_id: acc._id,
            account_name: acc.name,
            budget_bdt: entry.budget_bdt,
            notes: entry.notes,
          },
        },
        upsert: true,
      },
    });
  }

  if (operations.length > 0) {
    await BudgetModel.bulkWrite(operations);
  }

  await writeAudit({
    orgId,
    entity: "budget",
    entityId: "bulk",
    action: "update",
    before: null,
    after: { count: operations.length },
    uid: actor.uid,
    ip: actor.ip,
  });

  return { count: operations.length };
}

export async function getBudgetVariance(
  orgId: string,
  params: { periodKey: string; segmentId?: string },
): Promise<{ period_key: string; rows: BudgetVarianceRow[]; totals: { budget_bdt: string; actual_bdt: string; variance_bdt: string } }> {
  const orgOid = new mongoose.Types.ObjectId(orgId);

  // 1. Get all revenue and expense accounts
  const accounts = await CoaAccountModel.find({
    org_id: orgOid,
    type: { $in: ["REVENUE", "EXPENSE"] },
    is_active: true,
  })
    .sort({ type: 1, code: 1 })
    .lean();

  // 2. Fetch budgets for this period
  const budgetQuery: Record<string, unknown> = {
    org_id: orgOid,
    period_key: params.periodKey,
  };
  if (params.segmentId) {
    budgetQuery["segment_id"] = params.segmentId;
  }
  const budgets = await BudgetModel.find(budgetQuery).lean();
  const budgetMap = new Map(budgets.map((b) => [b.account_code, b.budget_bdt]));

  // 3. Aggregate actual journal lines for the target period
  const matchStage: Record<string, unknown> = {
    org_id: orgOid,
    "entry.status": { $in: ["POSTED", "VOID"] },
    "entry.period_key": params.periodKey,
  };
  if (params.segmentId) {
    matchStage["segment_id"] = params.segmentId;
  }

  const actualAgg = await JournalLineModel.aggregate([
    {
      $lookup: {
        from: "journalentries",
        localField: "entry_id",
        foreignField: "_id",
        as: "entry",
      },
    },
    { $unwind: "$entry" },
    { $match: matchStage },
    {
      $group: {
        _id: "$account_code",
        total_debit: { $sum: { $toDecimal: "$debit_bdt" } },
        total_credit: { $sum: { $toDecimal: "$credit_bdt" } },
      },
    },
  ]);

  const actualMap = new Map<string, { debit: Money; credit: Money }>();
  for (const row of actualAgg) {
    actualMap.set(String(row._id), {
      debit: money(String(row.total_debit)),
      credit: money(String(row.total_credit)),
    });
  }

  let totalBudget = ZERO;
  let totalActual = ZERO;
  const rows: BudgetVarianceRow[] = [];

  for (const acc of accounts) {
    const budgetStr = budgetMap.get(acc.code) ?? "0.00";
    const budgetVal = money(budgetStr);

    const actualData = actualMap.get(acc.code) ?? { debit: ZERO, credit: ZERO };
    let actualVal: Money;

    if (acc.type === "REVENUE") {
      // Normal balance is CREDIT: Revenue = Credit - Debit
      actualVal = sub(actualData.credit, actualData.debit);
    } else {
      // Normal balance is DEBIT: Expense = Debit - Credit
      actualVal = sub(actualData.debit, actualData.credit);
    }

    if (actualVal.lessThan(ZERO)) {
      actualVal = ZERO;
    }

    // Variance calculation:
    // For Expense: Variance = Budget - Actual (Positive if spent less than budget = Favorable)
    // For Revenue: Variance = Actual - Budget (Positive if earned more than budget = Favorable)
    let varianceVal: Money;
    let isFavorable: boolean;

    if (acc.type === "REVENUE") {
      varianceVal = sub(actualVal, budgetVal);
      isFavorable = !varianceVal.lessThan(ZERO);
    } else {
      varianceVal = sub(budgetVal, actualVal);
      isFavorable = !varianceVal.lessThan(ZERO);
    }

    let variancePct = "0.0%";
    if (!budgetVal.equals(ZERO)) {
      const pct = mul(div(varianceVal.abs(), budgetVal), money("100.00"));
      variancePct = `${fmt(pct)}%`;
    }

    totalBudget = add(totalBudget, budgetVal);
    totalActual = add(totalActual, actualVal);

    rows.push({
      account_code: acc.code,
      account_name: acc.name,
      account_type: acc.type,
      period_key: params.periodKey,
      segment_id: params.segmentId ?? "",
      budget_bdt: fmt(budgetVal),
      actual_bdt: fmt(actualVal),
      variance_bdt: fmt(varianceVal),
      variance_pct: variancePct,
      is_favorable: isFavorable,
    });
  }

  const totalVariance = sub(totalBudget, totalActual);

  return {
    period_key: params.periodKey,
    rows,
    totals: {
      budget_bdt: fmt(totalBudget),
      actual_bdt: fmt(totalActual),
      variance_bdt: fmt(totalVariance),
    },
  };
}
