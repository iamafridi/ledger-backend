/**
 * Monthly salary — required item 1's "let the user set a monthly salary".
 */
import { z } from "zod";

import { SalaryModel } from "./salary.model.js";
import { MoneyInput, MonthInput } from "../../shared/validation/schemas.js";
import { writeAudit } from "../../core/audit.js";

export const SetSalarySchema = z.object({
  month: MonthInput,
  amount_bdt: MoneyInput,
});

export const ListSalaryQuery = z.object({ month: MonthInput.optional() });

export interface SalaryView {
  month: string;
  amount_bdt: string;
}

export async function setSalary(
  uid: string,
  input: z.output<typeof SetSalarySchema>,
  orgId: string,
  ip?: string,
): Promise<SalaryView> {
  const previous = await SalaryModel.findOne({ uid, month: input.month }).lean();

  // Upsert on (uid, month): setting the salary twice for one month is a
  // correction, not a second salary.
  const saved = await SalaryModel.findOneAndUpdate(
    { uid, month: input.month },
    { $set: { amount_bdt: input.amount_bdt } },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();

  const view: SalaryView = { month: saved!.month, amount_bdt: saved!.amount_bdt };

  // Salary is the denominator of every percentage the dashboard reports, so a
  // silent change here would silently restate the whole ledger's conclusions.
  await writeAudit({
    orgId,
    uid,
    entity: "salary",
    entityId: input.month,
    action: "SALARY_SET",
    before: previous ? { month: previous.month, amount_bdt: previous.amount_bdt } : undefined,
    after: view,
    ...(ip ? { ip } : {}),
  });

  return view;
}

export async function getSalary(uid: string, month: string): Promise<string | null> {
  const found = await SalaryModel.findOne({ uid, month }).lean();
  return found?.amount_bdt ?? null;
}

/**
 * The salary in force for a month: the one set for that month, else the most
 * recent earlier one. Someone who set their salary in March and did not touch it
 * in April still has a salary in April — without this fallback the April
 * dashboard would report a zero salary and a catastrophic false shortfall.
 */
export async function effectiveSalary(uid: string, month: string): Promise<string> {
  const exact = await getSalary(uid, month);
  if (exact) return exact;

  const previous = await SalaryModel.findOne({ uid, month: { $lt: month } })
    .sort({ month: -1 })
    .lean();

  return previous?.amount_bdt ?? "0.00";
}

export async function listSalaries(uid: string): Promise<SalaryView[]> {
  const docs = await SalaryModel.find({ uid }).sort({ month: -1 }).limit(24).lean();
  return docs.map((doc) => ({ month: doc.month, amount_bdt: doc.amount_bdt }));
}
