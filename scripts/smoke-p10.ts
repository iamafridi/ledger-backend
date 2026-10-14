/**
 * Phase 10 smoke — the advance engine and credit control, run in-process against
 * the real app and the real database on a throwaway org, which is deleted at the
 * end.
 *
 *   npx tsx scripts/smoke-p10.ts
 *
 * The point of this script is the phase's exit gate: **Σ advances − Σ adjustments
 * ≥ 0 per party at every commit**, exercised through the ADR 0004 critical
 * scenario — a 50,000.00 advance claimed 20,000.00 at issue and 15,000.00 by
 * hand, the first document cancelled to restore 35,000.00, and a 40,000.00
 * adjustment then refused with the ADR's verbatim message — plus concurrent
 * claims that cannot overdraw, double reversal as a no-op, receipt remainders
 * parking as advances, and the supplier prepayment mirror.
 *
 * Every figure below is hand-checkable, and the arithmetic is in the comments.
 *
 * Exit 0 = every check passed.
 */
// Must be first: pins the JWKS URL before any src module (and its cached
// environment) can load.
import "./smoke-p10-env.js";
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
import { PartyModel } from "../src/modules/masterdata/parties.model.js";
import { ItemModel } from "../src/modules/masterdata/items.model.js";
import { MasterCategoryModel, TaxRateModel, UnitModel } from "../src/modules/masterdata/catalogs.model.js";
import { OrgSettingsModel } from "../src/modules/settings/org-settings.model.js";
import {
  BillLineModel,
  BillModel,
  DebitNoteModel,
  PaymentAllocationModel,
  PaymentModel,
} from "../src/modules/purchases/purchases.model.js";
import {
  CreditNoteModel,
  InvoiceLineModel,
  InvoiceModel,
  ReceiptAllocationModel,
  ReceiptModel,
} from "../src/modules/sales/sales.model.js";
import {
  BankAccountModel,
  StatementImportModel,
  StatementLineModel,
  TransferModel,
} from "../src/modules/banking/banking.model.js";
import { TaxCertificateModel, TaxChallanModel } from "../src/modules/tax/tax.model.js";
import {
  StockBalanceModel,
  StockMovementModel,
  StocktakeModel,
  WarehouseModel,
} from "../src/modules/inventory/inventory.model.js";
import { DepreciationRunModel, FixedAssetModel } from "../src/modules/fixed-assets/assets.model.js";
import { AdvanceAdjustmentModel, AdvanceModel } from "../src/modules/advances/advances.model.js";
import { AuditLogModel } from "../src/core/audit.js";
import { runIntegrityChecks } from "../src/core/integrity.js";
import { fmt, money } from "../src/core/money.js";

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

/* ── Token minting (the same recipe as the Phase 5–9 smokes) ─────────────── */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_PORT = 4576;
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

const get = (path: string) => request(app).get(path).set("authorization", authorization);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (path: string, body: any) =>
  request(app).post(path).set("authorization", authorization).send(body);

interface PostedLine {
  account_code: string;
  debit_bdt: string;
  credit_bdt: string;
}

async function entryLines(entryId: string): Promise<PostedLine[]> {
  return (await get(`/api/v1/journals/${entryId}`)).body.data.entry.lines as PostedLine[];
}

const hasLine = (lines: PostedLine[], code: string, side: "debit" | "credit", amount: string): boolean =>
  lines.some(
    (line) => line.account_code === code && line[side === "debit" ? "debit_bdt" : "credit_bdt"] === amount,
  );

interface AdvanceRow {
  id: string;
  status: string;
  amount_bdt: string;
  adjusted_bdt: string;
  outstanding_bdt: string;
  source: string;
  reference: string;
  journal_entry_id: string | null;
  adjustments?: { amount_bdt: string; document_type: string; document_no: string }[];
}

interface InvoiceRow {
  id: string;
  doc_no: string | null;
  status: string;
  total_bdt: string;
  paid_bdt: string;
  outstanding_bdt: string;
}

interface BillRow {
  id: string;
  doc_no: string | null;
  status: string;
  total_bdt: string;
  paid_bdt: string;
  outstanding_bdt: string;
}

async function invoiceById(id: string): Promise<InvoiceRow> {
  return (await get(`/api/v1/sales/invoices/${id}`)).body.data.invoice as InvoiceRow;
}

async function billById(id: string): Promise<BillRow> {
  return (await get(`/api/v1/purchases/bills/${id}`)).body.data.bill as BillRow;
}

async function main(): Promise<void> {
  Object.assign(CACHED_JWK, await exportJWK(publicKey));
  await new Promise<void>((resolve) => jwksServer.listen(JWKS_PORT, resolve));

  const environment = getEnvironment();
  await connectDatabase();
  console.log("Phase 10 smoke — the advance engine and credit control\n");

  const uid = `smoke-p10-${Date.now()}`;
  authorization = `Bearer ${await mintToken(uid, environment.FIREBASE_PROJECT_ID)}`;

  const first = await get("/api/v1/auth/me");
  const orgId = first.body.data?.org as string;
  check("signup bootstraps an org with OWNER context", first.status === 200 && Boolean(orgId));

  try {
    /* ── A. A manual advance — the one creation path that posts ───────────── */
    //   50,000.00 arrives with no document behind it: DR 1000 Cash / CR 1100 AR.
    const customer = (
      await post("/api/v1/parties", { code: "CUST", name: "Smoke Customer", kind: "CUSTOMER" })
    ).body.data.party;
    check("customer created", Boolean(customer?.id));

    const ma = (
      await post("/api/v1/advances", {
        party_id: customer.id,
        date: "2026-09-01",
        amount_bdt: "50000.00",
        account_code: "1000",
        reference: "Opening advance",
      })
    ).body.data.advance as AdvanceRow;
    check(
      "a manual advance is recorded OPEN at 50000.00 with its own journal entry",
      ma?.status === "OPEN" &&
        ma.amount_bdt === "50000.00" &&
        ma.outstanding_bdt === "50000.00" &&
        Boolean(ma.journal_entry_id),
      JSON.stringify({ status: ma?.status, outstanding: ma?.outstanding_bdt }),
    );

    const maEntry = await entryLines(ma.journal_entry_id!);
    check(
      "the manual advance posts DR 1000 Cash / CR 1100 AR — the money moved, nothing claimed it",
      maEntry.length === 2 &&
        hasLine(maEntry, "1000", "debit", "50000.00") &&
        hasLine(maEntry, "1100", "credit", "50000.00"),
      JSON.stringify(maEntry),
    );

    const beforeClaims = (
      await get(`/api/v1/advances/parties/${customer.id}/outstanding`)
    ).body.data.outstanding_bdt;
    check("the party's outstanding reads 50000.00 before anything claims it", beforeClaims === "50000.00", beforeClaims);

    const zeroAdvance = await post("/api/v1/advances", {
      party_id: customer.id,
      date: "2026-09-01",
      amount_bdt: "0.00",
    });
    check(
      "an advance of zero is refused (422 ADVANCE_AMOUNT_INVALID)",
      zeroAdvance.status === 422 && zeroAdvance.body.error?.code === "ADVANCE_AMOUNT_INVALID",
      `status ${zeroAdvance.status} ${zeroAdvance.body.error?.code}`,
    );
    const wrongAccount = await post("/api/v1/advances", {
      party_id: customer.id,
      date: "2026-09-01",
      amount_bdt: "100.00",
      account_code: "4000",
    });
    check(
      "a revenue account cannot hold an advance (422 ACCOUNT_NOT_ASSET)",
      wrongAccount.status === 422 && wrongAccount.body.error?.code === "ACCOUNT_NOT_ASSET",
      `status ${wrongAccount.status} ${wrongAccount.body.error?.code}`,
    );

    /* ── B. The ADR's first claim: 20,000.00 at issue ─────────────────────── */
    const invA = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-05",
        due_date: "2026-09-20",
        memo: "Retainer",
        lines: [{ item_id: null, description: "Retainer — September", qty: 1, unit_price_bdt: "20000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    check(
      "invoice A drafted at 20000.00",
      invA?.status === "DRAFT" && invA.total_bdt === "20000.00" && invA.doc_no === null,
      JSON.stringify({ status: invA?.status, total: invA?.total_bdt }),
    );

    const issueA = await post(`/api/v1/sales/invoices/${invA.id}/issue`, { advance_bdt: "20000.00" });
    const issuedA = issueA.body.data.invoice as InvoiceRow;
    check(
      "issuing with advance_bdt 20000.00 settles the invoice inside the issuing transaction",
      issueA.status === 200 && issuedA.status === "PAID" && issuedA.paid_bdt === "20000.00" && issuedA.outstanding_bdt === "0.00",
      JSON.stringify({ status: issuedA?.status, paid: issuedA?.paid_bdt }),
    );
    check(
      "the issue response says the advance was claimed",
      (issueA.body.data.warnings as { code: string }[]).some((row) => row.code === "ADVANCE_APPLIED"),
      JSON.stringify(issueA.body.data.warnings),
    );

    const maAfterA = (await get(`/api/v1/advances/${ma.id}`)).body.data.advance as AdvanceRow;
    check(
      "the advance is PARTIALLY_ADJUSTED: 20000.00 claimed, 30000.00 left",
      maAfterA.status === "PARTIALLY_ADJUSTED" &&
        maAfterA.adjusted_bdt === "20000.00" &&
        maAfterA.outstanding_bdt === "30000.00",
      JSON.stringify({ status: maAfterA.status, adjusted: maAfterA.adjusted_bdt, outstanding: maAfterA.outstanding_bdt }),
    );

    /* ── C. The second claim: 15,000.00 by hand — balance 15,000.00 ───────── */
    const invB = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-08",
        due_date: "2026-09-22",
        memo: "Second retainer",
        lines: [{ item_id: null, description: "Retainer — October", qty: 1, unit_price_bdt: "15000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    const issueB = await post(`/api/v1/sales/invoices/${invB.id}/issue`, {});
    check(
      "invoice B issued plainly at 15000.00",
      issueB.status === 200 && (issueB.body.data.invoice as InvoiceRow).status === "ISSUED",
      `status ${issueB.status}`,
    );

    const applyB = await post("/api/v1/advances/apply", {
      document_type: "INVOICE",
      document_id: invB.id,
      amount_bdt: "15000.00",
    });
    check(
      "an explicit claim of 15000.00 lands as one adjustment row",
      applyB.status === 200 &&
        (applyB.body.data.rows as { amount: string }[]).length === 1 &&
        Number((applyB.body.data.rows as { amount: string }[])[0]!.amount) === 15000,
      JSON.stringify(applyB.body.data),
    );
    const invBNow = await invoiceById(invB.id);
    check(
      "the claim settles invoice B to PAID — paid_bdt absorbed it like a receipt",
      invBNow.status === "PAID" && invBNow.paid_bdt === "15000.00" && invBNow.outstanding_bdt === "0.00",
      JSON.stringify({ status: invBNow.status, paid: invBNow.paid_bdt }),
    );

    const maAfterB = (await get(`/api/v1/advances/${ma.id}`)).body.data.advance as AdvanceRow;
    check(
      "balance after both claims is the ADR's 15000.00",
      maAfterB.outstanding_bdt === "15000.00" && maAfterB.adjusted_bdt === "35000.00",
      JSON.stringify({ adjusted: maAfterB.adjusted_bdt, outstanding: maAfterB.outstanding_bdt }),
    );
    check(
      "the advance's detail lists both adjustment rows, one per document",
      maAfterB.adjustments?.length === 2 &&
        maAfterB.adjustments.every((row) => row.document_type === "INVOICE"),
      JSON.stringify(maAfterB.adjustments),
    );

    const invB2 = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-09",
        memo: "Still a draft",
        lines: [{ item_id: null, description: "Draft line", qty: 1, unit_price_bdt: "5000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    const draftClaim = await post("/api/v1/advances/apply", {
      document_type: "INVOICE",
      document_id: invB2.id,
      amount_bdt: "1000.00",
    });
    check(
      "a claim against a draft is refused (409 DOCUMENT_NOT_ISSUED)",
      draftClaim.status === 409 && draftClaim.body.error?.code === "DOCUMENT_NOT_ISSUED",
      `status ${draftClaim.status} ${draftClaim.body.error?.code}`,
    );

    /* ── D. Cancel the 20,000.00 document — balance 35,000.00 — then the block ── */
    const voidA = await post(`/api/v1/sales/invoices/${invA.id}/void`, {
      reason: "Customer cancelled the retainer",
    });
    const voidedA = voidA.body.data.invoice as InvoiceRow;
    check(
      "voiding invoice A restores its claim in the same transaction",
      voidA.status === 200 && voidedA.status === "VOID" && voidedA.paid_bdt === "0.00",
      JSON.stringify({ status: voidedA?.status, paid: voidedA?.paid_bdt }),
    );

    const maAfterVoid = (await get(`/api/v1/advances/${ma.id}`)).body.data.advance as AdvanceRow;
    check(
      "the advance balance is back to 35000.00 — the ADR's restored figure",
      maAfterVoid.outstanding_bdt === "35000.00" &&
        maAfterVoid.adjusted_bdt === "15000.00" &&
        maAfterVoid.adjustments?.length === 1,
      JSON.stringify({
        adjusted: maAfterVoid.adjusted_bdt,
        outstanding: maAfterVoid.outstanding_bdt,
        rows: maAfterVoid.adjustments?.length,
      }),
    );

    const invC = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-12",
        due_date: "2026-09-26",
        memo: "Big invoice",
        lines: [{ item_id: null, description: "Quarterly project", qty: 1, unit_price_bdt: "45000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    const issueC = await post(`/api/v1/sales/invoices/${invC.id}/issue`, {});
    check("invoice C issued plainly at 45000.00", issueC.status === 200);

    const over = await post("/api/v1/advances/apply", {
      document_type: "INVOICE",
      document_id: invC.id,
      amount_bdt: "40000.00",
    });
    check(
      "a 40000.00 claim against a 35000.00 balance is refused (422 ADVANCE_OVER_ADJUSTED)",
      over.status === 422 && over.body.error?.code === "ADVANCE_OVER_ADJUSTED",
      `status ${over.status} ${over.body.error?.code}`,
    );
    check(
      "the refusal is the ADR's verbatim message, quoting the real outstanding",
      over.body.error?.message ===
        "Adjustment of 40000.00 exceeds Smoke Customer's unadjusted advance for this party (35000.00). " +
          "Reduce the adjustment or record a new advance first.",
      over.body.error?.message,
    );

    const beyondDoc = await post("/api/v1/advances/apply", {
      document_type: "INVOICE",
      document_id: invC.id,
      amount_bdt: "46000.00",
    });
    check(
      "a claim beyond the document's own remainder is refused first (422 ADVANCE_EXCEEDS_DOCUMENT)",
      beyondDoc.status === 422 && beyondDoc.body.error?.code === "ADVANCE_EXCEEDS_DOCUMENT",
      `status ${beyondDoc.status} ${beyondDoc.body.error?.code}`,
    );

    const invF = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-13",
        memo: "Over-claim at issue",
        lines: [{ item_id: null, description: "Too big to settle", qty: 1, unit_price_bdt: "60000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    const issueF = await post(`/api/v1/sales/invoices/${invF.id}/issue`, { advance_bdt: "60000.00" });
    check(
      "an over-claim at issue time is refused inside the issuing transaction",
      issueF.status === 422 && issueF.body.error?.code === "ADVANCE_OVER_ADJUSTED",
      `status ${issueF.status} ${issueF.body.error?.code}`,
    );
    const invFNow = await invoiceById(invF.id);
    check(
      "the refused issue left the invoice a draft — nothing was posted, no number burned",
      invFNow.status === "DRAFT" && invFNow.doc_no === null,
      JSON.stringify({ status: invFNow.status, doc_no: invFNow.doc_no }),
    );
    const outstandingAfterBlocks = (
      await get(`/api/v1/advances/parties/${customer.id}/outstanding`)
    ).body.data.outstanding_bdt;
    check(
      "every refused claim left the balance exactly where it was",
      outstandingAfterBlocks === "35000.00",
      outstandingAfterBlocks,
    );

    /* ── E. Two claims racing for the same money ──────────────────────────── */
    //   Two 20000.00 claims against a 35000.00 balance: 40000.00 > 35000.00,
    //   so no interleaving may let both land — serialised, the second sees
    //   15000.00 left and is refused; racing, one aborts on the write conflict
    //   the always-written advance row exists to create.
    const invD1 = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-14",
        memo: "Race one",
        lines: [{ item_id: null, description: "Race one", qty: 1, unit_price_bdt: "45000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    const invD2 = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-14",
        memo: "Race two",
        lines: [{ item_id: null, description: "Race two", qty: 1, unit_price_bdt: "45000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    await post(`/api/v1/sales/invoices/${invD1.id}/issue`, {});
    await post(`/api/v1/sales/invoices/${invD2.id}/issue`, {});

    const [race1, race2] = await Promise.all([
      post("/api/v1/advances/apply", {
        document_type: "INVOICE",
        document_id: invD1.id,
        amount_bdt: "20000.00",
      }),
      post("/api/v1/advances/apply", {
        document_type: "INVOICE",
        document_id: invD2.id,
        amount_bdt: "20000.00",
      }),
    ]);
    const raceSuccesses = [race1, race2].filter((row) => row.status === 200).length;
    check(
      "concurrent claims of 20000.00 + 20000.00 against 35000.00: at most one lands",
      raceSuccesses <= 1,
      `${raceSuccesses} succeeded (statuses ${race1.status}/${race2.status})`,
    );

    const customerAdjustments = await AdvanceAdjustmentModel.find({
      org_id: orgId,
      party_id: customer.id,
    }).lean();
    const customerSum = customerAdjustments.reduce((acc, row) => acc + Number(row.amount_bdt), 0);
    check(
      "Σ adjustments never exceeds Σ advances — the invariant held through the race",
      customerSum <= 50000,
      `Σ ${customerSum.toFixed(2)}`,
    );
    const afterRace = (
      await get(`/api/v1/advances/parties/${customer.id}/outstanding`)
    ).body.data.outstanding_bdt as string;
    check(
      "the outstanding reads exactly 50000.00 − Σ adjustments, never negative",
      afterRace === fmt(money("50000.00").minus(money(customerSum.toFixed(2)))) && Number(afterRace) >= 0,
      `${afterRace} vs Σ ${customerSum.toFixed(2)}`,
    );

    /* ── F. The reads all tell the same story ─────────────────────────────── */
    const list = (await get(`/api/v1/advances?party_id=${customer.id}`)).body.data
      .advances as AdvanceRow[];
    check(
      "the list is the FIFO queue: the manual advance is first and still PARTIALLY_ADJUSTED",
      list.length >= 1 && list[0]!.id === ma.id && list[0]!.status === "PARTIALLY_ADJUSTED",
      JSON.stringify(list.map((row) => ({ id: row.id, status: row.status }))),
    );

    const ledger = (await get(`/api/v1/advances/ledger?party_id=${customer.id}`)).body.data as {
      entries: { kind: string; advance_bdt: string; adjustment_bdt: string; running_balance_bdt: string }[];
      closing_bdt: string;
    };
    check(
      "the ledger opens with the 50000.00 advance and every running balance is canonical",
      ledger.entries[0]?.kind === "ADVANCE" &&
        ledger.entries[0].advance_bdt === "50000.00" &&
        ledger.entries[0].running_balance_bdt === "50000.00" &&
        ledger.entries.every((row) => /^\d+\.\d{2}$/.test(row.running_balance_bdt)),
      JSON.stringify(ledger.entries[0]),
    );
    check(
      "the ledger's closing balance equals what the outstanding endpoint quotes",
      ledger.closing_bdt === afterRace,
      `${ledger.closing_bdt} vs ${afterRace}`,
    );

    const outstandingList = (await get("/api/v1/advances/outstanding")).body.data
      .outstanding as { party_id: string; advances_bdt: string; outstanding_bdt: string }[];
    const customerRow = outstandingList.find((row) => row.party_id === customer.id);
    check(
      "the outstanding screen quotes the same balance, largest first",
      customerRow?.advances_bdt === "50000.00" && customerRow.outstanding_bdt === afterRace,
      JSON.stringify(customerRow),
    );

    const asOfEarly = (
      await get(`/api/v1/advances/parties/${customer.id}/outstanding?as_of=2026-08-31`)
    ).body.data.outstanding_bdt;
    const asOfBefore = (
      await get(`/api/v1/advances/parties/${customer.id}/outstanding?as_of=2026-09-04`)
    ).body.data.outstanding_bdt;
    const asOfEnd = (
      await get(`/api/v1/advances/parties/${customer.id}/outstanding?as_of=2026-09-30`)
    ).body.data.outstanding_bdt;
    check(
      "as-of before the advance reads 0.00; the day before any claim reads 50000.00",
      asOfEarly === "0.00" && asOfBefore === "50000.00",
      `${asOfEarly} / ${asOfBefore}`,
    );
    check(
      "as-of the month end reads the same as the live figure",
      asOfEnd === afterRace,
      asOfEnd,
    );

    /* ── G. Reversal is a no-op by construction ───────────────────────────── */
    const reverseLive = await post("/api/v1/advances/reverse", {
      document_type: "INVOICE",
      document_id: invB.id,
    });
    check(
      "reversing a claim on a live document is refused (409 DOCUMENT_NOT_VOID)",
      reverseLive.status === 409 && reverseLive.body.error?.code === "DOCUMENT_NOT_VOID",
      `status ${reverseLive.status} ${reverseLive.body.error?.code}`,
    );
    const reverse1 = await post("/api/v1/advances/reverse", {
      document_type: "INVOICE",
      document_id: invA.id,
    });
    const reverse2 = await post("/api/v1/advances/reverse", {
      document_type: "INVOICE",
      document_id: invA.id,
    });
    check(
      "a double reversal of an already-void document is a no-op both times",
      reverse1.status === 200 &&
        reverse1.body.data.reversed === 0 &&
        reverse2.status === 200 &&
        reverse2.body.data.reversed === 0,
      JSON.stringify({ first: reverse1.body.data, second: reverse2.body.data }),
    );
    const claimVoid = await post("/api/v1/advances/apply", {
      document_type: "INVOICE",
      document_id: invA.id,
      amount_bdt: "1000.00",
    });
    check(
      "no advance can settle a voided document (409 DOCUMENT_VOID)",
      claimVoid.status === 409 && claimVoid.body.error?.code === "DOCUMENT_VOID",
      `status ${claimVoid.status} ${claimVoid.body.error?.code}`,
    );

    /* ── H. A receipt overpayment parks as an advance ─────────────────────── */
    //   Invoice 10000.00, receipt 12000.00: the 2000.00 difference is not an
    //   error and not absorbed — it parks as an advance with no journal entry
    //   of its own, because the receipt's entry already carried the money.
    const invG = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-15",
        due_date: "2026-09-29",
        memo: "Invoice to overpay",
        lines: [{ item_id: null, description: "Website work", qty: 1, unit_price_bdt: "10000.00" }],
      })
    ).body.data.invoice as InvoiceRow;
    const issueG = await post(`/api/v1/sales/invoices/${invG.id}/issue`, {});
    check("invoice G issued plainly at 10000.00", issueG.status === 200);

    const receipt = (
      await post("/api/v1/sales/receipts", {
        party_id: customer.id,
        date: "2026-09-16",
        method: "CASH",
        amount_bdt: "12000.00",
        allocations: [{ invoice_id: invG.id, amount_bdt: "10000.00" }],
      })
    ).body.data.receipt as { id: string };
    check(
      "a 12000.00 receipt settles the 10000.00 invoice in full",
      Boolean(receipt?.id) && (await invoiceById(invG.id)).status === "PAID",
      JSON.stringify({ receipt: receipt?.id }),
    );

    const parked = (await get(`/api/v1/advances?party_id=${customer.id}`)).body.data
      .advances as AdvanceRow[];
    const remainder = parked.find((row) => row.source === "RECEIPT_REMAINDER");
    check(
      "the 2000.00 remainder parked as an advance with no journal entry of its own",
      remainder?.amount_bdt === "2000.00" &&
        remainder.journal_entry_id === null &&
        remainder.status === "OPEN" &&
        remainder.reference.includes("remainder"),
      JSON.stringify(remainder),
    );

    /* ── I. The supplier mirror: a prepayment parks, then settles a bill ──── */
    const supplier = (
      await post("/api/v1/parties", { code: "SUPP", name: "Smoke Supplier", kind: "SUPPLIER" })
    ).body.data.party;
    check("supplier created", Boolean(supplier?.id));

    const billH = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-10",
        memo: "Consulting retainer",
        lines: [
          { description: "Consulting retainer", qty: 1, unit_price_bdt: "8000.00", account_code: "5800" },
        ],
      })
    ).body.data.bill as BillRow;
    const issueH = await post(`/api/v1/purchases/bills/${billH.id}/issue`, {});
    check(
      "bill H issued plainly at 8000.00",
      issueH.status === 200 && (issueH.body.data.bill as BillRow).status === "ISSUED",
      `status ${issueH.status}`,
    );

    const payment = (
      await post("/api/v1/purchases/payments", {
        party_id: supplier.id,
        date: "2026-09-16",
        amount_bdt: "10000.00",
        allocations: [{ bill_id: billH.id, amount_bdt: "8000.00" }],
      })
    ).body.data.payment as { id: string };
    check(
      "a 10000.00 payment settles bill H in full",
      Boolean(payment?.id) && (await billById(billH.id)).status === "PAID",
      JSON.stringify({ payment: payment?.id }),
    );

    const supplierAdvances = (
      await get(`/api/v1/advances?party_id=${supplier.id}`)
    ).body.data.advances as AdvanceRow[];
    const prepaid = supplierAdvances.find((row) => row.source === "PAYMENT_PREPAYMENT");
    check(
      "the 2000.00 prepayment parked with no entry of its own",
      prepaid?.amount_bdt === "2000.00" && prepaid.journal_entry_id === null,
      JSON.stringify(prepaid),
    );

    const billI = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-18",
        memo: "Second consulting",
        lines: [
          { description: "Second consulting", qty: 1, unit_price_bdt: "5000.00", account_code: "5800" },
        ],
      })
    ).body.data.bill as BillRow;
    const issueI = await post(`/api/v1/purchases/bills/${billI.id}/issue`, {});
    check("bill I issued plainly at 5000.00", issueI.status === 200);

    const applyBill = await post("/api/v1/advances/apply", {
      document_type: "BILL",
      document_id: billI.id,
      amount_bdt: "2000.00",
    });
    const billINow = await billById(billI.id);
    check(
      "the prepayment settles 2000.00 of bill I — paid_bdt absorbed it like a payment",
      applyBill.status === 200 &&
        billINow.paid_bdt === "2000.00" &&
        billINow.status === "PARTIALLY_PAID",
      JSON.stringify({ status: billINow.status, paid: billINow.paid_bdt }),
    );

    const supplierNow = (
      await get(`/api/v1/advances?party_id=${supplier.id}`)
    ).body.data.advances as AdvanceRow[];
    check(
      "the supplier advance is FULLY_ADJUSTED at 0.00 — status derived, never set",
      supplierNow[0]?.status === "FULLY_ADJUSTED" && supplierNow[0].outstanding_bdt === "0.00",
      JSON.stringify(supplierNow[0]),
    );
    const outstandingNow = (await get("/api/v1/advances/outstanding")).body.data
      .outstanding as { party_id: string }[];
    check(
      "a fully claimed prepayment drops off the outstanding screen",
      !outstandingNow.some((row) => row.party_id === supplier.id),
      JSON.stringify(outstandingNow),
    );

    /* ── J. Permissions ───────────────────────────────────────────────────── */
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "VIEWER" } });
    check(
      "a VIEWER may read the advances, the outstanding and the ledger",
      (await get("/api/v1/advances")).status === 200 &&
        (await get("/api/v1/advances/outstanding")).status === 200 &&
        (await get("/api/v1/advances/ledger")).status === 200,
    );
    check(
      "a VIEWER cannot record an advance (403)",
      (
        await post("/api/v1/advances", {
          party_id: customer.id,
          date: "2026-09-20",
          amount_bdt: "10.00",
        })
      ).status === 403,
    );
    check(
      "a VIEWER cannot claim one (403)",
      (
        await post("/api/v1/advances/apply", {
          document_type: "INVOICE",
          document_id: invC.id,
          amount_bdt: "10.00",
        })
      ).status === 403,
    );
    check(
      "a VIEWER cannot reverse a claim (403)",
      (
        await post("/api/v1/advances/reverse", {
          document_type: "INVOICE",
          document_id: invA.id,
        })
      ).status === 403,
    );
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "OWNER" } });

    /* ── K. The invariant, asserted from the rows themselves ──────────────── */
    const report = await runIntegrityChecks();
    const statusOf = (id: string): string | undefined =>
      report.checks.find((row) => row.id === id)?.status;
    check(
      "I5-ADVANCES passes with manual, parked and prepaid advances in play",
      statusOf("I5-ADVANCES") === "pass",
      JSON.stringify(report.checks.find((row) => row.id === "I5-ADVANCES")?.findings),
    );
    check(
      "I6-ADVANCE-NONNEGATIVE passes — no party was ever adjusted past its advances",
      statusOf("I6-ADVANCE-NONNEGATIVE") === "pass",
      JSON.stringify(report.checks.find((row) => row.id === "I6-ADVANCE-NONNEGATIVE")?.findings),
    );
    check(
      "I5-AR-CONTROL passes — the claim add-back ties AR to the sub-ledger",
      statusOf("I5-AR-CONTROL") === "pass",
      JSON.stringify(report.checks.find((row) => row.id === "I5-AR-CONTROL")?.findings),
    );
    check(
      "I5-AP-CONTROL passes — prepayment claims tie AP the same way",
      statusOf("I5-AP-CONTROL") === "pass",
      JSON.stringify(report.checks.find((row) => row.id === "I5-AP-CONTROL")?.findings),
    );
    check(
      "the money-format check covers both new collections",
      statusOf("P0-MONEY-FORMAT") === "pass",
    );
    check(
      "no integrity check fails",
      report.checks.every((row) => row.status !== "fail"),
      report.checks
        .filter((row) => row.status === "fail")
        .map((row) => row.id)
        .join(", "),
    );

    // A last look at the tables themselves: the invariant re-derived from the
    // raw rows, without the engine's own arithmetic anywhere in the loop.
    const allAdjustments = await AdvanceAdjustmentModel.find({ org_id: orgId }).lean();
    check(
      "every stored adjustment is a canonical 2dp amount",
      allAdjustments.every((row) => /^\d+\.\d{2}$/.test(row.amount_bdt)),
      JSON.stringify(
        allAdjustments.map((row) => row.amount_bdt).filter((value) => !/^\d+\.\d{2}$/.test(value)),
      ),
    );

    const allAdvances = await AdvanceModel.find({ org_id: orgId }).lean();
    const adjustedByParty = new Map<string, number>();
    for (const row of allAdjustments) {
      const key = String(row.party_id);
      adjustedByParty.set(key, (adjustedByParty.get(key) ?? 0) + Number(row.amount_bdt));
    }
    const totalByParty = new Map<string, number>();
    for (const row of allAdvances) {
      const key = String(row.party_id);
      totalByParty.set(key, (totalByParty.get(key) ?? 0) + Number(row.amount_bdt));
    }
    check(
      "per party, Σ adjustments ≤ Σ advances — I6's invariant, re-derived here",
      [...adjustedByParty.entries()].every(
        ([party, adjusted]) => adjusted <= (totalByParty.get(party) ?? 0),
      ),
      JSON.stringify(
        [...adjustedByParty.entries()].map(([party, adjusted]) => ({
          party,
          adjusted,
          total: totalByParty.get(party) ?? 0,
        })),
      ),
    );
    check(
      "a manual advance carries its own entry; a parked or prepaid one carries none",
      allAdvances.every((row) =>
        row.source === "MANUAL" ? Boolean(row.journal_entry_id) : row.journal_entry_id === null,
      ),
      JSON.stringify(allAdvances.map((row) => ({ source: row.source, entry: row.journal_entry_id }))),
    );
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
          // The advance sub-ledger (P10). Its rows reference parties and
          // documents, and a leftover adjustment against a deleted advance
          // would corrupt I6 for whoever inherits the database.
          AdvanceAdjustmentModel.deleteMany({ org_id: id }),
          AdvanceModel.deleteMany({ org_id: id }),
          // The register (P9).
          DepreciationRunModel.deleteMany({ org_id: id }),
          FixedAssetModel.deleteMany({ org_id: id }),
          InvoiceLineModel.deleteMany({ org_id: id }),
          InvoiceModel.deleteMany({ org_id: id }),
          ReceiptAllocationModel.deleteMany({ org_id: id }),
          ReceiptModel.deleteMany({ org_id: id }),
          CreditNoteModel.deleteMany({ org_id: id }),
          BillLineModel.deleteMany({ org_id: id }),
          BillModel.deleteMany({ org_id: id }),
          PaymentAllocationModel.deleteMany({ org_id: id }),
          PaymentModel.deleteMany({ org_id: id }),
          DebitNoteModel.deleteMany({ org_id: id }),
          TaxChallanModel.deleteMany({ org_id: id }),
          TaxCertificateModel.deleteMany({ org_id: id }),
          // The stock ledger (P8).
          StocktakeModel.deleteMany({ org_id: id }),
          StockMovementModel.deleteMany({ org_id: id }),
          StockBalanceModel.deleteMany({ org_id: id }),
          WarehouseModel.deleteMany({ org_id: id }),
          // The treasury rows a new org is bootstrapped with.
          BankAccountModel.deleteMany({ org_id: id }),
          TransferModel.deleteMany({ org_id: id }),
          StatementImportModel.deleteMany({ org_id: id }),
          StatementLineModel.deleteMany({ org_id: id }),
          JournalEntryModel.deleteMany({ org_id: id }),
          JournalLineModel.deleteMany({ org_id: id }),
          CoaAccountModel.deleteMany({ org_id: id }),
          PeriodModel.deleteMany({ org_id: id }),
          SequenceCounterModel.deleteMany({ org_id: id }),
          PartyModel.deleteMany({ org_id: id }),
          ItemModel.deleteMany({ org_id: id }),
          UnitModel.deleteMany({ org_id: id }),
          TaxRateModel.deleteMany({ org_id: id }),
          MasterCategoryModel.deleteMany({ org_id: id }),
          OrgSettingsModel.deleteMany({ org_id: id }),
          OrgMembershipModel.deleteMany({ org_id: id }),
          // Native, bypassing the append-only hook — the hook blocking
          // `AuditLog.deleteMany` is the feature, not a bug.
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
