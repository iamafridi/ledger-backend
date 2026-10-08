import { z } from "zod";
import mongoose from "mongoose";

import {
  RecurringTemplateModel,
  FREQUENCIES,
  TEMPLATE_STATUSES,
  type Frequency,
  type TemplateStatus,
} from "./recurring.model.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { postJournal } from "../../core/posting.js";
import { money, fmt, sum } from "../../core/money.js";
import { writeAudit } from "../../core/audit.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DATE_PATTERN, MONEY_PATTERN } from "../../shared/db/money-field.js";

export const TemplateLineInputSchema = z.object({
  account_code: z.string().trim().min(1, "Account code is required"),
  debit_bdt: z.string().trim().regex(MONEY_PATTERN).default("0.00"),
  credit_bdt: z.string().trim().regex(MONEY_PATTERN).default("0.00"),
  memo: z.string().trim().max(300).default(""),
  party_id: z.string().trim().default(""),
  segment_id: z.string().trim().default(""),
});

export const CreateRecurringTemplateSchema = z.object({
  template_name: z.string().trim().min(2, "Template name is required").max(120),
  description: z.string().trim().max(300).default(""),
  frequency: z.enum(FREQUENCIES).default("MONTHLY"),
  next_run_date: z.string().regex(DATE_PATTERN, "Date must be YYYY-MM-DD"),
  end_date: z.string().regex(DATE_PATTERN).optional().nullable(),
  is_accrual: z.boolean().default(false),
  auto_post: z.boolean().default(false),
  lines: z.array(TemplateLineInputSchema).min(2, "At least two lines are required"),
});

export const UpdateRecurringTemplateSchema = z.object({
  template_name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(300).optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  next_run_date: z.string().regex(DATE_PATTERN).optional(),
  end_date: z.string().regex(DATE_PATTERN).optional().nullable(),
  is_accrual: z.boolean().optional(),
  auto_post: z.boolean().optional(),
  status: z.enum(TEMPLATE_STATUSES).optional(),
  lines: z.array(TemplateLineInputSchema).min(2).optional(),
});

export type CreateRecurringTemplateInput = z.output<typeof CreateRecurringTemplateSchema>;
export type UpdateRecurringTemplateInput = z.output<typeof UpdateRecurringTemplateSchema>;

export function calculateNextDate(currentDate: string, frequency: Frequency): string {
  const [yearStr, monthStr, dayStr] = currentDate.split("-");
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10) - 1; // 0-indexed
  const day = parseInt(dayStr!, 10);

  const date = new Date(Date.UTC(year, month, day));

  switch (frequency) {
    case "WEEKLY":
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case "MONTHLY":
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
    case "QUARTERLY":
      date.setUTCMonth(date.getUTCMonth() + 3);
      break;
    case "ANNUAL":
      date.setUTCFullYear(date.getUTCFullYear() + 1);
      break;
  }

  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function calculateReversalDate(entryDate: string): string {
  const [yearStr, monthStr] = entryDate.split("-");
  const year = parseInt(yearStr!, 10);
  const month = parseInt(monthStr!, 10) - 1;

  // First day of next month
  const date = new Date(Date.UTC(year, month + 1, 1));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface RecurringTemplateView {
  id: string;
  template_name: string;
  description: string;
  frequency: Frequency;
  next_run_date: string;
  end_date: string | null;
  is_accrual: boolean;
  auto_post: boolean;
  status: string;
  total_debit_bdt: string;
  total_credit_bdt: string;
  lines: Array<{
    account_id: string;
    account_code: string;
    account_name: string;
    debit_bdt: string;
    credit_bdt: string;
    memo: string;
    party_id: string;
    segment_id: string;
  }>;
  runs_count: number;
  last_run_date: string | null;
  last_entry_id: string | null;
  created_at: string;
  updated_at: string;
}

function toView(doc: any): RecurringTemplateView {
  const lines = (doc.lines || []).map((l: any) => ({
    account_id: String(l.account_id),
    account_code: l.account_code,
    account_name: l.account_name,
    debit_bdt: l.debit_bdt,
    credit_bdt: l.credit_bdt,
    memo: l.memo ?? "",
    party_id: l.party_id ?? "",
    segment_id: l.segment_id ?? "",
  }));

  const totalDebit = sum(lines.map((l: any) => money(l.debit_bdt)));
  const totalCredit = sum(lines.map((l: any) => money(l.credit_bdt)));

  return {
    id: String(doc._id),
    template_name: doc.template_name,
    description: doc.description ?? "",
    frequency: doc.frequency,
    next_run_date: doc.next_run_date,
    end_date: doc.end_date ?? null,
    is_accrual: doc.is_accrual,
    auto_post: doc.auto_post,
    status: doc.status,
    total_debit_bdt: fmt(totalDebit),
    total_credit_bdt: fmt(totalCredit),
    lines,
    runs_count: doc.runs?.length ?? 0,
    last_run_date: doc.last_run_date ?? null,
    last_entry_id: doc.last_entry_id ? String(doc.last_entry_id) : null,
    created_at: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
    updated_at: doc.updatedAt?.toISOString?.() ?? new Date().toISOString(),
  };
}

export async function listRecurringTemplates(
  orgId: string,
  options?: { status?: string },
): Promise<RecurringTemplateView[]> {
  const query: Record<string, unknown> = {
    org_id: new mongoose.Types.ObjectId(orgId),
  };
  if (options?.status) {
    query["status"] = options.status;
  }

  const docs = await RecurringTemplateModel.find(query).sort({ next_run_date: 1, createdAt: -1 }).lean();
  return docs.map(toView);
}

export async function getRecurringTemplateById(orgId: string, id: string): Promise<RecurringTemplateView> {
  const doc = await RecurringTemplateModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    org_id: new mongoose.Types.ObjectId(orgId),
  });
  if (!doc) {
    throw notFoundError("Recurring template not found.");
  }
  return toView(doc);
}

export async function createRecurringTemplate(
  orgId: string,
  input: CreateRecurringTemplateInput,
  actor: { uid: string; ip: string },
): Promise<RecurringTemplateView> {
  const debits = sum(input.lines.map((l) => money(l.debit_bdt)));
  const credits = sum(input.lines.map((l) => money(l.credit_bdt)));

  if (!debits.equals(credits)) {
    throw new AppError(422, "UNBALANCED", `Debits (${fmt(debits)}) do not match credits (${fmt(credits)}).`);
  }

  const codes = Array.from(new Set(input.lines.map((l) => l.account_code)));
  const accounts = await CoaAccountModel.find({
    org_id: new mongoose.Types.ObjectId(orgId),
    code: { $in: codes },
  }).lean();

  const accMap = new Map(accounts.map((a) => [a.code, a]));

  const resolvedLines = input.lines.map((l, index) => {
    const acc = accMap.get(l.account_code);
    if (!acc) {
      throw new AppError(422, "ACCOUNT_NOT_FOUND", `Account ${l.account_code} does not exist in this ledger.`);
    }
    return {
      account_id: acc._id,
      account_code: acc.code,
      account_name: acc.name,
      debit_bdt: l.debit_bdt,
      credit_bdt: l.credit_bdt,
      memo: l.memo || "",
      party_id: l.party_id || "",
      segment_id: l.segment_id || "",
    };
  });

  const created = await RecurringTemplateModel.create({
    org_id: new mongoose.Types.ObjectId(orgId),
    template_name: input.template_name,
    description: input.description,
    frequency: input.frequency,
    next_run_date: input.next_run_date,
    end_date: input.end_date || null,
    is_accrual: input.is_accrual,
    auto_post: input.auto_post,
    status: "ACTIVE",
    lines: resolvedLines,
    runs: [],
  });

  await writeAudit({
    orgId,
    entity: "recurring_template",
    entityId: String(created._id),
    action: "create",
    before: null,
    after: created.toObject(),
    uid: actor.uid,
    ip: actor.ip,
  });

  return toView(created);
}

export async function updateRecurringTemplate(
  orgId: string,
  id: string,
  input: UpdateRecurringTemplateInput,
  actor: { uid: string; ip: string },
): Promise<RecurringTemplateView> {
  const doc = await RecurringTemplateModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    org_id: new mongoose.Types.ObjectId(orgId),
  });
  if (!doc) {
    throw notFoundError("Recurring template not found.");
  }

  const before = doc.toObject();

  if (input.template_name !== undefined) doc.template_name = input.template_name;
  if (input.description !== undefined) doc.description = input.description;
  if (input.frequency !== undefined) doc.frequency = input.frequency;
  if (input.next_run_date !== undefined) doc.next_run_date = input.next_run_date;
  if (input.end_date !== undefined) doc.end_date = input.end_date ?? null;
  if (input.is_accrual !== undefined) doc.is_accrual = input.is_accrual;
  if (input.auto_post !== undefined) doc.auto_post = input.auto_post;
  if (input.status !== undefined) doc.status = input.status;

  if (input.lines) {
    const debits = sum(input.lines.map((l) => money(l.debit_bdt)));
    const credits = sum(input.lines.map((l) => money(l.credit_bdt)));

    if (!debits.equals(credits)) {
      throw new AppError(422, "UNBALANCED", `Debits (${fmt(debits)}) do not match credits (${fmt(credits)}).`);
    }

    const codes = Array.from(new Set(input.lines.map((l) => l.account_code)));
    const accounts = await CoaAccountModel.find({
      org_id: new mongoose.Types.ObjectId(orgId),
      code: { $in: codes },
    }).lean();

    const accMap = new Map(accounts.map((a) => [a.code, a]));

    doc.lines = input.lines.map((l) => {
      const acc = accMap.get(l.account_code);
      if (!acc) {
        throw new AppError(422, "ACCOUNT_NOT_FOUND", `Account ${l.account_code} does not exist in this ledger.`);
      }
      return {
        account_id: acc._id,
        account_code: acc.code,
        account_name: acc.name,
        debit_bdt: l.debit_bdt,
        credit_bdt: l.credit_bdt,
        memo: l.memo || "",
        party_id: l.party_id || "",
        segment_id: l.segment_id || "",
      };
    }) as any;
  }

  await doc.save();

  await writeAudit({
    orgId,
    entity: "recurring_template",
    entityId: String(doc._id),
    action: "update",
    before,
    after: doc.toObject(),
    uid: actor.uid,
    ip: actor.ip,
  });

  return toView(doc);
}

export async function runRecurringTemplate(
  orgId: string,
  id: string,
  options: { runDate?: string },
  actor: { uid: string; ip: string },
): Promise<{ entry_id: string; entry_no: string; next_run_date: string; reversal_entry_id?: string }> {
  const doc = await RecurringTemplateModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    org_id: new mongoose.Types.ObjectId(orgId),
  });
  if (!doc) {
    throw notFoundError("Recurring template not found.");
  }
  if (doc.status !== "ACTIVE") {
    throw new AppError(422, "TEMPLATE_NOT_ACTIVE", "Only active recurring templates can be run.");
  }

  const executionDate = options.runDate || doc.next_run_date;
  const periodKey = executionDate.slice(0, 7);

  // Idempotency check: don't double run for the same period
  const alreadyRan = (doc.runs || []).some((r: any) => r.period_key === periodKey);
  if (alreadyRan) {
    throw new AppError(
      409,
      "ALREADY_POSTED_FOR_PERIOD",
      `Recurring template ${doc.template_name} has already been posted for period ${periodKey}.`,
    );
  }

  // 1. Post primary journal entry
  const entryLines = doc.lines.map((l: any) => ({
    account_code: l.account_code,
    debit_bdt: l.debit_bdt,
    credit_bdt: l.credit_bdt,
    memo: l.memo || `Recurring: ${doc.template_name}`,
    party_id: l.party_id || undefined,
    segment_id: l.segment_id || undefined,
  }));

  const primaryEntry = await postJournal({
    orgId,
    uid: actor.uid,
    ip: actor.ip,
    date: executionDate,
    description: `Recurring: ${doc.template_name}`,
    source: "RECURRING",
    source_id: String(doc._id),
    lines: entryLines,
  });

  let reversalEntryId: string | undefined;

  // 2. If accrual template, post auto-reversing entry at first day of next period
  if (doc.is_accrual) {
    const reversalDate = calculateReversalDate(executionDate);
    const reversedLines = doc.lines.map((l: any) => ({
      account_code: l.account_code,
      debit_bdt: l.credit_bdt, // Flip debit & credit
      credit_bdt: l.debit_bdt,
      memo: `Auto-reversal: ${doc.template_name} (${executionDate})`,
      party_id: l.party_id || undefined,
      segment_id: l.segment_id || undefined,
    }));

    try {
      const reversalEntry = await postJournal({
        orgId,
        uid: actor.uid,
        ip: actor.ip,
        date: reversalDate,
        description: `Auto-reversal: ${doc.template_name}`,
        source: "ACCRUAL_REVERSAL",
        source_id: String(doc._id),
        lines: reversedLines,
      });
      reversalEntryId = reversalEntry.id;
    } catch (err) {
      console.warn("Could not post immediate accrual reversal (period may not be open yet):", err);
    }
  }

  // 3. Advance next_run_date
  const nextDate = calculateNextDate(executionDate, doc.frequency as Frequency);
  let nextStatus: TemplateStatus = doc.status as TemplateStatus;
  if (doc.end_date && nextDate > doc.end_date) {
    nextStatus = "COMPLETED";
  }

  doc.runs.push({
    run_date: executionDate,
    period_key: periodKey,
    entry_id: new mongoose.Types.ObjectId(primaryEntry.id),
    entry_no: primaryEntry.entry_no,
    reversed_entry_id: reversalEntryId ? new mongoose.Types.ObjectId(reversalEntryId) : null,
    executed_at: new Date(),
    executed_by: actor.uid,
  } as any);

  doc.last_run_date = executionDate;
  doc.last_entry_id = new mongoose.Types.ObjectId(primaryEntry.id);
  doc.next_run_date = nextDate;
  (doc as any).status = nextStatus;

  await doc.save();

  await writeAudit({
    orgId,
    entity: "recurring_template",
    entityId: String(doc._id),
    action: "execute_run",
    before: null,
    after: {
      entry_id: primaryEntry.id,
      entry_no: primaryEntry.entry_no,
      execution_date: executionDate,
      next_run_date: nextDate,
      reversal_entry_id: reversalEntryId,
    },
    uid: actor.uid,
    ip: actor.ip,
  });

  return {
    entry_id: primaryEntry.id,
    entry_no: primaryEntry.entry_no ?? "",
    next_run_date: nextDate,
    reversal_entry_id: reversalEntryId,
  };
}
