/**
 * Fiscal years, accounting periods, and opening balances.
 *
 * A period existing at all is what lets `postJournal` distinguish "you have not
 * set up your books yet" from "that month is closed" — two failures that look
 * identical to a user if both are just "cannot post". Every organisation gets
 * its first fiscal year at signup (see `openInitialFiscalYear`), so the common
 * case never needs this screen, and the screens exist for the cases where it
 * does.
 *
 * Opening balances are posted like any other entry, as one balanced `OPENING`
 * journal: never written straight into some balance column. That is the only
 * way a trial balance can be trusted from day one, because there is exactly one
 * code path that produced every number in it.
 */
import { z } from "zod";

import { FiscalYearModel, PeriodModel, type PeriodDocument } from "./period.model.js";
import { CoaAccountModel } from "../coa/coa.model.js";
import { OrganizationModel } from "../org/org.model.js";
import { postJournal } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput } from "../../shared/validation/schemas.js";
import { addMonths, daysInMonth, parseDate } from "../../core/calendar.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";

const DatePattern = /^\d{4}-\d{2}-\d{2}$/;

export const CreateYearSchema = z.object({
  start_date: z.string().trim().regex(DatePattern, "Start date must look like 2026-07-01."),
  months: z.coerce.number().int().min(1).max(24).default(12),
});

export const ClosePeriodSchema = z.object({
  key: z.string().trim().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "Period must look like 2026-07."),
  note: z.string().trim().max(300).default(""),
});

export const OpeningBalanceLine = z.object({
  account_code: z.string().trim().min(1).max(24),
  /** Positive, on the side it belongs to. Direction comes from the side. */
  debit_bdt: MoneyInput.optional(),
  credit_bdt: MoneyInput.optional(),
});

export const OpeningBalancesSchema = z.object({
  date: DateInput,
  description: z.string().trim().min(2, "Describe where these balances come from.").max(300),
  lines: z.array(OpeningBalanceLine).min(2, "Opening balances need at least two lines."),
});

export interface PeriodView {
  id: string;
  key: string;
  fiscal_year_id: string;
  status: "OPEN" | "CLOSED";
  closed_at: string | null;
  closed_by: string;
  close_note: string;
}

export interface FiscalYearView {
  id: string;
  label: string;
  start_date: string;
  end_date: string;
  status: "OPEN" | "CLOSED";
  periods: PeriodView[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPeriodView(doc: any): PeriodView {
  return {
    id: String(doc._id),
    key: doc.key,
    fiscal_year_id: String(doc.fiscal_year_id),
    status: doc.status,
    closed_at: doc.closed_at ? new Date(doc.closed_at).toISOString() : null,
    closed_by: doc.closed_by ?? "",
    close_note: doc.close_note ?? "",
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

/**
 * Create a fiscal year and its monthly periods.
 *
 * Idempotent per start date: two tabs both pressing "open the year" produce one
 * year, not two overlapping ones whose periods collide on their keys.
 */
export async function createFiscalYear(
  orgId: string,
  uid: string,
  input: z.output<typeof CreateYearSchema>,
  ip?: string,
): Promise<FiscalYearView> {
  const start = parseDate(input.start_date);
  const startMonth = input.start_date.slice(0, 7);

  const endMonthKey = addMonths(startMonth, input.months - 1);
  const end_date = `${endMonthKey}-${String(daysInMonth(endMonthKey)).padStart(2, "0")}`;

  let year;
  try {
    year = await FiscalYearModel.create({
      org_id: orgId,
      start_date: input.start_date,
      end_date,
      label: `${start.year}–${parseDate(end_date).year}`,
      status: "OPEN",
      created_by: uid,
    });
  } catch (error) {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "YEAR_EXISTS", "A fiscal year already starts on that date.");
    }
    throw error;
  }

  const periods: Array<Record<string, unknown>> = [];
  for (let index = 0; index < input.months; index += 1) {
    const key = addMonths(startMonth, index);
    periods.push({ org_id: orgId, fiscal_year_id: year._id, key, status: "OPEN" });
  }
  // Keys are unique per org, so a collision with an existing period would mean
  // two overlapping years — insertMany with ordered:false reports it rather
  // than half-writing a year.
  await PeriodModel.insertMany(periods, { ordered: false }).catch((error: unknown) => {
    if (isDuplicateKey(error)) {
      throw new AppError(409, "PERIODS_COLLIDE", "Those months already belong to another fiscal year.");
    }
    throw error;
  });

  await writeAudit({
    orgId,
    uid,
    entity: "fiscal.year",
    entityId: String(year._id),
    action: "FISCAL_YEAR_OPENED",
    after: { label: year.label, start_date: input.start_date, end_date, months: input.months },
    ...(ip ? { ip } : {}),
  });

  return getFiscalYear(orgId, String(year._id));
}

/**
 * The organisation's first fiscal year, opened at signup.
 *
 * The start comes from the organisation's `fiscal_year_start` (`MM-DD`), and
 * the year is the one containing today: opening a year that started eight months
 * ago would need eight months of back-dated periods, and opening next year's
 * would leave the current month with nowhere to post.
 */
export async function openInitialFiscalYear(orgId: string, uid: string): Promise<void> {
  const org = await OrganizationModel.findById(orgId).lean();
  if (!org) return;

  // The ledger's own date, not the server's: a UTC clock and Asia/Dhaka differ
  // by six hours, which is the difference between "the year started in July"
  // and "it starts next July" for a signup that happens in the evening.
  const today = todayInLedgerZone();
  const now = new Date(`${today}T00:00:00Z`);
  const [monthPart, dayPart] = org.fiscal_year_start.split("-");
  const thisYear = now.getUTCFullYear();

  const startsThisYear = `${thisYear}-${monthPart}-${dayPart}`;
  // If this year's start is already behind us the year is running; if it is
  // ahead, the current book year began last year. Comparing against today
  // rather than assuming decides it without a timezone in sight.
  const startDate = startsThisYear <= today ? startsThisYear : `${thisYear - 1}-${monthPart}-${dayPart}`;

  try {
    await createFiscalYear(orgId, uid, { start_date: startDate, months: 12 });
  } catch (error) {
    // Already open (a retry, or a second concurrent first request) — not a
    // failure worth surfacing to whoever was trying to sign in.
    if (!(error instanceof AppError && error.code === "YEAR_EXISTS")) throw error;
  }
}

export async function listFiscalYears(orgId: string): Promise<FiscalYearView[]> {
  const years = await FiscalYearModel.find({ org_id: orgId }).sort({ start_date: 1 }).lean();
  return Promise.all(years.map((year) => getFiscalYear(orgId, String(year._id))));
}

export async function getFiscalYear(orgId: string, yearId: string): Promise<FiscalYearView> {
  const year = await FiscalYearModel.findOne({ _id: yearId, org_id: orgId }).lean();
  if (!year) throw notFoundError("That fiscal year does not exist.");

  const periods = await PeriodModel.find({ org_id: orgId, fiscal_year_id: year._id })
    .sort({ key: 1 })
    .lean();

  return {
    id: String(year._id),
    label: year.label,
    start_date: year.start_date,
    end_date: year.end_date,
    status: year.status,
    periods: periods.map(toPeriodView),
  };
}

/** The period covering a date, or null when the books do not reach that far. */
export async function findPeriod(orgId: string, date: string): Promise<PeriodDocument | null> {
  return PeriodModel.findOne({ org_id: orgId, key: date.slice(0, 7) }).lean();
}

export async function closePeriod(
  orgId: string,
  uid: string,
  input: z.output<typeof ClosePeriodSchema>,
  ip?: string,
): Promise<PeriodView> {
  const period = await PeriodModel.findOne({ org_id: orgId, key: input.key }).lean();
  if (!period) throw notFoundError(`There is no period for ${input.key}.`);

  if (period.status === "CLOSED") {
    throw new AppError(409, "ALREADY_CLOSED", `${input.key} is already closed.`);
  }

  // Drafts are allowed to exist in a period that is closing — they are not in
  // the books — but a draft that would later post into a closed month is a
  // surprise waiting to happen, so say so now rather than at post time.
  const { JournalEntryModel } = await import("../journals/journal.model.js");
  const drafts = await JournalEntryModel.countDocuments({
    org_id: orgId,
    period_key: input.key,
    status: "DRAFT",
  });

  const updated = await PeriodModel.findOneAndUpdate(
    { _id: period._id, org_id: orgId },
    { $set: { status: "CLOSED", closed_at: new Date(), closed_by: uid, close_note: input.note } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError(`There is no period for ${input.key}.`);

  await writeAudit({
    orgId,
    uid,
    entity: "period",
    entityId: String(period._id),
    action: "PERIOD_CLOSED",
    before: { status: "OPEN" },
    after: { status: "CLOSED", note: input.note, open_drafts: drafts },
    ...(ip ? { ip } : {}),
  });

  return toPeriodView(updated);
}

export async function reopenPeriod(
  orgId: string,
  uid: string,
  key: string,
  ip?: string,
): Promise<PeriodView> {
  const period = await PeriodModel.findOne({ org_id: orgId, key }).lean();
  if (!period) throw notFoundError(`There is no period for ${key}.`);
  if (period.status === "OPEN") {
    throw new AppError(409, "ALREADY_OPEN", `${key} is already open.`);
  }

  const updated = await PeriodModel.findOneAndUpdate(
    { _id: period._id, org_id: orgId },
    { $set: { status: "OPEN" }, $unset: { closed_at: "", closed_by: "", close_note: "" } },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError(`There is no period for ${key}.`);

  await writeAudit({
    orgId,
    uid,
    entity: "period",
    entityId: String(period._id),
    action: "PERIOD_REOPENED",
    before: { status: "CLOSED", note: period.close_note },
    after: { status: "OPEN" },
    ...(ip ? { ip } : {}),
  });

  return toPeriodView(updated);
}

/**
 * Post opening balances as one balanced `OPENING` entry.
 *
 * Deliberately routed through the posting engine rather than written to any
 * balance field: the trial balance has exactly one producer, so "did we import
 * opening balances correctly" and "does the trial balance balance" stop being
 * two separate questions.
 */
export async function postOpeningBalances(
  orgId: string,
  uid: string,
  input: z.output<typeof OpeningBalancesSchema>,
  ip?: string,
): Promise<{ entry_id: string; entry_no: string | null; total_bdt: string }> {
  const entry = await postJournal({
    orgId,
    uid,
    date: input.date,
    description: input.description,
    source: "OPENING",
    lines: input.lines.map((line) => ({
      account_code: line.account_code,
      debit_bdt: line.debit_bdt ?? null,
      credit_bdt: line.credit_bdt ?? null,
      memo: "Opening balance",
    })),
    ...(ip ? { ip } : {}),
  });

  return { entry_id: entry.id, entry_no: entry.entry_no, total_bdt: entry.total_bdt };
}

/**
 * Make sure every one of `keys` (`YYYY-MM`) has a period, opening the fiscal
 * year that contains it when it does not. Returns the labels of the years it
 * created.
 *
 * WHY THIS EXISTS
 * The posting engine refuses a date with no period — correct, but it means
 * historic data can never be brought into the books on a ledger that opened its
 * first year around today. The D3 bridge needs the opposite: an expense recorded
 * in a month before the books began must still reach the general ledger, because
 * a dashboard and a trial balance that disagree about history is precisely the
 * failure the bridge exists to prevent.
 *
 * The year opened is the organisation's *own* fiscal year containing the
 * earliest uncovered month, so the calendar gains a year rather than an arbitrary
 * block of months. If that year cannot be opened because some of its months
 * already belong to another year — a partial overlap only a hand-edited calendar
 * produces — the months still uncovered are opened in contiguous runs instead.
 * Either way the caller is told which years were created, and both routes write
 * the same `FISCAL_YEAR_OPENED` audit row that a manual opening does.
 *
 * Idempotent: a month that already has a period is never touched.
 */
export async function ensurePeriodCoverage(
  orgId: string,
  uid: string,
  keys: string[],
): Promise<string[]> {
  const wanted = [...new Set(keys.filter((key) => /^\d{4}-\d{2}$/.test(key)))].sort();
  if (wanted.length === 0) return [];

  const opened: string[] = [];
  let missing = await uncoveredMonths(orgId, wanted);
  if (missing.length === 0) return opened;

  const org = await OrganizationModel.findById(orgId).lean();
  if (org) {
    const [monthPart = "07", dayPart = "01"] = org.fiscal_year_start.split("-");
    const start = fiscalYearStartContaining(missing[0]!, monthPart, dayPart);

    try {
      const year = await createFiscalYear(orgId, uid, { start_date: start, months: 12 });
      opened.push(year.label);
      missing = await uncoveredMonths(orgId, missing);
      if (missing.length === 0) return opened;
    } catch (error) {
      // A partial overlap is the only expected refusal here. Anything else is a
      // real failure and must not be swallowed.
      if (
        !(error instanceof AppError && (error.code === "PERIODS_COLLIDE" || error.code === "YEAR_EXISTS"))
      ) {
        throw error;
      }
    }
  }

  // Fallback: maximal runs of months that are still uncovered cannot overlap an
  // existing period by construction, so each run opens cleanly as its own year.
  for (const run of contiguousRuns(missing)) {
    const year = await createFiscalYear(orgId, uid, {
      start_date: `${run[0]}-01`,
      months: run.length,
    });
    opened.push(year.label);
  }

  return opened;
}

async function uncoveredMonths(orgId: string, keys: string[]): Promise<string[]> {
  const existing = await PeriodModel.find({ org_id: orgId, key: { $in: keys } })
    .select("key")
    .lean();
  const have = new Set(existing.map((row) => row.key));
  return keys.filter((key) => !have.has(key));
}

/**
 * The `MM-DD` fiscal-year boundary on or before a month key.
 *
 * Compared as text, because `"03" >= "07"` on the month part is exactly the
 * question being asked and it keeps the answer out of a Date. `"2026-03"` with a
 * July boundary is in the year that started `2025-07` — the year it is three
 * months into.
 */
function fiscalYearStartContaining(key: string, monthPart: string, dayPart: string): string {
  const year = key.slice(5) >= monthPart ? Number(key.slice(0, 4)) : Number(key.slice(0, 4)) - 1;
  return `${String(year).padStart(4, "0")}-${monthPart}-${dayPart}`;
}

/** `[a, b, c]` sorted month keys grouped into runs that touch: `[[a,b],[c]]`. */
function contiguousRuns(keys: string[]): string[][] {
  const runs: string[][] = [];
  for (const key of keys) {
    const current = runs[runs.length - 1];
    if (current && addMonths(current[current.length - 1]!, 1) === key) {
      current.push(key);
    } else {
      runs.push([key]);
    }
  }
  return runs;
}

/** Every account with its closing balance, as the opening-balance form needs. */
export async function accountsForOpening(orgId: string): Promise<
  Array<{ code: string; name: string; type: string; normal_balance: string }>
> {
  const accounts = await CoaAccountModel.find({ org_id: orgId, is_active: true })
    .sort({ code: 1 })
    .lean();
  return accounts.map((account) => ({
    code: account.code,
    name: account.name,
    type: account.type,
    normal_balance: account.normal_balance,
  }));
}
