/**
 * The journal register — listing, filtering and the draft lifecycle.
 *
 * All mutation goes through `core/posting.ts`. This module owns the *reading*
 * side (what fills a register screen) and the two draft operations that are
 * about a draft's own lifecycle rather than about posting rules, so there is
 * exactly one place where an entry can be created and one where it can be void.
 *
 * Filters are deliberately cheap equality/range predicates: a register is a
 * hot path that someone opens dozens of times a day, and every one of them
 * lands on an index declared in `journal.model.ts`.
 */
import { z } from "zod";

import { JournalEntryModel, JournalLineModel } from "./journal.model.js";
import {
  createDraft,
  getEntryView,
  postDraft,
  postJournal,
  voidEntry,
  type JournalEntryView,
} from "../../core/posting.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, MonthInput } from "../../shared/validation/schemas.js";

export const ListJournalQuery = z.object({
  from: DateInput.optional(),
  to: DateInput.optional(),
  month: MonthInput.optional(),
  status: z.enum(["DRAFT", "POSTED", "VOID"]).optional(),
  account_code: z.string().trim().max(24).optional(),
  search: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const JournalInputSchema = z.object({
  date: DateInput,
  description: z.string().trim().min(2, "Describe what this entry is for.").max(300),
  lines: z
    .array(
      z.object({
        account_code: z.string().trim().min(1, "Pick an account.").max(24),
        debit_bdt: z.string().trim().max(16).optional(),
        credit_bdt: z.string().trim().max(16).optional(),
        memo: z.string().trim().max(300).optional(),
      }),
    )
    .min(2, "A journal entry needs at least two lines."),
});

export const VoidSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason for voiding this entry.").max(300),
});

export type ListJournalFilter = z.output<typeof ListJournalQuery>;
export type JournalInput = z.output<typeof JournalInputSchema>;

export interface JournalSummary {
  id: string;
  entry_no: string | null;
  date: string;
  period_key: string;
  description: string;
  source: string;
  status: string;
  total_bdt: string;
  line_count: number;
  void_reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toSummary(entry: any, lineCount: number): JournalSummary {
  return {
    id: String(entry._id),
    entry_no: entry.entry_no ?? null,
    date: entry.date,
    period_key: entry.period_key,
    description: entry.description,
    source: entry.source,
    status: entry.status,
    total_bdt: entry.total_bdt ?? "0.00",
    line_count: lineCount,
    void_reason: entry.void_reason ?? "",
  };
}

function baseFilter(orgId: string, query: ListJournalFilter): Record<string, unknown> {
  const filter: Record<string, unknown> = { org_id: orgId };

  if (query.month) {
    filter["period_key"] = query.month;
  } else {
    if (query.from || query.to) {
      filter["date"] = {
        ...(query.from ? { $gte: query.from } : {}),
        ...(query.to ? { $lte: query.to } : {}),
      };
    }
  }
  if (query.status) filter["status"] = query.status;
  if (query.search) filter["description"] = { $regex: query.search, $options: "i" };

  return filter;
}

/**
 * The register, newest first.
 *
 * Totals are stored on the entry when it posts rather than recomputed per row:
 * a register of 200 entries should not cost 200 line scans to draw.
 */
export async function listEntries(
  orgId: string,
  query: ListJournalFilter,
): Promise<{ entries: JournalSummary[]; total: number }> {
  const filter = baseFilter(orgId, query);

  const rows = await JournalEntryModel.find(filter)
    .sort({ date: -1, entry_no: -1, createdAt: -1 })
    .limit(query.limit)
    .lean();

  // A filtered-by-account register is the one case where the header line count
  // would be misleading, so only the matching lines are counted.
  if (query.account_code) {
    const ids = rows.map((row) => row._id);
    const counts = await JournalLineModel.aggregate<{ _id: unknown; n: number }>([
      { $match: { entry_id: { $in: ids }, account_code: query.account_code } },
      { $group: { _id: "$entry_id", n: { $sum: 1 } } },
    ]);
    const byEntry = new Map(counts.map((row) => [String(row._id), row.n]));
    const matched = rows.filter((row) => byEntry.has(String(row._id)));
    return {
      entries: matched.map((row) => toSummary(row, byEntry.get(String(row._id)) ?? 0)),
      total: matched.length,
    };
  }

  const counts = await JournalLineModel.aggregate<{ _id: unknown; n: number }>([
    { $match: { entry_id: { $in: rows.map((row) => row._id) } } },
    { $group: { _id: "$entry_id", n: { $sum: 1 } } },
  ]);
  const byEntry = new Map(counts.map((row) => [String(row._id), row.n]));

  const total = await JournalEntryModel.countDocuments(filter);

  return {
    entries: rows.map((row) => toSummary(row, byEntry.get(String(row._id)) ?? 0)),
    total,
  };
}

export async function getEntry(orgId: string, entryId: string): Promise<JournalEntryView> {
  const view = await getEntryView(orgId, entryId);
  if (!view) throw notFoundError("That entry does not exist.");
  return view;
}

export async function saveDraft(
  orgId: string,
  uid: string,
  input: JournalInput,
  ip?: string,
): Promise<JournalEntryView> {
  return createDraft({
    orgId,
    uid,
    date: input.date,
    description: input.description,
    source: "MANUAL",
    lines: input.lines,
    ...(ip ? { ip } : {}),
  });
}

export async function postJournalNow(
  orgId: string,
  uid: string,
  input: JournalInput,
  ip?: string,
): Promise<JournalEntryView> {
  return postJournal({
    orgId,
    uid,
    date: input.date,
    description: input.description,
    source: "MANUAL",
    lines: input.lines,
    ...(ip ? { ip } : {}),
  });
}

export { postDraft };

/**
 * Discard a draft.
 *
 * Only a draft can be discarded. A posted entry has a number that has already
 * been issued to somebody, and issuing it and then erasing it would leave a gap
 * with nothing to explain it — voiding exists precisely so the record explains
 * itself.
 */
export async function discardDraft(orgId: string, entryId: string): Promise<void> {
  const entry = await JournalEntryModel.findOne({ _id: entryId, org_id: orgId }).lean();
  if (!entry) throw notFoundError("That entry does not exist.");
  if (entry.status !== "DRAFT") {
    throw new AppError(
      409,
      "NOT_DRAFT",
      "Only a draft can be discarded. A posted entry is voided instead, so its number stays explained.",
    );
  }

  await JournalLineModel.deleteMany({ entry_id: entry._id, org_id: orgId });
  await JournalEntryModel.deleteOne({ _id: entry._id, org_id: orgId });
}

export { voidEntry };
