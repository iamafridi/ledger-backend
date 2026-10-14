/**
 * Phase 6 smoke — banking & cash, run in-process against the real app and the
 * real database on a throwaway org, which is deleted at the end.
 *
 *   npx tsx scripts/smoke-p6.ts
 *
 * The point of this script is the phase's exit gate: on a seeded fixture,
 * reconciliation must show book against bank with **zero unexplained
 * difference**. Everything else here exists to make that number mean something —
 * a controlled wrong match has to push it off zero, and undoing the mistake has
 * to bring it back, or the figure is decoration.
 *
 * Exit 0 = every check passed.
 */
// Must be first: pins the JWKS URL before any src module (and its cached
// environment) can load.
import "./smoke-p6-env.js";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import request from "supertest";
import { SignJWT, exportJWK } from "jose";

import { createApp } from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { getEnvironment } from "../src/config/env.js";
import { OrgMembershipModel, OrganizationModel } from "../src/modules/org/org.model.js";
import { CoaAccountModel } from "../src/modules/coa/coa.model.js";
import { JournalEntryModel, JournalLineModel } from "../src/modules/journals/journal.model.js";
import { PeriodModel } from "../src/modules/periods/period.model.js";
import { SequenceCounterModel } from "../src/modules/sequence/sequence.model.js";
import {
  BankAccountModel,
  StatementImportModel,
  StatementLineModel,
  TransferModel,
} from "../src/modules/banking/banking.model.js";
import { AuditLogModel } from "../src/core/audit.js";
import { runIntegrityChecks } from "../src/core/integrity.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    failures.push(label + (detail ? ` — ${detail}` : ""));
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const app = createApp();

/* ── Token minting (same recipe as the Phase 5 smoke) ────────────────────── */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_PORT = 4572;
const CACHED_JWK: Record<string, unknown> = {};
const jwksServer = createServer((_request, response) => {
  const jwk = { ...CACHED_JWK, kid: "smoke-key", alg: "RS256", use: "sig" };
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
});

let authorization = "";

async function mintToken(uid: string, projectId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "smoke-key" })
    .setSubject(uid)
    .setIssuedAt()
    .setExpirationTime("1h")
    .setIssuer(`https://securetoken.google.com/${projectId}`)
    .setAudience(projectId)
    .sign(privateKey);
}

/* ── The statement fixture ───────────────────────────────────────────────── */

/**
 * A bank statement that requires every decision the phase supports:
 *   - one line the books already have (the transfer in)      → MATCH
 *   - one line the books already have (the cheque)           → MATCH
 *   - two lines the books do not have (settlement and fee)   → CORRECT
 * plus a matching book deposit the statement has not seen yet, which is the
 * item in transit a reconciled period legitimately still has.
 *
 * The running balance chains exactly (0 → 2000 → 3500 → 3475 → 2675), so the
 * "balance does not follow" warning stays silent and can be tested separately.
 */
const STATEMENT_CSV = [
  "Date,Description,Reference,Withdrawal,Deposit,Balance",
  '05/09/2026,Transfer from cash,TRF-2026-01,,"2000.00","2000.00"',
  '12/09/2026,Card settlement,CARD-77,,"1500.00","3500.00"',
  '15/09/2026,Monthly account fee,FEE-SEP,"25.00",,"3475.00"',
  '20/09/2026,Cheque 100245,CHQ-100245,"800.00",,"2675.00"',
  "",
].join("\n");

const get = (path: string) => request(app).get(path).set("authorization", authorization);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (path: string, body: any) =>
  request(app).post(path).set("authorization", authorization).send(body);

async function main(): Promise<void> {
  Object.assign(CACHED_JWK, await exportJWK(publicKey));
  await new Promise<void>((resolve) => jwksServer.listen(JWKS_PORT, resolve));

  const environment = getEnvironment();
  await connectDatabase();
  console.log("Phase 6 smoke — banking, transfers, statements & reconciliation\n");

  const uid = `smoke-p6-${Date.now()}`;
  authorization = `Bearer ${await mintToken(uid, environment.FIREBASE_PROJECT_ID)}`;

  const first = await get("/api/v1/auth/me");
  const orgId = first.body.data?.org as string;
  check("signup bootstraps an org with OWNER context", first.status === 200 && Boolean(orgId));
  check(
    "fresh role grants banking.read and banking.write",
    first.body.data.permissions.includes("banking.read") &&
      first.body.data.permissions.includes("banking.write"),
  );

  try {
    /* ── Bootstrap: two accounts out of the box ─────────────────────────── */
    const accounts0 = (await get("/api/v1/banking/accounts")).body.data.accounts as Array<{
      id: string;
      kind: string;
      name: string;
      account_code: string;
      book_balance_bdt: string;
      unreconciled_count: number;
    }>;
    check("bootstrap maps the cash account (1000)", accounts0.some((a) => a.account_code === "1000" && a.kind === "CASH"));
    check("bootstrap maps the bank account (1010)", accounts0.some((a) => a.account_code === "1010" && a.kind === "BANK"));
    check("a fresh org starts at zero", accounts0.every((a) => a.book_balance_bdt === "0.00"));
    check("a fresh org has nothing to reconcile", accounts0.every((a) => a.unreconciled_count === 0));

    const position0 = (await get("/api/v1/banking/position")).body.data;
    check("cash position starts at 0.00", position0.total_bdt === "0.00", position0.total_bdt);
    check("position agrees with the chart's own cash/bank accounts", position0.total_bdt === position0.ledger_total_bdt);

    const cash = accounts0.find((a) => a.account_code === "1000")!;
    const bank = accounts0.find((a) => a.account_code === "1010")!;

    /* ── Mapping rules ──────────────────────────────────────────────────── */
    const savings = (await post("/api/v1/coa", {
      code: "1020",
      name: "City Bank — Savings",
      type: "ASSET",
      subtype: "BANK",
      normal_balance: "DEBIT",
    })).body.data.account;
    check("a second asset account can be added to the chart", Boolean(savings?.id));

    const mapped = await post("/api/v1/banking/accounts", {
      kind: "BANK",
      name: "City Bank — Savings",
      account_code: "1020",
      bank_name: "City Bank",
      account_number: "1234567890",
    });
    check("an asset account can be mapped to a treasury account", mapped.status === 201, JSON.stringify(mapped.body).slice(0, 200));

    const dupe = await post("/api/v1/banking/accounts", { name: "Again", account_code: "1020" });
    check("mapping the same chart account twice is refused (409)", dupe.status === 409 && dupe.body.error.code === "ACCOUNT_ALREADY_MAPPED", `status ${dupe.status}`);

    const revenue = await post("/api/v1/banking/accounts", { name: "Nonsense", account_code: "4000" });
    check("a revenue account cannot be a bank account (422 ACCOUNT_NOT_ASSET)", revenue.status === 422 && revenue.body.error.code === "ACCOUNT_NOT_ASSET", JSON.stringify(revenue.body.error));

    const receivable = await post("/api/v1/banking/accounts", { name: "Nonsense", account_code: "1100" });
    check("the AR control account cannot be a bank account (422 ACCOUNT_NOT_TREASURY)", receivable.status === 422 && receivable.body.error.code === "ACCOUNT_NOT_TREASURY", JSON.stringify(receivable.body.error));

    /* ── Opening balance and one transfer ───────────────────────────────── */
    const opening = await post("/api/v1/periods/opening-balances", {
      date: "2026-07-01",
      description: "Smoke opening",
      lines: [
        { account_code: "1000", debit_bdt: "5000.00" },
        { account_code: "3000", credit_bdt: "5000.00" },
      ],
    });
    check("opening balances posted", opening.status === 201, JSON.stringify(opening.body).slice(0, 200));

    const cashAfterOpening = (await get(`/api/v1/banking/accounts/${cash.id}`)).body.data.account;
    check("the book balance is read from the ledger (5000.00)", cashAfterOpening.book_balance_bdt === "5000.00", cashAfterOpening.book_balance_bdt);

    const transfer = (await post("/api/v1/banking/transfers", {
      from_account_id: cash.id,
      to_account_id: bank.id,
      date: "2026-09-05",
      amount_bdt: "2000.00",
      memo: "Move cash to the bank",
    })).body.data.transfer as { id: string; doc_no: string; journal_entry_id: string; status: string };
    check("a transfer posts", Boolean(transfer?.id) && transfer.status === "POSTED");
    check("the transfer claims its own number (2026-01)", transfer.doc_no === "2026-01", transfer.doc_no);

    const entry = (await get(`/api/v1/journals/${transfer.journal_entry_id}`)).body.data.entry;
    const debitTotal = entry.lines.reduce((acc: number, line: { debit_bdt: string }) => acc + Number(line.debit_bdt), 0);
    const creditTotal = entry.lines.reduce((acc: number, line: { credit_bdt: string }) => acc + Number(line.credit_bdt), 0);
    check(
      "the transfer is one balanced entry",
      entry.lines.length === 2 && Math.abs(debitTotal - creditTotal) < 0.005 && debitTotal === 2000,
      `${entry.lines.length} lines, debits ${debitTotal}, credits ${creditTotal}`,
    );
    check(
      "the entry debits the destination and credits the source",
      entry.lines.some((line: { account_code: string; debit_bdt: string }) => line.account_code === "1010" && line.debit_bdt === "2000.00") &&
        entry.lines.some((line: { account_code: string; credit_bdt: string }) => line.account_code === "1000" && line.credit_bdt === "2000.00"),
      JSON.stringify(entry.lines),
    );

    const sameAccount = await post("/api/v1/banking/transfers", {
      from_account_id: cash.id,
      to_account_id: cash.id,
      date: "2026-09-05",
      amount_bdt: "10.00",
    });
    check("a transfer to the same account is refused (422 SAME_ACCOUNT)", sameAccount.status === 422 && sameAccount.body.error.code === "SAME_ACCOUNT");

    const badFee = await post("/api/v1/banking/transfers", {
      from_account_id: cash.id,
      to_account_id: bank.id,
      date: "2026-09-05",
      amount_bdt: "10.00",
      fee_bdt: "1.00",
      fee_account_code: "1000",
    });
    check("a fee must land in an expense account (422 ACCOUNT_NOT_EXPENSE)", badFee.status === 422 && badFee.body.error.code === "ACCOUNT_NOT_EXPENSE");

    const afterTransfer = (await get("/api/v1/banking/position")).body.data;
    check("the transfer moved money, not totals (cash 3000.00)", afterTransfer.accounts.find((a: { account_code: string }) => a.account_code === "1000").book_balance_bdt === "3000.00");
    check("the destination received it (bank 2000.00)", afterTransfer.accounts.find((a: { account_code: string }) => a.account_code === "1010").book_balance_bdt === "2000.00");
    check("the position total is unchanged by a transfer (5000.00)", afterTransfer.total_bdt === "5000.00", afterTransfer.total_bdt);

    /* ── The cheque and the deposit nobody has banked yet ───────────────── */
    const cheque = await post("/api/v1/journals", {
      date: "2026-09-18",
      description: "Cheque 100245 — September rent",
      lines: [
        { account_code: "5200", debit_bdt: "800.00" },
        { account_code: "1010", credit_bdt: "800.00" },
      ],
    });
    check("a cheque written is in the books before it clears", cheque.status === 201, JSON.stringify(cheque.body).slice(0, 200));

    const deposit = await post("/api/v1/journals", {
      date: "2026-09-29",
      description: "Cash sale banked (not yet on the statement)",
      lines: [
        { account_code: "1010", debit_bdt: "300.00" },
        { account_code: "4000", credit_bdt: "300.00" },
      ],
    });
    check("a deposit in transit is in the books only", deposit.status === 201);

    /* ── Import the statement ───────────────────────────────────────────── */
    const imported = await post(`/api/v1/banking/accounts/${bank.id}/statements`, {
      filename: "city-bank-sept.csv",
      csv: STATEMENT_CSV,
    });
    const importedData = imported.body.data;
    check("the statement imports (4 data rows)", imported.status === 201 && importedData.import.imported_count === 4, JSON.stringify(imported.body).slice(0, 300));
    check("no rows were skipped as duplicates", importedData.duplicates === 0);
    check("the file's own balances chain, so no warning is raised", importedData.warnings.length === 0, JSON.stringify(importedData.warnings));
    check("the import records the period it covers", importedData.import.period_from === "2026-09-05" && importedData.import.period_to === "2026-09-20");
    check("the statement's opening is read from its own running balance (0.00)", importedData.import.opening_balance_bdt === "0.00", importedData.import.opening_balance_bdt);
    check("the statement's closing balance is captured (2675.00)", importedData.import.closing_balance_bdt === "2675.00", importedData.import.closing_balance_bdt);
    check("the account list now shows what the bank says", (await get(`/api/v1/banking/accounts/${bank.id}`)).body.data.account.last_statement_balance_bdt === "2675.00");

    const unopened = (await get(`/api/v1/banking/accounts/${bank.id}/reconciliation`)).body.data;
    check("nothing is matched yet, so 4 statement lines are undecided", unopened.summary.unrecorded_bank_count === 4, JSON.stringify(unopened.summary));
    check("the undecided lines are worth 2675.00", unopened.summary.unrecorded_bank_bdt === "2675.00", unopened.summary.unrecorded_bank_bdt);
    check("every book movement is unmatched too, worth 1500.00", unopened.summary.outstanding_book_bdt === "1500.00" && unopened.summary.outstanding_book_count === 3, `${unopened.summary.outstanding_book_bdt} / ${unopened.summary.outstanding_book_count}`);
    check("the books say 1500.00 and the statement says 2675.00", unopened.summary.book_closing_bdt === "1500.00" && unopened.summary.bank_closing_bdt === "2675.00");
    check("the raw gap is shown (-1175.00)", unopened.summary.difference_bdt === "-1175.00", unopened.summary.difference_bdt);
    // Nothing is paired yet, so there is no pairing to disagree about — which is
    // why the two conditions are separate: zero unexplained *and* nothing
    // undecided. This asserts the first half stays honest on its own.
    check("undecided lines alone leave the period unreconciled", unopened.summary.unexplained_bdt === "0.00" && unopened.summary.reconciled === false);
    check("the window defaults to the month the statement covers", unopened.summary.from === "2026-09-01" && unopened.summary.to === "2026-09-30", `${unopened.summary.from} → ${unopened.summary.to}`);
    check("the opening basis is named as coming from the statement", unopened.summary.opening_basis === "statement");

    /* ── Match, ignore, correct ─────────────────────────────────────────── */
    const byAmount = (rows: Array<{ date: string; amount_bdt: string; direction: string; line_id: string }>, date: string, amount: string) =>
      rows.find((row) => row.date === date && row.amount_bdt === amount);

    const movements = unopened.book_movements as Array<{ date: string; amount_bdt: string; direction: string; line_id: string }>;
    const transferLine = byAmount(movements, "2026-09-05", "2000.00")!;
    const chequeLine = byAmount(movements, "2026-09-18", "800.00")!;
    const depositLine = byAmount(movements, "2026-09-29", "300.00")!;
    check("the workspace lists every book movement in the month", movements.length === 3, `${movements.length} movements`);

    const lineFor = (date: string, amount: string) =>
      (unopened.statement_lines as Array<{ id: string; date: string; amount_bdt: string; status: string }>).find(
        (line) => line.date === date && line.amount_bdt === amount,
      )!;

    const transferLineStmt = lineFor("2026-09-05", "2000.00");
    const settlementStmt = lineFor("2026-09-12", "1500.00");
    const feeStmt = lineFor("2026-09-15", "25.00");
    const chequeStmt = lineFor("2026-09-20", "800.00");

    check("suggestions are offered for an unmatched line", ((unopened.statement_lines as Array<{ suggestions: unknown[] }>)[0]?.suggestions ?? []).length > 0);

    const match1 = await post(`/api/v1/banking/statement-lines/${transferLineStmt.id}/match`, { journal_line_id: transferLine.line_id });
    check("the transfer is matched to the statement line", match1.status === 200 && match1.body.data.line.status === "MATCHED", JSON.stringify(match1.body).slice(0, 200));
    check("matching reports the entry number it matched", match1.body.data.line.matched_entry_no?.startsWith("2026-") === true, match1.body.data.line.matched_entry_no);

    const doublePost = await post(`/api/v1/banking/statement-lines/${transferLineStmt.id}/correct`, {
      counter_account_code: "5500",
    });
    check("a matched line cannot also post a correction (409 UNMATCH_FIRST)", doublePost.status === 409 && doublePost.body.error.code === "UNMATCH_FIRST", JSON.stringify(doublePost.body.error));

    const match2 = await post(`/api/v1/banking/statement-lines/${chequeStmt.id}/match`, { journal_line_id: chequeLine.line_id });
    check("the cheque is matched to the line the bank cleared", match2.status === 200 && match2.body.data.line.status === "MATCHED");

    const corrected = await post(`/api/v1/banking/statement-lines/${settlementStmt.id}/correct`, {
      counter_account_code: "4100",
      memo: "Card settlement — not previously recorded",
    });
    check("a card settlement the books lacked posts a correction", corrected.status === 200 && corrected.body.data.line.status === "CORRECTED");
    check("the correction names the account it posted to", corrected.body.data.line.counter_account_code === "4100");

    const feeCorrected = await post(`/api/v1/banking/statement-lines/${feeStmt.id}/correct`, {
      counter_account_code: "5500",
      memo: "Monthly account fee",
    });
    check("the bank fee posts to Bank Charges", feeCorrected.status === 200 && feeCorrected.body.data.line.status === "CORRECTED");

    const doubleCorrect = await post(`/api/v1/banking/statement-lines/${feeStmt.id}/correct`, {
      counter_account_code: "5500",
    });
    check("a line cannot be corrected twice (409 ALREADY_CORRECTED)", doubleCorrect.status === 409, `status ${doubleCorrect.status}`);

    /* ── The exit gate ──────────────────────────────────────────────────── */
    const reconciled = (await get(`/api/v1/banking/accounts/${bank.id}/reconciliation`)).body.data;
    const summary = reconciled.summary;
    check("book closing reflects the corrections (2975.00)", summary.book_closing_bdt === "2975.00", summary.book_closing_bdt);
    check("bank closing is the statement's own figure (2675.00)", summary.bank_closing_bdt === "2675.00", summary.bank_closing_bdt);
    check("the raw difference is the item in transit (300.00)", summary.difference_bdt === "300.00", summary.difference_bdt);
    check("the item in transit is named, not hidden (300.00 / 1 item)", summary.outstanding_book_bdt === "300.00" && summary.outstanding_book_count === 1);
    check("no statement line is left undecided", summary.unrecorded_bank_count === 0 && summary.unrecorded_bank_bdt === "0.00");
    check("nothing is carried in from before the period", summary.opening_difference_bdt === "0.00", summary.opening_difference_bdt);
    check("EXIT GATE: zero unexplained difference", summary.unexplained_bdt === "0.00", summary.unexplained_bdt);
    check("the period is reported as reconciled", summary.reconciled === true);
    check("two pairs matched and two corrections posted", summary.matched_count === 2 && summary.corrected_count === 2 && summary.ignored_count === 0);
    check("both sides of the matched pairs agree (1200.00 each)", summary.matched_book_bdt === "1200.00" && summary.matched_statement_bdt === "1200.00", `${summary.matched_book_bdt} vs ${summary.matched_statement_bdt}`);
    check("the corrections net to 1475.00", summary.corrected_bdt === "1475.00", summary.corrected_bdt);

    /* ── A wrong match must show, and undoing it must restore ───────────── */
    await post(`/api/v1/banking/statement-lines/${transferLineStmt.id}/unmatch`, {});
    const afterUnmatch = (await get(`/api/v1/banking/accounts/${bank.id}/reconciliation`)).body.data.summary;
    check(
      "unmatching a correct pair leaves nothing unexplained but reopens the line",
      afterUnmatch.unexplained_bdt === "0.00" && afterUnmatch.unrecorded_bank_count === 1 && afterUnmatch.reconciled === false,
      `${afterUnmatch.unexplained_bdt} / ${afterUnmatch.unrecorded_bank_count} undecided`,
    );

    const wrong = await post(`/api/v1/banking/statement-lines/${transferLineStmt.id}/match`, { journal_line_id: depositLine.line_id });
    check("matching two different amounts is allowed (the person may know better)", wrong.status === 200, `status ${wrong.status}`);
    const afterWrong = (await get(`/api/v1/banking/accounts/${bank.id}/reconciliation`)).body.data.summary;
    check("a wrong match is visible as unexplained (-1700.00)", afterWrong.unexplained_bdt === "-1700.00" && afterWrong.reconciled === false, afterWrong.unexplained_bdt);

    const direction = await post(`/api/v1/banking/statement-lines/${transferLineStmt.id}/match`, { journal_line_id: chequeLine.line_id });
    check("a line cannot be matched to the other direction (422 DIRECTION_MISMATCH)", direction.status === 422 && direction.body.error.code === "DIRECTION_MISMATCH", JSON.stringify(direction.body.error));

    await post(`/api/v1/banking/statement-lines/${transferLineStmt.id}/unmatch`, {});
    const restored = await post(`/api/v1/banking/statement-lines/${transferLineStmt.id}/match`, { journal_line_id: transferLine.line_id });
    check("re-matching correctly restores zero unexplained", restored.body.data.summary.unexplained_bdt === "0.00", restored.body.data.summary.unexplained_bdt);

    const taken = await post(`/api/v1/banking/statement-lines/${chequeStmt.id}/unmatch`, {});
    check("a matched line can be unmatched", taken.body.data.line.status === "UNMATCHED");

    /* ── Re-uploading the same file ─────────────────────────────────────── */
    const again = await post(`/api/v1/banking/accounts/${bank.id}/statements`, {
      filename: "city-bank-sept.csv",
      csv: STATEMENT_CSV,
    });
    check("re-importing the same file adds nothing (4 skipped)", again.status === 201 && again.body.data.import.imported_count === 0 && again.body.data.duplicates === 4, JSON.stringify(again.body.data.import));

    /* ── Files that cannot be read are refused, not half-imported ───────── */
    const badDate = await post(`/api/v1/banking/accounts/${bank.id}/statements`, {
      csv: "Date,Description,Amount\n31/13/2026,Nonsense,100.00\n",
    });
    check("an unreadable date refuses the whole file (422)", badDate.status === 422 && badDate.body.error.code === "STATEMENT_PARSE_FAILED", JSON.stringify(badDate.body.error));

    const noAmount = await post(`/api/v1/banking/accounts/${bank.id}/statements`, {
      csv: "Date,Description\n01/09/2026,Nonsense\n",
    });
    check("a file with no amount column is refused (422)", noAmount.status === 422 && noAmount.body.error.code === "STATEMENT_PARSE_FAILED");

    const broken = await post(`/api/v1/banking/accounts/${bank.id}/statements`, {
      csv: 'Date,Description,Amount,Balance\n01/09/2026,One,100.00,"100.00"\n02/09/2026,Two,50.00,"999.00"\n',
    });
    check("a running balance that does not chain imports with a warning", broken.status === 201 && broken.body.data.warnings.length === 1, JSON.stringify(broken.body.data?.warnings));

    /* ── One journal line, one statement line ───────────────────────────── */
    const extra = await post(`/api/v1/banking/accounts/${bank.id}/statements`, {
      csv: 'Date,Description,Reference,Deposit,Balance\n05/09/2026,Transfer again,TRF-2026-01B,"2000.00","2000.00"\n',
    });
    const extraLine = extra.body.data.lines[0] as { id: string };
    check("a line with a different reference is not treated as a duplicate", extra.status === 201 && extra.body.data.import.imported_count === 1);

    const alreadyMatched = await post(`/api/v1/banking/statement-lines/${extraLine.id}/match`, { journal_line_id: transferLine.line_id });
    check("one journal line cannot back two statement lines (409 LINE_ALREADY_MATCHED)", alreadyMatched.status === 409 && alreadyMatched.body.error.code === "LINE_ALREADY_MATCHED", JSON.stringify(alreadyMatched.body.error));

    // The cash side of the transfer is a real journal line — on the wrong account
    // for this statement, which is exactly what the guard is for.
    const cashSide = entry.lines.find((line: { account_code: string }) => line.account_code === "1000");
    const wrongAccount = await post(`/api/v1/banking/statement-lines/${extraLine.id}/match`, {
      journal_line_id: cashSide.id,
    });
    check("a line from another account cannot be matched (422 WRONG_ACCOUNT)", wrongAccount.status === 422 && wrongAccount.body.error.code === "WRONG_ACCOUNT", JSON.stringify(wrongAccount.body.error));

    const treasuryCorrection = await post(`/api/v1/banking/statement-lines/${extraLine.id}/correct`, {
      counter_account_code: "1000",
    });
    check("a correction cannot post to another treasury account (422 USE_TRANSFER_INSTEAD)", treasuryCorrection.status === 422 && treasuryCorrection.body.error.code === "USE_TRANSFER_INSTEAD", JSON.stringify(treasuryCorrection.body.error));

    /* ── A fee is part of the same entry ───────────────────────────────── */
    const feeTransfer = (await post("/api/v1/banking/transfers", {
      from_account_id: bank.id,
      to_account_id: cash.id,
      date: "2026-10-02",
      amount_bdt: "100.00",
      fee_bdt: "10.00",
      memo: "October sweep, with a wire fee",
    })).body.data.transfer as { id: string; journal_entry_id: string; fee_bdt: string };
    check("a transfer with a fee is accepted", feeTransfer?.fee_bdt === "10.00");
    const feeEntry = (await get(`/api/v1/journals/${feeTransfer.journal_entry_id}`)).body.data.entry;
    check(
      "the fee is a line of the same balanced entry (3 lines, 110.00 credit)",
      feeEntry.lines.length === 3 &&
        feeEntry.lines.some((line: { account_code: string; credit_bdt: string }) => line.account_code === "1010" && line.credit_bdt === "110.00") &&
        feeEntry.lines.some((line: { account_code: string; debit_bdt: string }) => line.account_code === "5500" && line.debit_bdt === "10.00"),
      JSON.stringify(feeEntry.lines),
    );

    const bankBeforeVoid = (await get(`/api/v1/banking/accounts/${bank.id}`)).body.data.account.book_balance_bdt;
    const voided = await post(`/api/v1/banking/transfers/${feeTransfer.id}/void`, { reason: "Wrong account chosen" });
    check("a transfer can be voided with a reason", voided.status === 200 && voided.body.data.transfer.status === "VOID");
    check("voiding writes a reversal, so the accounts return to where they were", (await get(`/api/v1/banking/accounts/${bank.id}`)).body.data.account.book_balance_bdt === "2975.00", `was ${bankBeforeVoid}`);
    const doubleVoid = await post(`/api/v1/banking/transfers/${feeTransfer.id}/void`, { reason: "Again" });
    check("a transfer cannot be voided twice (409)", doubleVoid.status === 409);

    /* ── The treasury total is the chart's own total ────────────────────── */
    const position = (await get("/api/v1/banking/position")).body.data;
    const cashReport = (await get("/api/v1/reports/cash-position")).body.data;
    const reportTotal = cashReport.rows
      .filter((row: { name: string }) => row.name === "Total cash and bank")
      .reduce((acc: number, row: { value_bdt: string }) => acc + Number(row.value_bdt), 0);
    check("the banking position equals the cash-position report", Math.abs(Number(position.total_bdt) - reportTotal) < 0.005, `banking ${position.total_bdt}, report ${reportTotal.toFixed(2)}`);
    check("the treasury mapping covers every cash/bank chart account", position.total_bdt === position.ledger_total_bdt, `${position.total_bdt} vs ${position.ledger_total_bdt}`);

    /* ── Permissions ───────────────────────────────────────────────────── */
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "VIEWER" } });
    check("a VIEWER may read the cash position", (await get("/api/v1/banking/position")).status === 200);
    const viewerWrite = await post("/api/v1/banking/transfers", {
      from_account_id: cash.id,
      to_account_id: bank.id,
      date: "2026-09-05",
      amount_bdt: "1.00",
    });
    check("a VIEWER cannot move money (403)", viewerWrite.status === 403, `status ${viewerWrite.status}`);
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "OWNER" } });

    /* ── Integrity, with the new checks live on populated data ─────────── */
    const report = await runIntegrityChecks();
    const mapping = report.checks.find((row) => row.id === "P6-BANK-MAPPING");
    const inLedger = report.checks.find((row) => row.id === "P6-BANK-IN-LEDGER");
    check("P6-BANK-MAPPING passes on real data", mapping?.status === "pass", `${mapping?.status}: ${mapping?.findings.join("; ")}`);
    check("P6-BANK-IN-LEDGER passes on real data", inLedger?.status === "pass", `${inLedger?.status}: ${inLedger?.findings.join("; ")}`);
    check("no integrity check fails", report.checks.every((row) => row.status !== "fail"), report.checks.filter((row) => row.status === "fail").map((row) => row.id).join(", "));
  } catch (error) {
    // The summary below must not hide why the run stopped short.
    failed += 1;
    failures.push(`run aborted: ${error instanceof Error ? error.stack : String(error)}`);
    console.log(`\n  ABORT ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    cleanupAndReport(orgId);
  }
}

/** Cleanup, split out so the finally block stays readable. */
function cleanupAndReport(orgId: string): void {
  void (async () => {
    try {
    const org = await OrganizationModel.findById(orgId).lean().catch(() => null);
    if (org) {
      const { default: mongoose } = await import("mongoose");
      const id = new mongoose.Types.ObjectId(orgId);
      await Promise.all([
        BankAccountModel.deleteMany({ org_id: id }),
        TransferModel.deleteMany({ org_id: id }),
        StatementImportModel.deleteMany({ org_id: id }),
        StatementLineModel.deleteMany({ org_id: id }),
        JournalEntryModel.deleteMany({ org_id: id }),
        JournalLineModel.deleteMany({ org_id: id }),
        CoaAccountModel.deleteMany({ org_id: id }),
        PeriodModel.deleteMany({ org_id: id }),
        SequenceCounterModel.deleteMany({ org_id: id }),
        OrgMembershipModel.deleteMany({ org_id: id }),
        AuditLogModel.collection.deleteMany({ org_id: id }),
      ]);
      await OrganizationModel.deleteOne({ _id: id });
    }
    } catch (error) {
      console.error("cleanup failed:", error);
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log("Failures:");
      for (const failure of failures) console.log(`  - ${failure}`);
    }
    await disconnectDatabase();
    process.exit(failed === 0 ? 0 : 1);
  })();
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
