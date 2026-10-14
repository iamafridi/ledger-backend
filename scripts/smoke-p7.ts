/**
 * Phase 7 smoke — tax & VAT, run in-process against the real app and the real
 * database on a throwaway org, which is deleted at the end.
 *
 *   npx tsx scripts/smoke-p7.ts
 *
 * The point of this script is the phase's exit gate: **I5 holds for VAT** — the
 * VAT and withholding control accounts equal the documents behind them, to the
 * paisa — plus the arithmetic the return is only worth anything on: tax to the
 * paisa across inclusive, exclusive and discounted lines, a return whose totals
 * equal the control balances, and a truncation difference that reconciles the
 * declared figure to the book figure.
 *
 * Exit 0 = every check passed.
 */
// Must be first: pins the JWKS URL before any src module (and its cached
// environment) can load.
import "./smoke-p7-env.js";
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

/* ── Token minting (same recipe as the Phase 5/6 smokes) ─────────────────── */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_PORT = 4573;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const put = (path: string, body: any) =>
  request(app).put(path).set("authorization", authorization).send(body);

interface PostedLine {
  account_code: string;
  debit_bdt: string;
  credit_bdt: string;
}

/** The lines of a posted entry, so a posting can be asserted line by line. */
async function entryLines(entryId: string): Promise<PostedLine[]> {
  return (await get(`/api/v1/journals/${entryId}`)).body.data.entry.lines as PostedLine[];
}

const hasLine = (lines: PostedLine[], code: string, side: "debit" | "credit", amount: string): boolean =>
  lines.some(
    (line) =>
      line.account_code === code &&
      line[side === "debit" ? "debit_bdt" : "credit_bdt"] === amount,
  );

async function main(): Promise<void> {
  Object.assign(CACHED_JWK, await exportJWK(publicKey));
  await new Promise<void>((resolve) => jwksServer.listen(JWKS_PORT, resolve));

  const environment = getEnvironment();
  await connectDatabase();
  console.log("Phase 7 smoke — tax on lines, the VAT return, withholding & challans\n");

  const uid = `smoke-p7-${Date.now()}`;
  authorization = `Bearer ${await mintToken(uid, environment.FIREBASE_PROJECT_ID)}`;

  const first = await get("/api/v1/auth/me");
  const orgId = first.body.data?.org as string;
  check("signup bootstraps an org with OWNER context", first.status === 200 && Boolean(orgId));

  try {
    /* ── Tax rates: VAT and withholding, seeded and typed ────────────────── */
    const rates = (await get("/api/v1/catalogs/tax-rates")).body.data.tax_rates as {
      code: string;
      kind: string;
      rate_percent: string;
    }[];
    const vat = rates.filter((rate) => rate.kind === "VAT");
    const withholding = rates.filter((rate) => rate.kind === "WITHHOLDING");
    check(
      "a fresh org seeds the three VAT rates and the three withholding rates",
      vat.length === 3 && withholding.length === 3,
      JSON.stringify(rates.map((rate) => `${rate.code}:${rate.kind}`)),
    );
    check(
      "the withholding seeds are the three the register groups (VDS, AIT, source tax)",
      ["VDS", "AIT", "SRCTAX"].every((code) => withholding.some((rate) => rate.code === code)),
      withholding.map((rate) => rate.code).join(", "),
    );

    /* ── Master data ─────────────────────────────────────────────────────── */
    const customer = (
      await post("/api/v1/parties", { code: "CUST", name: "Smoke Customer", kind: "CUSTOMER" })
    ).body.data.party;
    const supplier = (
      await post("/api/v1/parties", { code: "SUPP", name: "Smoke Supplier", kind: "SUPPLIER" })
    ).body.data.party;
    check("customer and supplier created", Boolean(customer?.id && supplier?.id));

    /* ── Exclusive tax, discount before VAT ──────────────────────────────── */
    const draft = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-05",
        memo: "Exclusive smoke sale",
        lines: [
          {
            item_id: null,
            description: "Discounted sale",
            qty: 2,
            unit_price_bdt: "1000.00",
            discount_bdt: "100.00",
            tax_code: "VAT15",
          },
        ],
      })
    ).body.data.invoice;
    const issued = (await post(`/api/v1/sales/invoices/${draft.id}/issue`, {})).body.data.invoice;
    check(
      "exclusive + discount: 2 × 1000.00 less 100.00 is 1900.00 net and 285.00 VAT",
      issued.subtotal_bdt === "1900.00" && issued.tax_total_bdt === "285.00" && issued.total_bdt === "2185.00",
      `${issued.subtotal_bdt} / ${issued.tax_total_bdt} / ${issued.total_bdt}`,
    );
    check(
      "the discount reduced the taxable value (tax on 1900, not on 2000)",
      issued.lines[0]?.tax_bdt === "285.00",
      `tax was ${issued.lines[0]?.tax_bdt}`,
    );
    const exclusiveEntry = await entryLines(issued.journal_entry_id);
    check(
      "the invoice posted DR 1100 2185.00 / CR 4000 1900.00 / CR 2100 285.00",
      exclusiveEntry.length === 3 &&
        hasLine(exclusiveEntry, "1100", "debit", "2185.00") &&
        hasLine(exclusiveEntry, "4000", "credit", "1900.00") &&
        hasLine(exclusiveEntry, "2100", "credit", "285.00"),
      JSON.stringify(exclusiveEntry),
    );

    /* ── Inclusive tax: the price already contains it ─────────────────────── */
    const profile = (await get("/api/v1/settings/org")).body.data.profile;
    const toInclusive = await put("/api/v1/settings/org", { ...profile, vat_mode: "INCLUSIVE" });
    check(
      "the organisation can be set to inclusive tax",
      toInclusive.status === 200 && toInclusive.body.data.profile.vat_mode === "INCLUSIVE",
      JSON.stringify(toInclusive.body).slice(0, 300),
    );

    const inclusiveDraft = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-06",
        memo: "Inclusive smoke sale",
        lines: [
          { item_id: null, description: "Tax-inclusive sale", qty: 1, unit_price_bdt: "1150.00", tax_code: "VAT15" },
        ],
      })
    ).body.data.invoice;
    const inclusive = (await post(`/api/v1/sales/invoices/${inclusiveDraft.id}/issue`, {})).body.data.invoice;
    check(
      "inclusive: a 1150.00 price is 1000.00 net and 150.00 VAT, totalling exactly 1150.00",
      inclusive.subtotal_bdt === "1000.00" && inclusive.tax_total_bdt === "150.00" && inclusive.total_bdt === "1150.00",
      `${inclusive.subtotal_bdt} / ${inclusive.tax_total_bdt} / ${inclusive.total_bdt}`,
    );
    check(
      "the line records which way round its prices were read",
      inclusive.lines[0]?.tax_mode === "INCLUSIVE",
      String(inclusive.lines[0]?.tax_mode),
    );

    const discountedInclusive = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-07",
        memo: "Inclusive, discounted",
        lines: [
          {
            item_id: null,
            description: "Tax-inclusive with discount",
            qty: 1,
            unit_price_bdt: "1150.00",
            discount_bdt: "150.00",
            tax_code: "VAT15",
          },
        ],
      })
    ).body.data.invoice.id;
    const discountedInclusiveIssued = (
      await post(`/api/v1/sales/invoices/${discountedInclusive}/issue`, {})
    ).body.data.invoice;
    check(
      "inclusive + discount: 1150.00 less 150.00 splits into 869.57 net and 130.43 VAT (no drifting paisa)",
      discountedInclusiveIssued.subtotal_bdt === "869.57" &&
        discountedInclusiveIssued.tax_total_bdt === "130.43" &&
        discountedInclusiveIssued.total_bdt === "1000.00",
      `${discountedInclusiveIssued.subtotal_bdt} / ${discountedInclusiveIssued.tax_total_bdt} / ${discountedInclusiveIssued.total_bdt}`,
    );

    // Back to exclusive for the rest of the run, so the mode is a fact the
    // documents carry rather than a setting the assertions depend on.
    await put("/api/v1/settings/org", { ...profile, vat_mode: "EXCLUSIVE" });

    /* ── A withholding rate cannot be put on a line ───────────────────────── */
    const withholdingOnLine = await post("/api/v1/sales/invoices", {
      party_id: customer.id,
      date: "2026-09-08",
      lines: [{ item_id: null, description: "Wrong code", qty: 1, unit_price_bdt: "100.00", tax_code: "VDS" }],
    });
    check(
      "a withholding code on a document line is refused (422 TAX_CODE_NOT_APPLICABLE)",
      withholdingOnLine.status === 422 && withholdingOnLine.body.error?.code === "TAX_CODE_NOT_APPLICABLE",
      `${withholdingOnLine.status} ${withholdingOnLine.body.error?.code}`,
    );

    /* ── A bill, so the return has an input side ──────────────────────────── */
    const billDraft = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-10",
        memo: "Smoke purchase",
        lines: [{ item_id: null, description: "Purchase", qty: 1, unit_price_bdt: "1000.00", tax_code: "VAT15" }],
      })
    ).body.data.bill;
    const bill = (await post(`/api/v1/purchases/bills/${billDraft.id}/issue`, {})).body.data.bill;
    const billEntry = await entryLines(bill.journal_entry_id);
    check(
      "the bill posted DR 5800 1000.00 / DR 1300 150.00 / CR 2000 1150.00",
      billEntry.length === 3 &&
        hasLine(billEntry, "5800", "debit", "1000.00") &&
        hasLine(billEntry, "1300", "debit", "150.00") &&
        hasLine(billEntry, "2000", "credit", "1150.00"),
      JSON.stringify(billEntry),
    );

    /* ── The VAT return for the month ─────────────────────────────────────── */
    const vatReturn = (await get("/api/v1/tax/vat-return?month=2026-09")).body.data.vat_return;
    check(
      "output VAT is banded by rate: one 15% band, 3769.57 net and 565.43 tax",
      vatReturn.output.bands.length === 1 &&
        vatReturn.output.bands[0].tax_code === "VAT15" &&
        vatReturn.output.bands[0].rate_percent === "15.00" &&
        vatReturn.output.bands[0].net_bdt === "3769.57" &&
        vatReturn.output.bands[0].tax_bdt === "565.43",
      JSON.stringify(vatReturn.output.bands),
    );
    check(
      "input VAT is banded the same way: 1000.00 net and 150.00 tax",
      vatReturn.input.bands.length === 1 &&
        vatReturn.input.bands[0].net_bdt === "1000.00" &&
        vatReturn.input.bands[0].tax_bdt === "150.00",
      JSON.stringify(vatReturn.input.bands),
    );
    check(
      "the books say 415.43 payable (565.43 out less 150.00 in)",
      vatReturn.net_payable_bdt === "415.43",
      vatReturn.net_payable_bdt,
    );
    check(
      "the return declares 415.00 — each band truncated to whole taka, then added",
      vatReturn.net_payable_declared_bdt === "415.00",
      vatReturn.net_payable_declared_bdt,
    );
    check(
      "the truncation difference is stated as a visible note rather than hidden (0.43)",
      vatReturn.rounding_difference_bdt === "0.43" && vatReturn.rounding_note.includes("415.43") && vatReturn.rounding_note.includes("415.00"),
      `${vatReturn.rounding_difference_bdt} / ${vatReturn.rounding_note}`,
    );
    check(
      "the return's control balances are the ledger's: 2100 holds 565.43, 1300 holds 150.00",
      vatReturn.controls.output_balance_bdt === "565.43" && vatReturn.controls.input_balance_bdt === "150.00",
      `${vatReturn.controls.output_balance_bdt} / ${vatReturn.controls.input_balance_bdt}`,
    );
    check(
      "the return counts the documents it was built from",
      vatReturn.documents.invoices === 3 && vatReturn.documents.bills === 1,
      JSON.stringify(vatReturn.documents),
    );

    /* ── Withholding at payment ───────────────────────────────────────────── */
    const wrongCode = await post("/api/v1/purchases/payments", {
      party_id: supplier.id,
      date: "2026-09-15",
      method: "BANK",
      amount_bdt: "1150.00",
      withholdings: [{ tax_code: "VAT15", amount_bdt: "10.00" }],
    });
    check(
      "a VAT code cannot be used as withholding (422 TAX_CODE_NOT_APPLICABLE)",
      wrongCode.status === 422 && wrongCode.body.error?.code === "TAX_CODE_NOT_APPLICABLE",
      `${wrongCode.status} ${wrongCode.body.error?.code}`,
    );
    const overWithheld = await post("/api/v1/purchases/payments", {
      party_id: supplier.id,
      date: "2026-09-15",
      method: "BANK",
      amount_bdt: "1150.00",
      withholdings: [{ tax_code: "VDS", amount_bdt: "1200.00" }],
    });
    check(
      "withholding more than the payment settles is refused (422 WITHHOLDING_EXCEEDS_PAYMENT)",
      overWithheld.status === 422 && overWithheld.body.error?.code === "WITHHOLDING_EXCEEDS_PAYMENT",
      `${overWithheld.status} ${overWithheld.body.error?.code}`,
    );

    const paymentResponse = await post("/api/v1/purchases/payments", {
      party_id: supplier.id,
      date: "2026-09-15",
      method: "BANK",
      amount_bdt: "1150.00",
      withholdings: [{ tax_code: "VDS", amount_bdt: "50.00" }],
      memo: "Settled less VDS",
    });
    const payment = paymentResponse.body.data.payment;
    check(
      "the payment settles 1150.00, withholds 50.00 and moves 1100.00 of cash",
      payment.amount_bdt === "1150.00" &&
        payment.withheld_bdt === "50.00" &&
        payment.cash_bdt === "1100.00" &&
        payment.allocated_bdt === "1150.00",
      `${payment.amount_bdt} / ${payment.withheld_bdt} / ${payment.cash_bdt}`,
    );
    check(
      "the withholding is snapshotted with the rate it was taken at",
      payment.withholdings?.length === 1 &&
        payment.withholdings[0].tax_code === "VDS" &&
        payment.withholdings[0].tax_rate_snapshot === "5.00" &&
        payment.withholdings[0].amount_bdt === "50.00",
      JSON.stringify(payment.withholdings),
    );
    const paymentEntry = await entryLines(payment.journal_entry_id);
    check(
      "the payment posted DR AP 1150.00 / CR cash 1100.00 / CR source tax payable 50.00",
      paymentEntry.length === 3 &&
        hasLine(paymentEntry, "2000", "debit", "1150.00") &&
        hasLine(paymentEntry, "1010", "credit", "1100.00") &&
        hasLine(paymentEntry, "2200", "credit", "50.00"),
      JSON.stringify(paymentEntry),
    );
    check(
      "the screen is told the withholding is now a liability with a deadline",
      (paymentResponse.body.data.warnings ?? []).some((row: { code: string }) => row.code === "TAX_WITHHELD"),
      JSON.stringify(paymentResponse.body.data.warnings),
    );
    check("the bill is fully settled by the payment", (await get(`/api/v1/purchases/bills/${bill.id}`)).body.data.bill.status === "PAID");

    /* ── The withholding register ─────────────────────────────────────────── */
    const register = (await get("/api/v1/tax/withholding")).body.data.register;
    check(
      "the register shows one row, 50.00 withheld and nothing deposited yet",
      register.rows.length === 1 &&
        register.total_bdt === "50.00" &&
        register.deposited_bdt === "0.00" &&
        register.outstanding_bdt === "50.00",
      JSON.stringify({ rows: register.rows.length, total: register.total_bdt, outstanding: register.outstanding_bdt }),
    );
    check(
      "the row carries the supplier, the payment and the certificate state",
      register.rows[0].party_name === "Smoke Supplier" &&
        register.rows[0].tax_code === "VDS" &&
        register.rows[0].certified === false,
      JSON.stringify(register.rows[0]),
    );
    check(
      "the total is grouped by rate",
      register.totals.length === 1 && register.totals[0].tax_code === "VDS" && register.totals[0].amount_bdt === "50.00",
      JSON.stringify(register.totals),
    );

    /* ── The challan clears the liability ────────────────────────────────── */
    const challan = (
      await post("/api/v1/tax/challans", {
        date: "2026-09-25",
        amount_bdt: "50.00",
        account_code: "1010",
        challan_ref: "GOV-9911",
        memo: "VDS August–September",
      })
    ).body.data.challan;
    check("a challan claims its own gapless number (2026-01)", challan.doc_no === "2026-01", challan.doc_no);
    const challanEntry = await entryLines(challan.journal_entry_id);
    check(
      "the challan posted DR 2200 50.00 / CR 1010 50.00",
      challanEntry.length === 2 &&
        hasLine(challanEntry, "2200", "debit", "50.00") &&
        hasLine(challanEntry, "1010", "credit", "50.00"),
      JSON.stringify(challanEntry),
    );
    const afterChallan = (await get("/api/v1/tax/withholding")).body.data.register;
    check(
      "the register now shows the liability deposited and nothing outstanding",
      afterChallan.deposited_bdt === "50.00" && afterChallan.outstanding_bdt === "0.00",
      `${afterChallan.deposited_bdt} / ${afterChallan.outstanding_bdt}`,
    );
    const afterChallanReturn = (await get("/api/v1/tax/vat-return?month=2026-09")).body.data.vat_return;
    check(
      "source tax payable is back to 0.00 and withheld now equals what was deposited",
      afterChallanReturn.controls.withholding_balance_bdt === "0.00" &&
        afterChallanReturn.controls.withheld_to_date_bdt === "50.00" &&
        afterChallanReturn.controls.deposited_to_date_bdt === "50.00",
      JSON.stringify(afterChallanReturn.controls),
    );

    /* ── The certificate ─────────────────────────────────────────────────── */
    const certificate = (
      await post("/api/v1/tax/certificates", { party_id: supplier.id, month: "2026-09" })
    ).body.data.certificate;
    check(
      "a certificate is issued for the supplier and month, for 50.00 at 5%",
      certificate.doc_no === "2026-01" &&
        certificate.amount_bdt === "50.00" &&
        certificate.withholdings?.[0]?.tax_code === "VDS" &&
        certificate.withholdings?.[0]?.tax_rate_snapshot === "5.00",
      JSON.stringify(certificate),
    );
    const duplicate = await post("/api/v1/tax/certificates", { party_id: supplier.id, month: "2026-09" });
    check(
      "a second certificate for the same supplier and month is refused (409 CERTIFICATE_EXISTS)",
      duplicate.status === 409 && duplicate.body.error?.code === "CERTIFICATE_EXISTS",
      `${duplicate.status} ${duplicate.body.error?.code}`,
    );
    const nothingToCertify = await post("/api/v1/tax/certificates", { party_id: supplier.id, month: "2026-08" });
    check(
      "a month with no withholding cannot be certified (422 NOTHING_TO_CERTIFY)",
      nothingToCertify.status === 422 && nothingToCertify.body.error?.code === "NOTHING_TO_CERTIFY",
      `${nothingToCertify.status} ${nothingToCertify.body.error?.code}`,
    );
    const certifiedRegister = (await get("/api/v1/tax/withholding")).body.data.register;
    check("the register now marks the withholding certified", certifiedRegister.rows[0].certified === true);
    check(
      "the certificate is listed",
      (await get("/api/v1/tax/certificates")).body.data.certificates.length === 1,
    );

    /* ── CSV export ──────────────────────────────────────────────────────── */
    const csv = await get("/api/v1/tax/vat-return/export?month=2026-09");
    check(
      "the return exports as CSV with a header and the banded rows",
      csv.status === 200 &&
        /text\/csv/.test(csv.headers["content-type"] ?? "") &&
        csv.text.includes("Side,Tax code,Rate %,Net,Tax (books),Declared (taka)") &&
        csv.text.includes("Output VAT,VAT15,15.00,3769.57,565.43,565.00") &&
        csv.text.includes("Input VAT,VAT15,15.00,1000.00,150.00,150.00") &&
        csv.text.includes("Net payable (books)"),
      csv.text.split("\r\n").slice(0, 3).join(" | "),
    );

    /* ── Permissions ─────────────────────────────────────────────────────── */
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "VIEWER" } });
    check("a VIEWER may read the VAT return", (await get("/api/v1/tax/vat-return?month=2026-09")).status === 200);
    check("a VIEWER may read the withholding register", (await get("/api/v1/tax/withholding")).status === 200);
    const viewerChallan = await post("/api/v1/tax/challans", { date: "2026-09-26", amount_bdt: "1.00" });
    check("a VIEWER cannot record a deposit (403)", viewerChallan.status === 403, `status ${viewerChallan.status}`);
    const viewerCertificate = await post("/api/v1/tax/certificates", { party_id: supplier.id, month: "2026-09" });
    check("a VIEWER cannot issue a certificate (403)", viewerCertificate.status === 403, `status ${viewerCertificate.status}`);
    check(
      "a VIEWER cannot export the return (403)",
      (await get("/api/v1/tax/vat-return/export?month=2026-09")).status === 403,
    );
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "OWNER" } });

    /* ── Integrity: the phase's exit gate ────────────────────────────────── */
    const report = await runIntegrityChecks();
    const vatControl = report.checks.find((row) => row.id === "I5-VAT-CONTROL");
    check(
      "I5 holds for VAT — the control accounts equal the documents behind them",
      vatControl?.status === "pass",
      `${vatControl?.status}: ${vatControl?.findings.join("; ")}`,
    );
    const moneyFormat = report.checks.find((row) => row.id === "P0-MONEY-FORMAT");
    check("the new tax collections keep canonical money strings", moneyFormat?.status === "pass", JSON.stringify(moneyFormat?.findings));
    check(
      "no integrity check fails",
      report.checks.every((row) => row.status !== "fail"),
      report.checks.filter((row) => row.status === "fail").map((row) => row.id).join(", "),
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
          // The treasury rows a new org is bootstrapped with. A payment leaves
          // the books through one of them, and leaving them behind is how a
          // deleted organisation's chart accounts get reported missing by
          // P6-BANK-MAPPING.
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
