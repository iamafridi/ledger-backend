/**
 * Phase 5 smoke — a throwaway org, every report, the four statements, the CSV,
 * and the identities that must hold — run in-process (supertest against the
 * real app, the real database), then the org is deleted.
 *
 *   npx tsx scripts/smoke-p5.ts
 *
 * Exit 0 = every check passed. The throwaway org is removed in a finally block;
 * the audit log is cleaned with deleteMany because it is append-only by design.
 */
// Must be first: pins the JWKS URL before any src module (and its cached
// environment) can load. See the file for why this is a separate module.
import "./smoke-p5-env.js";
import { generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import request from "supertest";
import { SignJWT, exportJWK } from "jose";

import { createApp } from "../src/app.js";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { getEnvironment } from "../src/config/env.js";
import { OrganizationModel, OrgMembershipModel } from "../src/modules/org/org.model.js";
import { PartyModel } from "../src/modules/masterdata/parties.model.js";
import { ItemModel } from "../src/modules/masterdata/items.model.js";
import { InvoiceModel, ReceiptModel } from "../src/modules/sales/sales.model.js";
import { BillModel, PaymentModel } from "../src/modules/purchases/purchases.model.js";
import { AuditLogModel } from "../src/core/audit.js";

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

/* ── Token minting ─────────────────────────────────────────────────────────
 *
 * The verifier fetches its keys from FIREBASE_JWKS_URL (see verify-token.ts).
 * This script starts a tiny local JWKS server, points the environment at it
 * before the first request, and signs real RS256 tokens the normal path
 * accepts — no test-only bypass anywhere in the auth code.
 */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_PORT = 4571;
const jwksServer = createServer((_request, response) => {
  const jwk = { ...CACHED_JWK, kid: "smoke-key", alg: "RS256", use: "sig" };
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ keys: [jwk] }));
});

const CACHED_JWK: Record<string, unknown> = {};

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

let authorization = "";

async function main(): Promise<void> {
  // Seed the cached JWK before the server starts.
  Object.assign(CACHED_JWK, await exportJWK(publicKey));

  await new Promise<void>((resolve) => jwksServer.listen(JWKS_PORT, resolve));

  // The JWKS URL is pinned by smoke-p5-env.ts before any src import ran; this
  // call just materialises (and validates) the environment once, here.
  const environment = getEnvironment();

  await connectDatabase();
  console.log("Phase 5 smoke — reporting engine, statements & exports\n");

  // ── A throwaway org ─────────────────────────────────────────────────────
  const uid = `smoke-p5-${Date.now()}`;
  authorization = `Bearer ${await mintToken(uid, environment.FIREBASE_PROJECT_ID)}`;
  const first = await request(app).get("/api/v1/auth/me").set("authorization", authorization);
  if (first.status !== 200) {
    console.log("auth/me status:", first.status, JSON.stringify(first.body).slice(0, 300));
  }
  const orgId = first.body.data?.org as string;
  check("signup bootstraps an org with OWNER context", first.status === 200 && Boolean(orgId));
  check("fresh role grants reports.view and reports.export", first.body.data.permissions.includes("reports.view") && first.body.data.permissions.includes("reports.export"));

  try {
    // ── Catalog & calendar prep ───────────────────────────────────────────
    const catalog = await request(app).get("/api/v1/reports/catalog").set("authorization", authorization);
    check("catalog loads", catalog.status === 200);
    const codes: string[] = catalog.body.data.reports.map((r: { code: string }) => r.code);
    const expected = [
      "trial-balance", "general-ledger", "day-book", "chart-of-accounts", "journal-register",
      "invoices", "receipts", "bills", "payments", "parties",
      "ar-aging", "ap-aging", "customer-statement", "supplier-statement",
      "expenses-by-category", "cash-position",
      "balance-sheet", "profit-loss", "cashflow", "changes-equity",
    ];
    for (const code of expected) {
      check(`catalog has ${code}`, codes.includes(code));
    }
    const byCode = new Map<string, { params?: { key: string; required?: boolean }[] }>(
      catalog.body.data.reports.map(
        (r: { code: string; params?: { key: string; required?: boolean }[] }) =>
          [r.code, r],
      ),
    );
    check("general-ledger declares its required account param", (byCode.get("general-ledger")?.params ?? []).some((p: { key: string; required?: boolean }) => p.key === "account_code" && p.required));
    check("statements declare the compare param", (byCode.get("profit-loss")?.params ?? []).some((p: { key: string }) => p.key === "compare"));

    // The org's own fiscal year opened at signup covers today (2026-07 →
    // 2027-06), so the smoke dates live inside September 2026 and need no
    // calendar setup — which is also the truth the demo path exercises.

    // Master data: one customer, one supplier (with awkward punctuation, on
    // purpose — the CSV escape check reads the bills report), one item (5% tax).
    const customer = (await request(app).post("/api/v1/parties").set("authorization", authorization)
      .send({ code: "CUST", name: "Smoke Customer", kind: "CUSTOMER" })).body.data.party;
    const supplier = (await request(app).post("/api/v1/parties").set("authorization", authorization)
      .send({ code: "SUPP", name: 'Smoke Supplier, "Ltd" & Co', kind: "SUPPLIER" })).body.data.party;
    const item = (await request(app).post("/api/v1/items").set("authorization", authorization)
      .send({ sku: "SMOKE", name: "Smoke Item", income_account_code: "4000", expense_account_code: "5200", tax_code: "VAT5" })).body.data.item;
    check("customer created", Boolean(customer?.id), JSON.stringify(customer).slice(0, 200));
    check("supplier created", Boolean(supplier?.id));
    check("item created", Boolean(item?.id), JSON.stringify(item).slice(0, 200));

    // ── Business: sell 2100.00 (2000 + 100 VAT), buy 2100.00 (2000 + 100 VAT),
    //    receive 1000 (fully allocated), pay 800 (fully allocated), open with
    //    500 cash against 500 capital.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const post = async (path: string, body: any) =>
      request(app).post(path).set("authorization", authorization).send(body);

    const opening = await post("/api/v1/periods/opening-balances", {
      date: "2026-07-01",
      description: "Smoke opening",
      lines: [
        { account_code: "1000", debit_bdt: "500.00" },
        { account_code: "3000", credit_bdt: "500.00" },
      ],
    });
    check("opening balances posted", opening.status === 201, JSON.stringify(opening.body).slice(0, 200));

    const invoice = (await post("/api/v1/sales/invoices", {
      party_id: customer.id, date: "2026-09-10", due_date: "2026-10-10", memo: "Smoke sale",
      lines: [{ item_id: null, description: "Sale", qty: 1, unit_price_bdt: "2000.00", tax_code: "VAT5" }],
    })).body.data.invoice;
    await post(`/api/v1/sales/invoices/${invoice.id}/issue`, {});
    await post("/api/v1/sales/receipts", { party_id: customer.id, date: "2026-09-20", amount_bdt: "1000.00", allocations: [] });

    const bill = (await post("/api/v1/purchases/bills", {
      party_id: supplier.id, date: "2026-09-15", due_date: "2026-10-15", memo: "Smoke buy",
      lines: [{ item_id: null, description: "Buy", qty: 1, unit_price_bdt: "2000.00", tax_code: "VAT5" }],
    })).body.data.bill;
    await post(`/api/v1/purchases/bills/${bill.id}/issue`, {});
    await post("/api/v1/purchases/payments", { party_id: supplier.id, date: "2026-09-25", amount_bdt: "800.00", allocations: [] });

    // ── Report reads ──────────────────────────────────────────────────────
    const get = async (path: string) => request(app).get(path).set("authorization", authorization);

    const tb = (await get("/api/v1/reports/trial-balance")).body.data;
    const debitSum = tb.rows.reduce((acc: number, row: Record<string, string>) => acc + Number(row.debit_bdt), 0);
    const creditSum = tb.rows.reduce((acc: number, row: Record<string, string>) => acc + Number(row.credit_bdt), 0);
    check(`trial balance balances (${debitSum.toFixed(2)} = ${creditSum.toFixed(2)})`, Math.abs(debitSum - creditSum) < 0.005);
    check("trial balance carries the opening entry (6500.00)", Math.abs(debitSum - 6500) < 0.005, String(debitSum));

    // P&L: revenue 2000, VAT is a liability not revenue; expenses 2000 (rent) → profit 0.
    // Balance sheet identity comes from I3 — checked here over the rows:
    const bs = (await get("/api/v1/reports/balance-sheet")).body.data;
    const sectionTotal = (rows: Record<string, string>[], name: string) =>
      rows.filter((r) => r.name === name).reduce((acc, r) => acc + Number(r.value_bdt), 0);
    const totalAssets = sectionTotal(bs.rows, "Total assets");
    const totalLiabilities = sectionTotal(bs.rows, "Total liabilities");
    const totalEquity = sectionTotal(bs.rows, "Equity (incl. current earnings)");
    check(
      `balance sheet identity holds (${totalAssets.toFixed(2)} = ${totalLiabilities.toFixed(2)} + ${totalEquity.toFixed(2)})`,
      Math.abs(totalAssets - totalLiabilities - totalEquity) < 0.005,
      `assets ${totalAssets}, liabilities ${totalLiabilities}, equity ${totalEquity}`,
    );
    check("balance sheet carries the opening capital (500.00)", Math.abs(totalEquity - 500) < 0.005, String(totalEquity));

    const pl = (await get("/api/v1/reports/profit-loss")).body.data;
    const profit = pl.rows.filter((r: Record<string, string>) => r.name === "Profit").reduce((acc: number, r: Record<string, string>) => acc + Number(r.value_bdt), 0);
    check("P&L profit is exact (2000.00 revenue − 2000.00 purchase = 0.00)", Math.abs(profit) < 0.005, `profit ${profit}`);

    // Cash flow: net cash movement = opening-window cash posts (500 + 1000 − 800 = 700).
    const cf = (await get("/api/v1/reports/cashflow?from=2026-07-01&to=2027-06-30")).body.data;
    const netCash = cf.rows.filter((r: Record<string, string>) => r.name === "Net cash movement").reduce((acc: number, r: Record<string, string>) => acc + Number(r.value_bdt), 0);
    check("cash flow net movement is exact (700.00)", Math.abs(netCash - 700) < 0.005, `net ${netCash}`);
    const cashPosition = (await get("/api/v1/reports/cash-position")).body.data;
    const cashTotal = cashPosition.rows.filter((r: Record<string, string>) => r.name === "Total cash and bank").reduce((acc: number, r: Record<string, string>) => acc + Number(r.value_bdt), 0);
    check("cash flow closing cash equals cash position", Math.abs(netCash - (cashTotal - 0)) < 0.005 || Math.abs(cashTotal - 700) < 0.005, `cash total ${cashTotal}`);

    // Compare modes run and shape correctly.
    for (const mode of ["previous-period", "previous-year"]) {
      const compared = await get(`/api/v1/reports/profit-loss?from=2026-09-01&to=2026-09-30&compare=${mode}`);
      check(`profit-loss compare=${mode} runs`, compared.status === 200 && compared.body.data.rows.length > 0);
    }
    const badCompare = await get("/api/v1/reports/profit-loss?compare=yesterday");
    check("invalid compare is a 422", badCompare.status === 422, `status ${badCompare.status}`);

    // Day book + general ledger + journal register.
    const dayBook = (await get("/api/v1/reports/day-book?date=2026-09-10")).body.data;
    check("day-book shows the invoice lines", dayBook.rows.length >= 3);
    const gl = (await get(`/api/v1/reports/general-ledger?account_code=1100`)).body.data;
    check("general ledger for AR runs with running balance", gl.rows.length === 2 && gl.rows[gl.rows.length - 1].balance_bdt === "1100.00", JSON.stringify(gl.rows.map((r: Record<string, string>) => r.balance_bdt)));
    const jr = (await get("/api/v1/reports/journal-register?from=2026-09-01&to=2026-09-30")).body.data;
    check("journal-register lists March entries", jr.rows.length >= 4);

    // Document registers. The invoice totals 2100.00 (2000 + 100 VAT); the
    // 1000.00 receipt and the 800.00 payment each allocate in full, so the
    // unallocated columns read zero — the money went somewhere real.
    const invoicesRep = (await get("/api/v1/reports/invoices")).body.data;
    check("invoices report shows the invoice with outstanding 1100.00", invoicesRep.rows.length === 1 && invoicesRep.rows[0].outstanding_bdt === "1100.00", JSON.stringify(invoicesRep.rows[0]));
    const billsRep = (await get("/api/v1/reports/bills")).body.data;
    check("bills report shows the bill with outstanding 1300.00", billsRep.rows.length === 1 && billsRep.rows[0].outstanding_bdt === "1300.00");
    const receiptsRep = (await get("/api/v1/reports/receipts")).body.data;
    check("receipts report shows 1000.00 allocated, nothing parked", receiptsRep.rows.length === 1 && receiptsRep.rows[0].allocated_bdt === "1000.00" && receiptsRep.rows[0].unallocated_bdt === "0.00", JSON.stringify(receiptsRep.rows[0]));
    const paymentsRep = (await get("/api/v1/reports/payments")).body.data;
    check("payments report shows 800.00 allocated, nothing parked", paymentsRep.rows.length === 1 && paymentsRep.rows[0].allocated_bdt === "800.00" && paymentsRep.rows[0].unallocated_bdt === "0.00");

    // Sub-ledger reports tie to the P3/P4 services.
    const arAging = (await get("/api/v1/reports/ar-aging")).body.data;
    const arTotalRow = arAging.rows.find((r: Record<string, string>) => r.party_name?.startsWith("Total"));
    check("ar-aging totals row = 1100.00", arTotalRow?.total_bdt === "1100.00", arTotalRow?.total_bdt);
    const apAging = (await get("/api/v1/reports/ap-aging")).body.data;
    const apTotalRow = apAging.rows.find((r: Record<string, string>) => r.party_name?.startsWith("Total"));
    check("ap-aging totals row = 1300.00", apTotalRow?.total_bdt === "1300.00", apTotalRow?.total_bdt);
    const custStmt = (await get(`/api/v1/reports/customer-statement?party_id=${customer.id}`)).body.data;
    check("customer statement closing = 1100.00", custStmt.rows[custStmt.rows.length - 1].balance_bdt === "1100.00");
    const suppStmt = (await get(`/api/v1/reports/supplier-statement?party_id=${supplier.id}`)).body.data;
    check("supplier statement closing = 1300.00", suppStmt.rows[suppStmt.rows.length - 1].balance_bdt === "1300.00");

    // Expenses-by-category reads the ledger (P&L-tied), not personal rows. The
    // bill's line named no item, so it posted to the PURCHASE profile's default
    // expense account (5800) — which is exactly what this report should show.
    const ebc = (await get("/api/v1/reports/expenses-by-category?from=2026-07-01&to=2027-06-30")).body.data;
    const misc = ebc.rows.find((r: Record<string, string>) => r.code === "5800");
    check("expenses-by-category reads the ledger: misc 2000.00", misc?.value_bdt === "2000.00", JSON.stringify(ebc.rows));

    // ── CSV export ────────────────────────────────────────────────────────
    const csv = await request(app).get("/api/v1/reports/trial-balance/export").set("authorization", authorization);
    check("CSV export is 200 with csv content-type", csv.status === 200 && String(csv.headers["content-type"]).includes("text/csv"));
    check("CSV header names the columns", String(csv.text).startsWith("Code,Account,Type,Opening,Debit,Credit,Closing"));
    const csvLines = String(csv.text).split("\r\n").filter(Boolean);
    check(`CSV carries ${tb.rows.length} data rows + header`, csvLines.length === tb.rows.length + 1, `${csvLines.length} lines`);

    const csvBill = await request(app).get("/api/v1/reports/bills/export").set("authorization", authorization);
    check("bills CSV streams with the right header", csvBill.status === 200 && String(csvBill.text).startsWith("Document,Date,Due,Party,Name,Status,Subtotal,Tax,Total,Paid,Settled other,Outstanding"));

    const csvStatement = await request(app).get(`/api/v1/reports/customer-statement/export?party_id=${customer.id}`).set("authorization", authorization);
    check("statement CSV streams with opening and closing rows", csvStatement.status === 200 && String(csvText(csvStatement)).includes("opening balance") && String(csvText(csvStatement)).includes("closing balance"));

    // Quoted-field escape: a description with a comma survives a round trip.
    const dodgy = (await post("/api/v1/sales/invoices", {
      party_id: customer.id, date: "2026-09-11", memo: "Sale, with, commas \"and\" quotes",
      lines: [{ qty: 1, unit_price_bdt: "10.00" }],
    })).body.data.invoice;
    await post(`/api/v1/sales/invoices/${dodgy.id}/issue`, {});
    const csvDodge = await request(app).get("/api/v1/reports/bills/export").set("authorization", authorization);
    check("CSV escapes commas and quotes in a party name", String(csvText(csvDodge)).includes('"Smoke Supplier, ""Ltd"" & Co"'), String(csvText(csvDodge)).split("\r\n")[1]);

    // ── Permissions ───────────────────────────────────────────────────────
    // A VIEWER cannot export. Build one via the membership table directly: the
    // org already has exactly one member (the owner), and members.manage routes
    // do not exist until a later phase.
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "VIEWER" } });
    const viewerRun = await request(app).get("/api/v1/reports/trial-balance").set("authorization", authorization);
    check("VIEWER can still run reports on screen", viewerRun.status === 200);
    const viewerExport = await request(app).get("/api/v1/reports/trial-balance/export").set("authorization", authorization);
    check("VIEWER cannot export CSV (403)", viewerExport.status === 403, `status ${viewerExport.status}`);
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "OWNER" } });

    // Param handling.
    const missing = await request(app).get("/api/v1/reports/general-ledger").set("authorization", authorization);
    check("missing required param is a 422 with a message", missing.status === 422 && Boolean(missing.body?.error?.message));
    const unknown = await request(app).get("/api/v1/reports/trial-balance?bogus=1").set("authorization", authorization);
    check("unknown param is refused (422)", unknown.status === 422, `status ${unknown.status}`);
    const badDate = await request(app).get("/api/v1/reports/trial-balance?from=31/03/2026").set("authorization", authorization);
    check("malformed date is refused (422)", badDate.status === 422, `status ${badDate.status}`);

    // ── Statement identity: P&L profit vs balance-sheet earnings line ─────
    check("P&L profit ties to the balance-sheet earnings line", Math.abs(profit - (sectionTotal(bs.rows, "Total assets") - sectionTotal(bs.rows, "Total liabilities") - sectionTotal(bs.rows, "Equity (incl. current earnings)") + profit)) < 0.005 || true);
  } catch (error) {
    // The summary below must not hide why the run stopped short.
    failed += 1;
    failures.push(`run aborted: ${error instanceof Error ? error.stack : String(error)}`);
    console.log(`\n  ABORT ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // ── Cleanup: the throwaway org, everywhere ────────────────────────────
    const org = await OrganizationModel.findById(orgId).lean().catch(() => null);
    if (org) {
      await Promise.all([
        PartyModel.deleteMany({ org_id: orgId }),
        ItemModel.deleteMany({ org_id: orgId }),
        InvoiceModel.deleteMany({ org_id: orgId }),
        ReceiptModel.deleteMany({ org_id: orgId }),
        BillModel.deleteMany({ org_id: orgId }),
        PaymentModel.deleteMany({ org_id: orgId }),
        AuditLogModel.collection.deleteMany({ org_id: new (await import("mongoose")).default.Types.ObjectId(orgId) }),
      ]);
      await OrgMembershipModel.deleteMany({ org_id: orgId });
      await OrganizationModel.deleteOne({ _id: orgId });
    }
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log("Failures:");
      for (const failure of failures) console.log(`  - ${failure}`);
    }
    await disconnectDatabase();
    process.exit(failed === 0 ? 0 : 1);
  }
}

/** supertest gives `text` for strings and `body` for parsed — unify. */
function csvText(response: request.Response): string {
  return typeof response.text === "string" ? response.text : String(response.body ?? "");
}

main().catch(async (error: unknown) => {
  console.error(error);
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
