/**
 * Statement import, matching and corrections (plan §6, Phase 6).
 *
 * THE FILE IS EVIDENCE, NOT TRUTH
 * An imported statement line is never posted by itself. It is either matched to
 * a journal line the books already contain, corrected (the missing entry is
 * posted *from* it, deliberately, by a person), or ignored with a reason. That
 * order matters: the safe default — do nothing — is also the default state, so a
 * half-finished reconciliation is visible rather than silently posting whatever
 * the bank said.
 *
 * THE FILE IS READ IN THE BROWSER AND POSTED AS TEXT
 * No multipart parser, no upload directory, no second dependency: the screen
 * reads the chosen file with `File.text()` and sends it as JSON, and parsing
 * happens here, server-side, where it is one tested pure function. A statement
 * CSV is a few hundred kilobytes at the very worst, well inside the request
 * limit.
 *
 * RE-UPLOADING OVERLAPPING STATEMENTS IS NORMAL
 * Banks hand out overlapping periods, and re-uploading yesterday's file is a
 * moment of inattention rather than an attack. Each line therefore carries a
 * fingerprint of its own content; rows this account has already seen are
 * **skipped and counted** in the import summary rather than doubling the
 * evidence or failing the whole file.
 */
import { createHash } from "node:crypto";
import mongoose from "mongoose";
import { z } from "zod";

import {
  BankAccountModel,
  StatementImportModel,
  StatementLineModel,
} from "./banking.model.js";
import { bookMovements, journalLineById } from "./banking.ledger.js";
import { parseStatementCsv, type ParsedStatementLine } from "./statement-csv.js";
import { requireAccountByCode } from "../coa/coa.service.js";
import { inTransaction, postJournal } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { fmt, money } from "../../core/money.js";
import { daysBetween } from "../../shared/dates/shift.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/* ── Input ───────────────────────────────────────────────────────────────── */

export const ImportStatementSchema = z.object({
  filename: z.string().trim().max(200).default(""),
  /** The whole file as text. See the note above on why this is not multipart. */
  csv: z.string().min(1, "Choose a statement file first.").max(1_500_000),
});

export const ListStatementLinesQuery = z.object({
  batch_id: ObjectIdInput.optional(),
  status: z.enum(["UNMATCHED", "MATCHED", "CORRECTED", "IGNORED"]).optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

export const MatchSchema = z.object({ journal_line_id: ObjectIdInput });

export const IgnoreSchema = z.object({
  note: z.string().trim().min(3, "Say why this line is being ignored.").max(300),
});

export const CorrectSchema = z.object({
  /** The other side of the missing entry: an expense account for a charge, an
   *  income account for interest credited. */
  counter_account_code: z.string().trim().min(1, "Choose the account this belongs to.").max(24),
  memo: z.string().trim().max(300).default(""),
});

export type ImportStatementInput = z.output<typeof ImportStatementSchema>;

/** Aggregation `$match` does not cast, so ids are converted explicitly. */
const oid = (id: string) => new mongoose.Types.ObjectId(id);

/* ── Views ───────────────────────────────────────────────────────────────── */

export interface StatementLineView {
  id: string;
  bank_account_id: string;
  batch_id: string;
  seq: number;
  date: string;
  description: string;
  reference: string;
  direction: "IN" | "OUT";
  amount_bdt: string;
  balance_bdt: string;
  status: "UNMATCHED" | "MATCHED" | "CORRECTED" | "IGNORED";
  matched_line_id: string | null;
  matched_entry_no: string;
  matched_amount_bdt: string;
  adjustment_entry_id: string | null;
  counter_account_code: string;
  note: string;
}

export interface StatementImportView {
  id: string;
  filename: string;
  imported_at: string;
  line_count: number;
  imported_count: number;
  duplicate_count: number;
  period_from: string;
  period_to: string;
  opening_balance_bdt: string;
  closing_balance_bdt: string;
  /** Lines of this import still awaiting a decision. */
  open_count: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lineView(doc: any): StatementLineView {
  return {
    id: String(doc._id),
    bank_account_id: String(doc.bank_account_id),
    batch_id: String(doc.batch_id),
    seq: doc.seq,
    date: doc.date,
    description: doc.description ?? "",
    reference: doc.reference ?? "",
    direction: doc.direction,
    amount_bdt: doc.amount_bdt,
    balance_bdt: doc.balance_bdt ?? "",
    status: doc.status,
    matched_line_id: doc.matched_line_id ? String(doc.matched_line_id) : null,
    matched_entry_no: doc.matched_entry_no ?? "",
    matched_amount_bdt: doc.matched_amount_bdt ?? "",
    adjustment_entry_id: doc.adjustment_entry_id ? String(doc.adjustment_entry_id) : null,
    counter_account_code: doc.counter_account_code ?? "",
    note: doc.note ?? "",
  };
}

/** Content fingerprint: what the line *is*, independent of the file it arrived
 *  in. Re-uploading the same period therefore repeats no evidence. */
export function fingerprintOf(line: Pick<ParsedStatementLine, "date" | "direction" | "amount_bdt" | "reference" | "description">): string {
  const basis = [line.date, line.direction, line.amount_bdt, line.reference.trim().toLowerCase(), line.description.trim().toLowerCase()].join("|");
  return createHash("sha1").update(basis).digest("hex").slice(0, 40);
}

/* ── Import ──────────────────────────────────────────────────────────────── */

export interface ImportResult {
  import: StatementImportView;
  lines: StatementLineView[];
  duplicates: number;
  /** Non-fatal remarks: a running balance that does not chain, for instance.
   *  Returned rather than logged, because it is the user's file that is odd. */
  warnings: string[];
}

export async function importStatement(
  orgId: string,
  uid: string,
  bankAccountId: string,
  input: ImportStatementInput,
  ip?: string,
): Promise<ImportResult> {
  assertObjectId(bankAccountId, "That bank account does not exist.");
  const account = await BankAccountModel.findOne({ _id: bankAccountId, org_id: orgId }).lean();
  if (!account) throw notFoundError("That bank account does not exist.");
  if (account.is_active === false) {
    throw new AppError(422, "ACCOUNT_INACTIVE", `${account.name} is inactive, so nothing can be imported against it.`);
  }

  const parsed = parseStatementCsv(input.csv);
  if (parsed.errors.length > 0) {
    throw new AppError(
      422,
      "STATEMENT_PARSE_FAILED",
      `The statement could not be read: ${parsed.errors[0]}`,
      { rows: parsed.errors.slice(0, 25) },
    );
  }

  const warnings = balanceChainWarnings(parsed.lines);
  const dated = parsed.lines.map((line) => ({ line, fingerprint: fingerprintOf(line) }));
  const fingerprints = dated.map((row) => row.fingerprint);

  const seen = new Set(
    (
      await StatementLineModel.find({ org_id: orgId, bank_account_id: account._id, fingerprint: { $in: fingerprints } })
        .select({ fingerprint: 1 })
        .lean()
    ).map((row) => row.fingerprint),
  );

  const kept: Array<{ line: ParsedStatementLine; fingerprint: string }> = [];
  const fresh = new Set<string>();
  for (const row of dated) {
    // Guard against a duplicate *within* the same file as well as against rows
    // already stored: a statement with the same transaction printed twice is
    // more likely a bad export than two identical transactions.
    if (seen.has(row.fingerprint) || fresh.has(row.fingerprint)) continue;
    fresh.add(row.fingerprint);
    kept.push(row);
  }
  const duplicates = dated.length - kept.length;

  const balances = kept.map((row) => row.line.balance_bdt).filter((value) => value !== "");
  const withBalance = kept.filter((row) => row.line.balance_bdt !== "");
  const dates = kept.map((row) => row.line.date).sort();
  const openingBalance =
    withBalance.length === kept.length && kept.length > 0
      ? fmt(sub1(withBalance[0]!.line.balance_bdt, withBalance[0]!.line))
      : "";
  const closingBalance = balances.length > 0 ? withBalance[withBalance.length - 1]!.line.balance_bdt : "";

  return inTransaction(async (session) => {
    const batch = await StatementImportModel.create(
      [
        {
          org_id: orgId,
          bank_account_id: account._id,
          filename: input.filename,
          line_count: parsed.lines.length,
          imported_count: kept.length,
          duplicate_count: duplicates,
          period_from: dates[0] ?? "",
          period_to: dates[dates.length - 1] ?? "",
          opening_balance_bdt: openingBalance,
          closing_balance_bdt: closingBalance,
          imported_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    if (kept.length > 0) {
      await StatementLineModel.insertMany(
        kept.map((row) => ({
          org_id: orgId,
          bank_account_id: account._id,
          batch_id: batch._id,
          seq: row.line.seq,
          date: row.line.date,
          description: row.line.description,
          reference: row.line.reference,
          direction: row.line.direction,
          amount_bdt: row.line.amount_bdt,
          balance_bdt: row.line.balance_bdt,
          fingerprint: row.fingerprint,
          status: "UNMATCHED",
        })),
        { session },
      );
    }

    // The account remembers the latest statement's closing figure so the list
    // screen can show the gap at a glance. It is a cached *label*, never the
    // source of the bank-side balance in reconciliation, which re-reads the
    // lines themselves.
    if (closingBalance !== "" && dates.length > 0) {
      await BankAccountModel.updateOne(
        { _id: account._id, org_id: orgId },
        { $set: { last_statement_balance_bdt: closingBalance, last_statement_date: dates[dates.length - 1]! } },
        { session },
      );
    }

    await writeAudit(
      {
        orgId,
        uid,
        entity: "banking.statement",
        entityId: String(batch._id),
        action: "STATEMENT_IMPORTED",
        after: {
          account_code: account.account_code,
          filename: input.filename,
          imported: kept.length,
          duplicates,
          period_from: dates[0] ?? "",
          period_to: dates[dates.length - 1] ?? "",
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    const stored = await StatementLineModel.find({ org_id: orgId, batch_id: batch._id })
      .sort({ seq: 1 })
      .session(session)
      .lean();

    return {
      import: importView(batch.toObject(), kept.length),
      lines: stored.map(lineView),
      duplicates,
      warnings,
    };
  });
}

/** `balance − amount` in the line's own direction: the balance *before* it. */
function sub1(balance: string, line: ParsedStatementLine) {
  const value = money(balance);
  return line.direction === "IN" ? value.minus(money(line.amount_bdt)) : value.plus(money(line.amount_bdt));
}

/**
 * A running balance that does not chain means the file was mangled (columns
 * shifted, a row pasted twice, a total row kept). Reported, never fatal: the
 * lines themselves are still readable, and the person who knows the account
 * should decide.
 */
function balanceChainWarnings(lines: readonly ParsedStatementLine[]): string[] {
  const withBalance = lines.filter((line) => line.balance_bdt !== "");
  if (withBalance.length !== lines.length || lines.length < 2) return [];

  const warnings: string[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    const previous = lines[index - 1]!;
    const current = lines[index]!;
    // The new balance follows from the previous one *by the current line's*
    // own direction — that is the whole point of a running balance.
    const expected =
      current.direction === "IN"
        ? money(previous.balance_bdt).plus(money(current.amount_bdt))
        : money(previous.balance_bdt).minus(money(current.amount_bdt));
    if (!expected.equals(money(current.balance_bdt))) {
      warnings.push(
        `Row ${current.seq}: the running balance does not follow from row ${previous.seq} — the file may have been edited or re-ordered.`,
      );
      if (warnings.length >= 5) break;
    }
  }
  return warnings;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function importView(doc: any, openCount: number): StatementImportView {
  return {
    id: String(doc._id),
    filename: doc.filename ?? "",
    imported_at: doc.createdAt ? new Date(doc.createdAt).toISOString() : "",
    line_count: doc.line_count,
    imported_count: doc.imported_count,
    duplicate_count: doc.duplicate_count,
    period_from: doc.period_from ?? "",
    period_to: doc.period_to ?? "",
    opening_balance_bdt: doc.opening_balance_bdt ?? "",
    closing_balance_bdt: doc.closing_balance_bdt ?? "",
    open_count: openCount,
  };
}

/* ── Reads ───────────────────────────────────────────────────────────────── */

export async function listImports(orgId: string, bankAccountId: string): Promise<StatementImportView[]> {
  const batches = await StatementImportModel.find({ org_id: orgId, bank_account_id: bankAccountId })
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
  if (batches.length === 0) return [];

  // Open counts for every batch in one read rather than one query per batch.
  const openRows = await StatementLineModel.aggregate<{ _id: unknown; open: number }>([
    {
      $match: {
        org_id: oid(orgId),
        bank_account_id: oid(bankAccountId),
        status: "UNMATCHED",
        batch_id: { $in: batches.map((batch) => batch._id) },
      },
    },
    { $group: { _id: "$batch_id", open: { $sum: 1 } } },
  ]);
  const openByBatch = new Map(openRows.map((row) => [String(row._id), row.open]));

  return batches.map((batch) => importView(batch, openByBatch.get(String(batch._id)) ?? 0));
}

export async function listStatementLines(
  orgId: string,
  bankAccountId: string,
  query: z.output<typeof ListStatementLinesQuery>,
): Promise<StatementLineView[]> {
  const filter: Record<string, unknown> = { org_id: orgId, bank_account_id: bankAccountId };
  if (query.batch_id) filter["batch_id"] = query.batch_id;
  if (query.status) filter["status"] = query.status;
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await StatementLineModel.find(filter).sort({ date: 1, seq: 1 }).limit(query.limit).lean();
  return rows.map(lineView);
}

export interface Suggestion {
  journal_line_id: string;
  entry_no: string | null;
  date: string;
  description: string;
  amount_bdt: string;
  amount_matches: boolean;
  reasons: string[];
  /** A high score is a strong suggestion, and the screen orders by it. */
  score: number;
}

/**
 * What this statement line probably is, drawn from the book movements around it.
 *
 * The window is ±7 days (a card settlement and its posting are rarely the same
 * day), and the reasons are returned rather than just a number so the screen can
 * say *why* something is being suggested — an unexplained suggestion is one
 * nobody can check. Lines already matched elsewhere are excluded, so the same
 * journal line is never offered twice.
 */
export async function suggestionsFor(
  orgId: string,
  accountCode: string,
  line: StatementLineView,
): Promise<Suggestion[]> {
  const window = {
    from: shiftDay(line.date, -7),
    to: shiftDay(line.date, 7),
  };
  const [movements, taken] = await Promise.all([
    bookMovements(orgId, accountCode, window),
    StatementLineModel.find({ org_id: orgId, matched_line_id: { $ne: null } })
      .select({ matched_line_id: 1 })
      .lean(),
  ]);
  const used = new Set(taken.map((row) => String(row.matched_line_id)));

  const tokens = new Set(
    `${line.description} ${line.reference}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3),
  );

  const out: Suggestion[] = [];
  for (const movement of movements) {
    if (used.has(movement.line_id)) continue;

    const reasons: string[] = [];
    const amountMatches = movement.amount_bdt === line.amount_bdt;
    if (amountMatches) reasons.push("same amount");
    if (movement.direction === line.direction) reasons.push("same direction");

    const haystack = `${movement.description} ${movement.memo} ${movement.entry_no ?? ""}`.toLowerCase();
    const shared = [...tokens].filter((token) => haystack.includes(token));
    if (shared.length > 0) reasons.push(`mentions ${shared.slice(0, 2).join(", ")}`);

    const distance = Math.abs(daysBetween(movement.date, line.date));
    if (distance === 0) reasons.push("same day");
    else reasons.push(`${distance} day${distance === 1 ? "" : "s"} away`);

    let score = 0;
    if (amountMatches) score += 4;
    if (movement.direction === line.direction) score += 2;
    if (shared.length > 0) score += 3;
    score += Math.max(0, 3 - distance);

    out.push({
      journal_line_id: movement.line_id,
      entry_no: movement.entry_no,
      date: movement.date,
      description: movement.description,
      amount_bdt: movement.amount_bdt,
      amount_matches: amountMatches,
      reasons,
      score,
    });
  }

  return out.sort((a, b) => b.score - a.score || a.date.localeCompare(b.date)).slice(0, 8);
}

function shiftDay(date: string, days: number): string {
  const utc = new Date(`${date}T00:00:00Z`);
  utc.setUTCDate(utc.getUTCDate() + days);
  return utc.toISOString().slice(0, 10);
}

/* ── Decisions ───────────────────────────────────────────────────────────── */

async function loadLine(orgId: string, lineId: string) {
  assertObjectId(lineId, "That statement line does not exist.");
  const line = await StatementLineModel.findOne({ _id: lineId, org_id: orgId }).lean();
  if (!line) throw notFoundError("That statement line does not exist.");
  return line;
}

async function accountForLine(orgId: string, bankAccountId: unknown) {
  const account = await BankAccountModel.findOne({ _id: bankAccountId, org_id: orgId }).lean();
  if (!account) throw notFoundError("That bank account does not exist.");
  return account;
}

/**
 * Match a statement line to a journal line.
 *
 * An exact amount is *not* required. That is a deliberate choice: the honest way
 * to record "these two are the same transaction" when the amounts disagree is to
 * let the person say so and then show the resulting difference, rather than to
 * refuse and leave them no way to record what they know. The reconciliation's
 * unexplained figure is exactly the price of a match whose halves disagree, so a
 * wrong match cannot hide.
 *
 * The direction *is* checked, because it is not a judgement call: a bank debit
 * cannot be the same transaction as a ledger credit.
 */
export async function matchStatementLine(
  orgId: string,
  uid: string,
  lineId: string,
  journalLineId: string,
  ip?: string,
): Promise<StatementLineView> {
  const line = await loadLine(orgId, lineId);
  if (line.status === "CORRECTED") {
    throw new AppError(
      409,
      "ALREADY_CORRECTED",
      "This line already posted a correcting entry, so it cannot also be a match. Reverse the correction first.",
    );
  }
  const account = await accountForLine(orgId, line.bank_account_id);

  const entry = await journalLineById(orgId, journalLineId);
  if (!entry) throw notFoundError("That journal line does not exist.");
  if (entry.account_code !== account.account_code) {
    throw new AppError(
      422,
      "WRONG_ACCOUNT",
      `That journal line is on account ${entry.account_code}. This statement is for ${account.account_code} (${account.name}).`,
    );
  }
  if (entry.direction !== line.direction) {
    throw new AppError(
      422,
      "DIRECTION_MISMATCH",
      "That journal line moves money the other way. A bank debit cannot be the same transaction as a ledger credit.",
    );
  }

  const taken = await StatementLineModel.findOne({
    org_id: orgId,
    matched_line_id: journalLineId,
    _id: { $ne: line._id },
  }).lean();
  if (taken) {
    throw new AppError(
      409,
      "LINE_ALREADY_MATCHED",
      "That journal line is already matched to another statement line. Unmatch it there first.",
    );
  }

  const updated = await StatementLineModel.findOneAndUpdate(
    { _id: line._id, org_id: orgId },
    {
      $set: {
        status: "MATCHED",
        matched_line_id: entry.line_id,
        matched_entry_id: entry.entry_id,
        matched_entry_no: entry.entry_no ?? "",
        matched_amount_bdt: entry.amount_bdt,
        counter_account_code: "",
        note: "",
        resolved_by: uid,
        resolved_at: new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That statement line does not exist.");

  await writeAudit({
    orgId,
    uid,
    entity: "banking.statement_line",
    entityId: lineId,
    action: "STATEMENT_LINE_MATCHED",
    after: { entry_no: entry.entry_no, amount_bdt: entry.amount_bdt, direction: entry.direction },
    ...(ip ? { ip } : {}),
  });

  return lineView(updated);
}

/** Take a decision back. A line returns to UNMATCHED with nothing remembered. */
export async function unmatchStatementLine(
  orgId: string,
  uid: string,
  lineId: string,
  ip?: string,
): Promise<StatementLineView> {
  const line = await loadLine(orgId, lineId);
  if (line.status === "CORRECTED") {
    throw new AppError(
      409,
      "ALREADY_CORRECTED",
      "This line posted a correcting entry. Void that entry in the journal if it was wrong.",
    );
  }

  const updated = await StatementLineModel.findOneAndUpdate(
    { _id: line._id, org_id: orgId },
    {
      $set: {
        status: "UNMATCHED",
        matched_line_id: null,
        matched_entry_id: null,
        matched_entry_no: "",
        matched_amount_bdt: null,
        note: "",
        resolved_by: "",
        resolved_at: null,
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That statement line does not exist.");

  await writeAudit({
    orgId,
    uid,
    entity: "banking.statement_line",
    entityId: lineId,
    action: "STATEMENT_LINE_UNMATCHED",
    before: { status: line.status, entry_no: line.matched_entry_no ?? "" },
    after: { status: "UNMATCHED" },
    ...(ip ? { ip } : {}),
  });

  return lineView(updated);
}

export async function ignoreStatementLine(
  orgId: string,
  uid: string,
  lineId: string,
  note: string,
  ip?: string,
): Promise<StatementLineView> {
  const line = await loadLine(orgId, lineId);
  if (line.status === "CORRECTED") {
    throw new AppError(409, "ALREADY_CORRECTED", "This line already posted a correcting entry.");
  }

  const updated = await StatementLineModel.findOneAndUpdate(
    { _id: line._id, org_id: orgId },
    {
      $set: {
        status: "IGNORED",
        matched_line_id: null,
        matched_entry_id: null,
        matched_entry_no: "",
        matched_amount_bdt: null,
        note: note.trim(),
        resolved_by: uid,
        resolved_at: new Date(),
      },
    },
    { new: true },
  ).lean();
  if (!updated) throw notFoundError("That statement line does not exist.");

  await writeAudit({
    orgId,
    uid,
    entity: "banking.statement_line",
    entityId: lineId,
    action: "STATEMENT_LINE_IGNORED",
    after: { note: note.trim(), amount_bdt: line.amount_bdt, direction: line.direction },
    ...(ip ? { ip } : {}),
  });

  return lineView(updated);
}

/**
 * Post the entry this statement line proves is missing — a bank charge, an
 * interest credit, a fee nobody recorded.
 *
 * The counter account may not be another bank/cash account: money moving between
 * our own accounts is a **transfer**, which has its own document, its own number
 * and its own audit trail. Allowing a "correction" to do it would leave transfer-
 * shaped movements with no transfer to point at.
 */
export async function correctStatementLine(
  orgId: string,
  uid: string,
  lineId: string,
  counterAccountCode: string,
  memo: string,
  ip?: string,
): Promise<StatementLineView> {
  const line = await loadLine(orgId, lineId);
  if (line.status === "CORRECTED") {
    throw new AppError(409, "ALREADY_CORRECTED", "This line has already been corrected.");
  }
  if (line.status === "MATCHED") {
    throw new AppError(
      409,
      "UNMATCH_FIRST",
      "This line is matched to an entry the books already have, so there is nothing missing to post. Unmatch it first if the match was wrong.",
    );
  }
  const account = await accountForLine(orgId, line.bank_account_id);

  const counter = await requireAccountByCode(orgId, counterAccountCode);
  if (counter.code === account.account_code) {
    throw new AppError(422, "SAME_ACCOUNT", "The other side of a correction cannot be the bank account itself.");
  }
  const treasury = await BankAccountModel.findOne({ org_id: orgId, account_code: counter.code }).lean();
  if (treasury) {
    throw new AppError(
      422,
      "USE_TRANSFER_INSTEAD",
      `${counter.code} (${counter.name}) is one of your own bank or cash accounts. Money moving between your accounts is a transfer — record it as one.`,
    );
  }

  const description = `Bank ${line.direction === "IN" ? "credit" : "charge"} — ${(line.description || line.reference || "unidentified").slice(0, 200)}`;
  const lines =
    line.direction === "OUT"
      ? [
          { account_code: counter.code, debit_bdt: line.amount_bdt, memo: memo || description },
          { account_code: account.account_code, credit_bdt: line.amount_bdt, memo: description },
        ]
      : [
          { account_code: account.account_code, debit_bdt: line.amount_bdt, memo: description },
          { account_code: counter.code, credit_bdt: line.amount_bdt, memo: memo || description },
        ];

  return inTransaction(async (session) => {
    const entry = await postJournal(
      {
        orgId,
        uid,
        date: line.date,
        description,
        source: "BANK_CORRECTION",
        source_id: lineId,
        lines,
        ...(ip ? { ip } : {}),
      },
      session,
    );

    const updated = await StatementLineModel.findOneAndUpdate(
      { _id: line._id, org_id: orgId, status: { $ne: "CORRECTED" } },
      {
        $set: {
          status: "CORRECTED",
          adjustment_entry_id: entry.id,
          counter_account_code: counter.code,
          matched_line_id: null,
          matched_entry_id: null,
          matched_entry_no: "",
          matched_amount_bdt: null,
          note: memo.trim(),
          resolved_by: uid,
          resolved_at: new Date(),
        },
      },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "ALREADY_CORRECTED", "This line was corrected by another request a moment ago.");
    }

    await writeAudit(
      {
        orgId,
        uid,
        entity: "banking.statement_line",
        entityId: lineId,
        action: "STATEMENT_LINE_CORRECTED",
        after: {
          counter_account_code: counter.code,
          amount_bdt: line.amount_bdt,
          direction: line.direction,
          entry_no: entry.entry_no,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return lineView(updated);
  });
}
