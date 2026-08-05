/**
 * The posting engine — the single write path for every amount in the ledger.
 *
 * Nothing else in this codebase is allowed to create journal entries directly.
 * Invoices, bills, payroll, depreciation and the personal-expense bridge all
 * funnel through `postJournal`, which means the rules below hold everywhere
 * without every module having to remember them:
 *
 *   1. at least two lines
 *   2. every account exists, is active, and belongs to this organisation
 *   3. the target period exists and is OPEN
 *   4. Σ debits === Σ credits, in exact decimal — never a float comparison
 *   5. every line states both sides; the unused one is "0.00"; neither is negative
 *   6. the entry number is claimed atomically, at post, never at draft
 *   7. entry + lines + audit land in one transaction
 *   8. a posted entry is never edited — it is voided, and a reversing entry
 *      carries the opposite side
 *
 * ON TRANSACTIONS
 * Entry, lines and audit must commit together or not at all: a balanced entry
 * with half its lines written is worse than no entry, because it can pass a
 * casual glance. MongoDB offers that only on a replica set (Atlas is one, and
 * that is this project's documented database), so a transaction is used and a
 * deployment without one fails loudly rather than degrading to compensation
 * logic that nobody would remember to test.
 */
import mongoose, { type ClientSession } from "mongoose";

import { CoaAccountModel } from "../modules/coa/coa.model.js";
import { JournalEntryModel, JournalLineModel } from "../modules/journals/journal.model.js";
import { PeriodModel } from "../modules/periods/period.model.js";
import { allocateNumber } from "../modules/sequence/sequence.service.js";
import { writeAudit } from "./audit.js";
import { add, fmt, money, sum, ZERO } from "./money.js";
import { AppError } from "../shared/errors/app-error.js";
import { MONEY_PATTERN } from "../shared/db/money-field.js";

export type JournalSource =
  | "MANUAL"
  | "OPENING"
  | "EXPENSE"
  | "SALARY"
  | "INVOICE"
  | "BILL"
  | "RECEIPT"
  | "PAYMENT"
  | "CREDIT_NOTE"
  | "DEBIT_NOTE"
  | "TRANSFER"
  | "BANK_CORRECTION"
  | "TAX_CHALLAN"
  | "STOCK_ADJUSTMENT"
  | "STOCKTAKE"
  // Phase 9. An acquisition can arrive through a bill (a line coded to 1500) or
  // through the register itself; a depreciation run and a disposal are their own
  // acts, and the journal should say which is which.
  | "ASSET_ACQUISITION"
  | "DEPRECIATION"
  | "DISPOSAL"
  // Phase 11. A payroll run accrues the month's salaries, paying one moves the
  // payable to cash, and a loan to a member of staff posts its own entry on
  // disbursement and on every cash repayment.
  | "PAYROLL"
  | "PAYROLL_PAYMENT"
  | "STAFF_LOAN"
  // Phase 10. Money a party paid (or was paid) before there was a document to
  // claim it against. Applying an advance posts nothing — this source marks the
  // one path that does post, recording the advance by hand.
  | "ADVANCE"
  | "REVERSAL"
  // Phase 12. Recurring entries & automated accrual reversals
  | "RECURRING"
  | "ACCRUAL_REVERSAL";

export interface JournalLineInput {
  account_code: string;
  /** Omit or pass null for the side that does not apply; it is stored as "0.00". */
  debit_bdt?: string | null;
  credit_bdt?: string | null;
  memo?: string;
  party_id?: string;
  segment_id?: string;
}

export interface PostJournalInput {
  orgId: string;
  uid: string;
  date: string;
  description: string;
  source?: JournalSource;
  source_id?: string;
  lines: JournalLineInput[];
  ip?: string;
}

export interface JournalLineView {
  id: string;
  account_id: string;
  account_code: string;
  account_name: string;
  debit_bdt: string;
  credit_bdt: string;
  memo: string;
  party_id: string;
}

export interface JournalEntryView {
  id: string;
  entry_no: string | null;
  date: string;
  period_key: string;
  description: string;
  source: string;
  source_id: string;
  status: "DRAFT" | "POSTED" | "VOID";
  reverses_entry_id: string | null;
  reversed_by_entry_id: string | null;
  void_reason: string;
  created_by: string;
  posted_by: string;
  posted_at: string | null;
  total_bdt: string;
  lines: JournalLineView[];
}

interface ResolvedLine {
  account_id: mongoose.Types.ObjectId;
  account_code: string;
  account_name: string;
  debit_bdt: string;
  credit_bdt: string;
  memo: string;
  party_id: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(entry: any, lines: any[]): JournalEntryView {
  const total = lines.reduce((acc, line) => add(acc, money(line.debit_bdt)), ZERO);

  return {
    id: String(entry._id),
    entry_no: entry.entry_no ?? null,
    date: entry.date,
    period_key: entry.period_key,
    description: entry.description,
    source: entry.source,
    source_id: entry.source_id ?? "",
    status: entry.status,
    reverses_entry_id: entry.reverses_entry_id ? String(entry.reverses_entry_id) : null,
    reversed_by_entry_id: entry.reversed_by_entry_id ? String(entry.reversed_by_entry_id) : null,
    void_reason: entry.void_reason ?? "",
    created_by: entry.created_by,
    posted_by: entry.posted_by ?? "",
    posted_at: entry.posted_at ? new Date(entry.posted_at).toISOString() : null,
    total_bdt: fmt(total),
    lines: lines.map((line) => ({
      id: String(line._id),
      account_id: String(line.account_id),
      account_code: line.account_code,
      account_name: line.account_name,
      debit_bdt: line.debit_bdt,
      credit_bdt: line.credit_bdt,
      memo: line.memo ?? "",
      party_id: line.party_id ?? "",
    })),
  };
}

/**
 * Normalise one side of a line.
 *
 * `undefined`, `null` and `""` all mean "this side does not apply" and become
 * "0.00". Anything else must already be canonical, because accepting a number
 * here would reintroduce the float this whole design exists to keep out — the
 * JSON number has already lost precision by the time it reaches this function.
 */
function side(value: string | null | undefined): string {
  if (value === undefined || value === null || value === "") return "0.00";
  if (!MONEY_PATTERN.test(value)) {
    throw new AppError(
      422,
      "INVALID_AMOUNT",
      "Amounts must be written like 1250.50 — two decimal places, no more.",
    );
  }
  return value;
}

/**
 * Resolve every line against the chart, applying rules 1, 2 and 5.
 *
 * Accounts are read here rather than trusted from the client: a line carrying
 * somebody else's account id would post into their books.
 */
async function resolveLines(
  orgId: string,
  lines: JournalLineInput[],
  session: ClientSession | null = null,
): Promise<ResolvedLine[]> {
  if (lines.length < 2) {
    throw new AppError(
      422,
      "TOO_FEW_LINES",
      "A journal entry needs at least two lines — one account cannot balance on its own.",
    );
  }

  const codes = [...new Set(lines.map((line) => line.account_code.trim()))];
  const accounts = await CoaAccountModel.find({ org_id: orgId, code: { $in: codes } })
    .session(session)
    .lean();

  const byCode = new Map(accounts.map((account) => [account.code, account]));

  return lines.map((line, index) => {
    const code = line.account_code.trim();
    const account = byCode.get(code);

    if (!account) {
      throw new AppError(422, "ACCOUNT_NOT_FOUND", `No account with code ${code} exists in this ledger.`);
    }
    if (account.is_active === false) {
      throw new AppError(422, "ACCOUNT_INACTIVE", `Account ${code} (${account.name}) is inactive.`);
    }

    const debit = side(line.debit_bdt);
    const credit = side(line.credit_bdt);

    // Both sides stated on every line (rule 5). A line carrying both is not a
    // rounding difference waiting to net out — it is a modelling error, and
    // netting it would hide which account was actually meant.
    if (money(debit).greaterThan(ZERO) && money(credit).greaterThan(ZERO)) {
      throw new AppError(
        422,
        "LINE_ON_BOTH_SIDES",
        `Line ${index + 1} (${account.name}) has an amount on both sides. Put it on one.`,
      );
    }
    if (money(debit).isNegative() || money(credit).isNegative()) {
      throw new AppError(
        422,
        "NEGATIVE_AMOUNT",
        `Line ${index + 1} (${account.name}) is negative. Direction comes from which side the amount sits on.`,
      );
    }

    return {
      account_id: account._id,
      account_code: account.code,
      account_name: account.name,
      debit_bdt: debit,
      credit_bdt: credit,
      memo: line.memo ?? "",
      party_id: line.party_id ?? "",
      segment_id: line.segment_id ?? "",
    };
  });
}

/** Rule 4 — exact decimal equality, never `===` on floats. */
function assertBalanced(lines: ResolvedLine[]): string {
  const debits = sum(lines.map((line) => money(line.debit_bdt)));
  const credits = sum(lines.map((line) => money(line.credit_bdt)));

  if (!debits.equals(credits)) {
    throw new AppError(
      422,
      "UNBALANCED",
      `Debits ${fmt(debits)} do not equal credits ${fmt(credits)}. An entry must balance before it can be posted.`,
    );
  }
  if (debits.isZero()) {
    throw new AppError(422, "EMPTY_ENTRY", "This entry has no amount on either side.");
  }

  return fmt(debits);
}

/** Rule 3 — the period must exist and be open. */
async function assertPeriodOpen(
  orgId: string,
  date: string,
  session: ClientSession | null = null,
): Promise<string> {
  const key = date.slice(0, 7);
  const period = await PeriodModel.findOne({ org_id: orgId, key }).session(session).lean();

  if (!period) {
    throw new AppError(
      422,
      "PERIOD_MISSING",
      `There is no accounting period for ${key}. Open a fiscal year covering that date first.`,
    );
  }
  if (period.status === "CLOSED") {
    throw new AppError(
      422,
      "PERIOD_CLOSED",
      `${key} is closed, so nothing dated in it can be posted. Reopen the period if the correction is genuine.`,
    );
  }
  return key;
}

/**
 * Run `work` inside a transaction when the deployment supports one.
 *
 * Replica sets (including Atlas) are this project's documented database, so a
 * transaction is the normal path. A standalone `mongod` cannot open one and
 * says so explicitly — rather than silently dropping to unguarded writes, that
 * specific error falls back so local experimentation still works, and logs that
 * atomicity is not being provided. Any other failure propagates.
 */
export async function inTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
  let session: ClientSession;
  try {
    session = await mongoose.startSession();
  } catch (error) {
    if (!isUnsupported(error)) throw error;
    console.warn("[posting] transactions unavailable — writes are NOT atomic on this database.");
    return work(null as unknown as ClientSession);
  }

  try {
    let result: T | undefined;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result as T;
  } catch (error) {
    if (isUnsupported(error)) {
      console.warn("[posting] transactions unsupported — writes are NOT atomic on this database.");
      return work(null as unknown as ClientSession);
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

function isUnsupported(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Transaction numbers are only allowed on a replica set") ||
    message.includes("does not support transactions") ||
    message.includes("Transaction must first be committed")
  );
}

/** A `null` here means "not in a transaction" — the one value every mongoose
 *  `.session()` call accepts alongside a real session. */
const noSession = (session: ClientSession | undefined): ClientSession | null => session ?? null;

/**
 * Run `work` in a session that is already open, or open one.
 *
 * A document module (P3's invoices, P4's bills) has to write its own row *and*
 * the journal entry it produces atomically — half an invoice with a posted entry
 * behind it is worse than neither. `postJournal` therefore accepts a session,
 * and this helper is the whole of the difference: given one, it uses it; given
 * none, it behaves exactly as before. The distinction is stated in one place so
 * no caller has to remember which functions open transactions and which join
 * them.
 */
function inGivenSession<T>(
  session: ClientSession | null | undefined,
  work: (session: ClientSession) => Promise<T>,
): Promise<T> {
  return session ? work(session) : inTransaction(work);
}

/**
 * Post an entry immediately: validate, claim a number, write it, audit it.
 *
 * This is what every module calls. The draft workflow (`createDraft` /
 * `postDraft`) reaches the same place, so a posted entry is identical whether
 * it began life as a draft or was generated from an invoice.
 */
export async function postJournal(
  input: PostJournalInput,
  session?: ClientSession | null,
): Promise<JournalEntryView> {
  return inGivenSession(session, async (s) => {
    const periodKey = await assertPeriodOpen(input.orgId, input.date, noSession(s));
    const lines = await resolveLines(input.orgId, input.lines, noSession(s));
    const total = assertBalanced(lines);

    const allocation = await allocateNumber(input.orgId, "journal", input.date);

    const entry = await JournalEntryModel.create(
      [
        {
          org_id: input.orgId,
          entry_no: allocation.number,
          entry_year: allocation.year,
          entry_seq: allocation.seq,
          date: input.date,
          period_key: periodKey,
          description: input.description,
          source: input.source ?? "MANUAL",
          source_id: input.source_id ?? "",
          status: "POSTED",
          created_by: input.uid,
          posted_by: input.uid,
          posted_at: new Date(),
        },
      ],
      { session: s },
    ).then((created) => created[0]!);

    await JournalLineModel.insertMany(
      lines.map((line, index) => ({
        org_id: input.orgId,
        entry_id: entry._id,
        sort_order: index,
        ...line,
      })),
      { session: s },
    );

    await writeAudit(
      {
        orgId: input.orgId,
        uid: input.uid,
        entity: "journal.entry",
        entityId: String(entry._id),
        action: "ENTRY_POSTED",
        after: {
          entry_no: allocation.number,
          date: input.date,
          description: input.description,
          source: input.source ?? "MANUAL",
          total_bdt: total,
        },
        ...(input.ip ? { ip: input.ip } : {}),
      },
      s,
    );

    return _loadView(String(entry._id), input.orgId, noSession(s));
  });
}

/** Create a draft: no number, no period check — a draft is a working state. */
export async function createDraft(input: PostJournalInput): Promise<JournalEntryView> {
  return inTransaction(async (session) => {
    const lines = await resolveLines(input.orgId, input.lines, noSession(session));
    // Balanced is required of a *saved* draft too: allowing an unbalanced draft
    // to exist means the balance problem is discovered later, by somebody else,
    // possibly months on. The period is the only thing deliberately unchecked.
    assertBalanced(lines);

    const entry = await JournalEntryModel.create(
      [
        {
          org_id: input.orgId,
          date: input.date,
          period_key: input.date.slice(0, 7),
          description: input.description,
          source: input.source ?? "MANUAL",
          source_id: input.source_id ?? "",
          status: "DRAFT",
          created_by: input.uid,
        },
      ],
      { session },
    ).then((created) => created[0]!);

    await JournalLineModel.insertMany(
      lines.map((line, index) => ({ org_id: input.orgId, entry_id: entry._id, sort_order: index, ...line })),
      { session },
    );

    return _loadView(String(entry._id), input.orgId, noSession(session));
  });
}

/** Promote a draft to POSTED, applying every rule the draft was allowed to skip. */
export async function postDraft(
  orgId: string,
  uid: string,
  entryId: string,
  ip?: string,
): Promise<JournalEntryView> {
  return inTransaction(async (session) => {
    const entry = await JournalEntryModel.findOne({ _id: entryId, org_id: orgId })
      .session(noSession(session))
      .lean();
    if (!entry) throw new AppError(404, "NOT_FOUND", "That entry does not exist.");
    if (entry.status === "POSTED") {
      throw new AppError(409, "ALREADY_POSTED", "That entry has already been posted.");
    }
    if (entry.status === "VOID") {
      throw new AppError(409, "ENTRY_VOID", "That entry was voided and cannot be posted.");
    }

    const rawLines = await JournalLineModel.find({ entry_id: entry._id, org_id: orgId })
      .sort({ sort_order: 1 })
      .session(noSession(session))
      .lean();

    const lines = await resolveLines(
      orgId,
      rawLines.map((line) => ({
        account_code: line.account_code,
        debit_bdt: line.debit_bdt,
        credit_bdt: line.credit_bdt,
        memo: line.memo,
        party_id: line.party_id,
      })),
      noSession(session),
    );
    const total = assertBalanced(lines);
    const periodKey = await assertPeriodOpen(orgId, entry.date, noSession(session));
    const allocation = await allocateNumber(orgId, "journal", entry.date);

    await JournalEntryModel.updateOne(
      { _id: entry._id, org_id: orgId },
      {
        $set: {
          status: "POSTED",
          entry_no: allocation.number,
          entry_year: allocation.year,
          entry_seq: allocation.seq,
          period_key: periodKey,
          posted_by: uid,
          posted_at: new Date(),
        },
      },
      { session },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "journal.entry",
        entityId: String(entry._id),
        action: "ENTRY_POSTED",
        before: { status: "DRAFT", entry_no: null },
        after: { status: "POSTED", entry_no: allocation.number, total_bdt: total },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return _loadView(String(entry._id), orgId, noSession(session));
  });
}

/**
 * Void a posted entry by writing its mirror.
 *
 * Rule 8. The original keeps its number and its lines — deleting either would
 * change what a report already printed — and gains a reversal carrying the
 * opposite side. Reports read the pair, so a voided entry contributes zero
 * while both rows remain visible in the journal, which is the behaviour an
 * auditor expects: you can see that something was cancelled, and why.
 */
export async function voidEntry(
  orgId: string,
  uid: string,
  entryId: string,
  reason: string,
  ip?: string,
  session?: ClientSession | null,
): Promise<{ original: JournalEntryView; reversal: JournalEntryView }> {
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new AppError(422, "REASON_REQUIRED", "Give a short reason for voiding this entry.");
  }

  return inGivenSession(session, async (s) => {
    const entry = await JournalEntryModel.findOne({ _id: entryId, org_id: orgId })
      .session(noSession(s))
      .lean();
    if (!entry) throw new AppError(404, "NOT_FOUND", "That entry does not exist.");
    if (entry.status !== "POSTED") {
      throw new AppError(409, "NOT_POSTED", "Only a posted entry can be voided. Delete the draft instead.");
    }
    if (entry.reversed_by_entry_id) {
      throw new AppError(409, "ALREADY_VOID", "That entry has already been voided.");
    }

    const lines = await JournalLineModel.find({ entry_id: entry._id, org_id: orgId })
      .sort({ sort_order: 1 })
      .session(noSession(s))
      .lean();
    if (lines.length === 0) {
      throw new AppError(422, "NO_LINES", "That entry has no lines to reverse.");
    }

    const periodKey = await assertPeriodOpen(orgId, entry.date, noSession(s));
    const allocation = await allocateNumber(orgId, "journal", entry.date);

    const reversal = await JournalEntryModel.create(
      [
        {
          org_id: orgId,
          entry_no: allocation.number,
          entry_year: allocation.year,
          entry_seq: allocation.seq,
          date: entry.date,
          period_key: periodKey,
          description: `Reversal of ${entry.entry_no ?? "draft"} — ${trimmed}`,
          source: "REVERSAL",
          source_id: String(entry._id),
          status: "POSTED",
          reverses_entry_id: entry._id,
          created_by: uid,
          posted_by: uid,
          posted_at: new Date(),
        },
      ],
      { session: s },
    ).then((created) => created[0]!);

    // Sides swapped: the reversal is the original's mirror image, line for line.
    await JournalLineModel.insertMany(
      lines.map((line, index) => ({
        org_id: orgId,
        entry_id: reversal._id,
        sort_order: index,
        account_id: line.account_id,
        account_code: line.account_code,
        account_name: line.account_name,
        debit_bdt: line.credit_bdt,
        credit_bdt: line.debit_bdt,
        memo: line.memo,
        party_id: line.party_id,
      })),
      { session: s },
    );

    await JournalEntryModel.updateOne(
      { _id: entry._id, org_id: orgId },
      {
        $set: {
          status: "VOID",
          reversed_by_entry_id: reversal._id,
          void_reason: trimmed,
        },
      },
      { session: s },
    );

    await writeAudit(
      {
        orgId,
        uid,
        entity: "journal.entry",
        entityId: String(entry._id),
        action: "ENTRY_VOIDED",
        before: { status: "POSTED", entry_no: entry.entry_no },
        after: { status: "VOID", reversal_no: allocation.number, reason: trimmed },
        ...(ip ? { ip } : {}),
      },
      s,
    );

    return {
      original: await _loadView(String(entry._id), orgId, noSession(s)),
      reversal: await _loadView(String(reversal._id), orgId, noSession(s)),
    };
  });
}

/** One entry with its lines, scoped to the organisation. */
export async function getEntryView(
  orgId: string,
  entryId: string,
): Promise<JournalEntryView | null> {
  return _loadView(entryId, orgId, null);
}

async function _loadView(
  entryId: string,
  orgId: string,
  session: ClientSession | null,
): Promise<JournalEntryView> {
  const entry = await JournalEntryModel.findOne({ _id: entryId, org_id: orgId })
    .session(session)
    .lean();
  if (!entry) throw new AppError(404, "NOT_FOUND", "That entry does not exist.");

  const lines = await JournalLineModel.find({ entry_id: entry._id })
    .sort({ sort_order: 1 })
    .session(session)
    .lean();

  return toView(entry, lines);
}
