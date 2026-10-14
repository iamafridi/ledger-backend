/**
 * Phase 8 smoke — inventory, run in-process against the real app and the real
 * database on a throwaway org, which is deleted at the end.
 *
 *   npx tsx scripts/smoke-p8.ts
 *
 * The point of this script is the phase's exit gate: **I5 holds for stock** — the
 * inventory control account equals the stock ledger's valuation, to the paisa —
 * after enough mixed activity that the equality is worth something: two receipts
 * at different prices, a sale costed at the moving average, a transfer between
 * two warehouses, a write-off and a write-on, a stocktake variance, and both
 * kinds of void. Plus the refusals the phase promises: selling more than is on
 * hand, and voiding a receipt whose goods have since been sold.
 *
 * Every figure below is hand-checkable, and the arithmetic is in the comments.
 *
 * Exit 0 = every check passed.
 */
// Must be first: pins the JWKS URL before any src module (and its cached
// environment) can load.
import "./smoke-p8-env.js";
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

/* ── Token minting (the same recipe as the Phase 5–7 smokes) ─────────────── */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_PORT = 4574;
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
const patch = (path: string, body: any) =>
  request(app).patch(path).set("authorization", authorization).send(body);

interface PostedLine {
  account_code: string;
  debit_bdt: string;
  credit_bdt: string;
}

async function entryLines(entryId: string): Promise<PostedLine[]> {
  return (await get(`/api/v1/journals/${entryId}`)).body.data.entry.lines as PostedLine[];
}

const hasLine = (lines: PostedLine[], code: string, side: "debit" | "credit", amount: string): boolean =>
  lines.some((line) => line.account_code === code && line[side === "debit" ? "debit_bdt" : "credit_bdt"] === amount);

interface BalanceRow {
  item_id: string;
  sku: string;
  warehouse_id: string;
  warehouse_name: string;
  qty: number;
  value_bdt: string;
  avg_cost_bdt: string;
  reorder_level: number;
  low_stock: boolean;
}

/** One item's position in one warehouse, from the API rather than the models —
 *  the screen's own reading. */
async function balanceFor(warehouseId: string, sku: string): Promise<BalanceRow | undefined> {
  const body = (await get(`/api/v1/inventory/stock?warehouse_id=${warehouseId}`)).body.data as {
    balances: BalanceRow[];
  };
  return body.balances.find((row) => row.sku === sku);
}

async function main(): Promise<void> {
  Object.assign(CACHED_JWK, await exportJWK(publicKey));
  await new Promise<void>((resolve) => jwksServer.listen(JWKS_PORT, resolve));

  const environment = getEnvironment();
  await connectDatabase();
  console.log("Phase 8 smoke — stock, costing, adjustments and the inventory tie-out\n");

  const uid = `smoke-p8-${Date.now()}`;
  authorization = `Bearer ${await mintToken(uid, environment.FIREBASE_PROJECT_ID)}`;

  const first = await get("/api/v1/auth/me");
  const orgId = first.body.data?.org as string;
  check("signup bootstraps an org with OWNER context", first.status === 200 && Boolean(orgId));

  try {
    /* ── Start clean: no warehouse until something needs one ─────────────── */
    const warehousesAtStart = (await get("/api/v1/inventory/warehouses")).body.data.warehouses as unknown[];
    check(
      "a fresh ledger has no warehouses until something needs one",
      warehousesAtStart.length === 0,
      `${warehousesAtStart.length} warehouses`,
    );

    /* ── Master data ─────────────────────────────────────────────────────── */
    const customer = (
      await post("/api/v1/parties", { code: "CUST", name: "Smoke Customer", kind: "CUSTOMER" })
    ).body.data.party;
    const supplier = (
      await post("/api/v1/parties", { code: "SUPP", name: "Smoke Supplier", kind: "SUPPLIER" })
    ).body.data.party;
    check("customer and supplier created", Boolean(customer?.id && supplier?.id));

    const rice = (
      await post("/api/v1/items", {
        sku: "RICE-1KG",
        name: "Basmati Rice 1kg",
        track_stock: true,
        reorder_level: 20,
        cogs_account_code: "5000",
      })
    ).body.data.item;
    const box = (
      await post("/api/v1/items", {
        sku: "BOX-S",
        name: "Packing Box (small)",
        track_stock: true,
        cogs_account_code: "5000",
      })
    ).body.data.item;
    const service = (
      await post("/api/v1/items", { sku: "DELIVERY", name: "Delivery service", track_stock: false })
    ).body.data.item;
    check(
      "three items created — two tracked (one with a reorder level) and one not",
      Boolean(rice?.id && box?.id && service?.id) && rice.track_stock === true && rice.reorder_level === 20,
      JSON.stringify({ rice: rice?.track_stock, reorder: rice?.reorder_level, service: service?.track_stock }),
    );

    const emptyLow = (await get("/api/v1/inventory/stock")).body.data.low_stock as {
      sku: string;
      on_hand: number;
      reorder_level: number;
    }[];
    check(
      "a tracked item with nothing on hand and a reorder level of 20 reads as low",
      emptyLow.some((row) => row.sku === "RICE-1KG" && row.on_hand === 0 && row.reorder_level === 20),
      JSON.stringify(emptyLow),
    );

    /* ── A receipt: 10 × 100.00 = 1000.00 into inventory ─────────────────── */
    const billA = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-02",
        memo: "First rice delivery",
        lines: [{ item_id: rice.id, qty: 10, unit_price_bdt: "100.00" }],
      })
    ).body.data.bill;
    const issuedA = (await post(`/api/v1/purchases/bills/${billA.id}/issue`, {})).body.data.bill;
    const entryA = await entryLines(issuedA.journal_entry_id);
    check(
      "a bill for a stock item debits inventory (1200), not an expense",
      entryA.length === 2 && hasLine(entryA, "1200", "debit", "1000.00") && hasLine(entryA, "2000", "credit", "1000.00"),
      JSON.stringify(entryA),
    );

    const warehouses = (await get("/api/v1/inventory/warehouses")).body.data.warehouses as {
      id: string;
      code: string;
      name: string;
      is_default: boolean;
      total_value_bdt: string;
      total_qty: number;
    }[];
    const main = warehouses.find((row) => row.code === "MAIN");
    check(
      "the first stock movement opens the default warehouse",
      warehouses.length === 1 && main?.is_default === true && main?.name === "Main Store",
      JSON.stringify(warehouses),
    );
    check(
      "the receipt put 10 on the shelf, worth 1000.00",
      main?.total_qty === 10 && main?.total_value_bdt === "1000.00",
      `${main?.total_qty} / ${main?.total_value_bdt}`,
    );

    const afterA = await balanceFor(main!.id, "RICE-1KG");
    check(
      "the balance costs the goods at 100.00 each",
      afterA?.qty === 10 && afterA?.value_bdt === "1000.00" && afterA?.avg_cost_bdt === "100.00",
      JSON.stringify(afterA),
    );

    /* ── A second receipt at a higher price moves the average ───────────── */
    // (10 × 100.00) + (10 × 200.00) = 3000.00 over 20 units → 150.00 each.
    const billB = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-04",
        memo: "Second rice delivery",
        lines: [{ item_id: rice.id, qty: 10, unit_price_bdt: "200.00" }],
      })
    ).body.data.bill;
    await post(`/api/v1/purchases/bills/${billB.id}/issue`, {});

    const afterB = await balanceFor(main!.id, "RICE-1KG");
    check(
      "a second receipt at a different price moves the moving average to 150.00",
      afterB?.qty === 20 && afterB?.value_bdt === "3000.00" && afterB?.avg_cost_bdt === "150.00",
      JSON.stringify(afterB),
    );

    /* ── A sale consumes at the average and posts COGS ───────────────────── */
    // 6 × 500.00 = 3000.00 of revenue, 6 × 150.00 = 900.00 of cost.
    const invoice1 = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-10",
        memo: "Rice sale",
        lines: [{ item_id: rice.id, qty: 6, unit_price_bdt: "500.00" }],
      })
    ).body.data.invoice;
    const issued1 = (await post(`/api/v1/sales/invoices/${invoice1.id}/issue`, {})).body.data.invoice;
    const entry1 = await entryLines(issued1.journal_entry_id);
    check(
      "a sale of stock posts its own cost: DR 5000 900.00 / CR 1200 900.00 alongside the revenue",
      entry1.length === 4 &&
        hasLine(entry1, "1100", "debit", "3000.00") &&
        hasLine(entry1, "4000", "credit", "3000.00") &&
        hasLine(entry1, "5000", "debit", "900.00") &&
        hasLine(entry1, "1200", "credit", "900.00"),
      JSON.stringify(entry1),
    );

    const after1 = await balanceFor(main!.id, "RICE-1KG");
    check(
      "the shelf falls to 14 worth 2100.00, average unchanged",
      after1?.qty === 14 && after1?.value_bdt === "2100.00" && after1?.avg_cost_bdt === "150.00",
      JSON.stringify(after1),
    );

    /* ── An untracked item is untouched by any of this ───────────────────── */
    const invoice2 = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-11",
        memo: "Delivery charge",
        lines: [{ item_id: service.id, qty: 1, unit_price_bdt: "1000.00" }],
      })
    ).body.data.invoice;
    const issued2 = (await post(`/api/v1/sales/invoices/${invoice2.id}/issue`, {})).body.data.invoice;
    const entry2 = await entryLines(issued2.journal_entry_id);
    check(
      "a sale of an untracked item posts no COGS and moves no stock",
      entry2.length === 2 && hasLine(entry2, "1100", "debit", "1000.00") && hasLine(entry2, "4000", "credit", "1000.00"),
      JSON.stringify(entry2),
    );

    /* ── Negative stock is refused, and the refusal costs nothing ────────── */
    const entriesBeforeRefusal = await JournalEntryModel.countDocuments({ org_id: orgId });
    const invoice3 = (
      await post("/api/v1/sales/invoices", {
        party_id: customer.id,
        date: "2026-09-12",
        memo: "Too much rice",
        lines: [{ item_id: rice.id, qty: 100, unit_price_bdt: "500.00" }],
      })
    ).body.data.invoice;
    const refusal = await post(`/api/v1/sales/invoices/${invoice3.id}/issue`, {});
    check(
      "selling more than is on hand is refused with INSUFFICIENT_STOCK",
      refusal.status === 422 && refusal.body.error?.code === "INSUFFICIENT_STOCK",
      `${refusal.status} ${refusal.body.error?.code}`,
    );
    const afterRefusal = await balanceFor(main!.id, "RICE-1KG");
    const entriesAfterRefusal = await JournalEntryModel.countDocuments({ org_id: orgId });
    const stillDraft = (await get(`/api/v1/sales/invoices/${invoice3.id}`)).body.data.invoice.status;
    check(
      "the refused sale left the shelf, the journal and the draft exactly as they were",
      afterRefusal?.qty === 14 &&
        afterRefusal?.value_bdt === "2100.00" &&
        entriesAfterRefusal === entriesBeforeRefusal &&
        stillDraft === "DRAFT",
      `${afterRefusal?.qty}/${afterRefusal?.value_bdt}, entries ${entriesBeforeRefusal}→${entriesAfterRefusal}, status ${stillDraft}`,
    );

    /* ── A transfer moves goods without touching the ledger ──────────────── */
    const store2 = (
      await post("/api/v1/inventory/warehouses", { code: "STORE2", name: "Second Store" })
    ).body.data.warehouse;
    const renamed = (
      await patch(`/api/v1/inventory/warehouses/${store2.id}`, { name: "Second Store (north)" })
    ).body.data.warehouse;
    check(
      "a warehouse can be renamed, and the code it is known by stays fixed",
      renamed?.name === "Second Store (north)" && renamed?.code === "STORE2" && renamed?.is_default === false,
      `${renamed?.name} / ${renamed?.code}`,
    );

    const entriesBeforeTransfer = await JournalEntryModel.countDocuments({ org_id: orgId });
    const transfer = (
      await post("/api/v1/inventory/transfers", {
        item_id: rice.id,
        from_warehouse_id: main!.id,
        to_warehouse_id: store2.id,
        date: "2026-09-13",
        qty: 4,
        memo: "Restock the second store",
      })
    ).body.data.transfer;
    const entriesAfterTransfer = await JournalEntryModel.countDocuments({ org_id: orgId });
    check(
      "a transfer writes no journal entry — the goods moved, their value did not",
      entriesAfterTransfer === entriesBeforeTransfer,
      `${entriesBeforeTransfer} → ${entriesAfterTransfer}`,
    );
    check(
      "the transferred goods carry their cost with them (4 × 150.00)",
      transfer?.qty === 4 && transfer?.value_bdt === "600.00",
      JSON.stringify(transfer),
    );

    const mainAfterTransfer = await balanceFor(main!.id, "RICE-1KG");
    const store2AfterTransfer = await balanceFor(store2.id, "RICE-1KG");
    check(
      "both shelves still add up to the same 2100.00",
      mainAfterTransfer?.qty === 10 &&
        mainAfterTransfer?.value_bdt === "1500.00" &&
        store2AfterTransfer?.qty === 4 &&
        store2AfterTransfer?.value_bdt === "600.00",
      `${JSON.stringify(mainAfterTransfer)} / ${JSON.stringify(store2AfterTransfer)}`,
    );

    /* ── A write-off, then a write-on ────────────────────────────────────── */
    const writeOff = (
      await post("/api/v1/inventory/adjustments", {
        item_id: rice.id,
        warehouse_id: main!.id,
        date: "2026-09-14",
        qty_delta: -1,
        reason: "Damaged in transit",
      })
    ).body.data.adjustment;
    const entryOff = writeOff?.journal_entry_id ? await entryLines(writeOff.journal_entry_id) : [];
    check(
      "a write-off posts DR 5600 / CR 1200 at the moving average (150.00)",
      writeOff?.value_bdt === "150.00" &&
        hasLine(entryOff, "5600", "debit", "150.00") &&
        hasLine(entryOff, "1200", "credit", "150.00"),
      `${writeOff?.value_bdt} ${JSON.stringify(entryOff)}`,
    );

    const writeOn = (
      await post("/api/v1/inventory/adjustments", {
        item_id: rice.id,
        warehouse_id: main!.id,
        date: "2026-09-15",
        qty_delta: 1,
        unit_cost_bdt: "150.00",
        reason: "Recount found one more",
      })
    ).body.data.adjustment;
    const entryOn = writeOn?.journal_entry_id ? await entryLines(writeOn.journal_entry_id) : [];
    check(
      "a write-on posts DR 1200 / CR 5600 at the cost it was given",
      writeOn?.value_bdt === "150.00" &&
        hasLine(entryOn, "1200", "debit", "150.00") &&
        hasLine(entryOn, "5600", "credit", "150.00"),
      `${writeOn?.value_bdt} ${JSON.stringify(entryOn)}`,
    );

    /* ── A stocktake: a shortfall posts, an agreed count does not ────────── */
    const count = (
      await post("/api/v1/inventory/stocktakes", {
        warehouse_id: store2.id,
        date: "2026-09-16",
        memo: "Quarterly count",
        lines: [{ item_id: rice.id, counted_qty: 3, unit_cost_bdt: "150.00" }],
      })
    ).body.data.stocktake;
    check(
      "the worksheet snapshots the book (4 expected) against the count (3)",
      count?.lines?.[0]?.expected_qty === 4 && count?.lines?.[0]?.variance_qty === -1 && count?.status === "DRAFT",
      JSON.stringify(count?.lines),
    );

    const posted = (
      await post(`/api/v1/inventory/stocktakes/${count.id}/post`, { reason: "One bag missing at the count" })
    ).body.data.stocktake;
    const entryCount = posted?.journal_entry_id ? await entryLines(posted.journal_entry_id) : [];
    check(
      "posting the shortfall writes DR 5600 / CR 1200 for 150.00 and marks the worksheet posted",
      posted?.status === "POSTED" &&
        hasLine(entryCount, "5600", "debit", "150.00") &&
        hasLine(entryCount, "1200", "credit", "150.00"),
      `${posted?.status} ${JSON.stringify(entryCount)}`,
    );
    const store2AfterCount = await balanceFor(store2.id, "RICE-1KG");
    check(
      "the second store now holds 3 worth 450.00",
      store2AfterCount?.qty === 3 && store2AfterCount?.value_bdt === "450.00",
      JSON.stringify(store2AfterCount),
    );

    // A worksheet that finds exactly what the book said records that the count
    // happened and posts nothing — there is no amount for an entry to carry.
    const agreed = (
      await post("/api/v1/inventory/stocktakes", {
        warehouse_id: store2.id,
        date: "2026-09-17",
        memo: "Agreed count",
        lines: [{ item_id: rice.id, counted_qty: 3, unit_cost_bdt: "150.00" }],
      })
    ).body.data.stocktake;
    check("a worksheet with no variance drafts with nothing to post", agreed?.variance_value_bdt === "0.00");

    /* ── Voiding: allowed when untouched, refused when the goods are gone ── */
    const billC = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-18",
        memo: "Boxes entered twice",
        lines: [{ item_id: box.id, qty: 5, unit_price_bdt: "40.00" }],
      })
    ).body.data.bill;
    await post(`/api/v1/purchases/bills/${billC.id}/issue`, {});
    const boxBefore = await balanceFor(main!.id, "BOX-S");
    check(
      "the boxes arrived (5 worth 200.00)",
      boxBefore?.qty === 5 && boxBefore?.value_bdt === "200.00",
      JSON.stringify(boxBefore),
    );

    const voidC = await post(`/api/v1/purchases/bills/${billC.id}/void`, { reason: "Entered twice" });
    const boxAfter = await balanceFor(main!.id, "BOX-S");
    check(
      "voiding a receipt nothing has touched takes the goods back off the shelf",
      voidC.status === 200 && boxAfter?.qty === 0 && boxAfter?.value_bdt === "0.00",
      `${voidC.status} ${JSON.stringify(boxAfter)}`,
    );

    const voidA = await post(`/api/v1/purchases/bills/${billA.id}/void`, { reason: "Wrong supplier" });
    check(
      "voiding a receipt whose goods have since been averaged is refused (409 STOCK_CONSUMED)",
      voidA.status === 409 && voidA.body.error?.code === "STOCK_CONSUMED",
      `${voidA.status} ${voidA.body.error?.code}`,
    );

    const voidInvoice = await post(`/api/v1/sales/invoices/${invoice1.id}/void`, { reason: "Order cancelled" });
    const mainAfterVoid = await balanceFor(main!.id, "RICE-1KG");
    check(
      "voiding a sale brings the goods back at the cost they left at (10 → 16 units, +900.00)",
      voidInvoice.status === 200 && mainAfterVoid?.qty === 16 && mainAfterVoid?.value_bdt === "2400.00",
      `${voidInvoice.status} ${JSON.stringify(mainAfterVoid)}`,
    );
    const voidedEntry = (await get(`/api/v1/journals/${issued1.journal_entry_id}`)).body.data.entry;
    check(
      "the voided sale's entry is voided, not deleted — its own COGS lines included",
      voidedEntry?.status === "VOID" && voidedEntry?.lines?.length === 4,
      `${voidedEntry?.status} ${voidedEntry?.lines?.length} lines`,
    );

    /* ── The account on the line decides whether stock moves ─────────────── */
    const billD = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-19",
        memo: "Rice for the staff kitchen",
        lines: [{ item_id: rice.id, qty: 2, unit_price_bdt: "50.00", account_code: "5800" }],
      })
    ).body.data.bill;
    const issuedD = (await post(`/api/v1/purchases/bills/${billD.id}/issue`, {})).body.data.bill;
    const entryD = await entryLines(issuedD.journal_entry_id);
    const mainAfterD = await balanceFor(main!.id, "RICE-1KG");
    check(
      "a tracked item billed straight to an expense account moves no stock",
      hasLine(entryD, "5800", "debit", "100.00") &&
        !hasLine(entryD, "1200", "debit", "100.00") &&
        mainAfterD?.qty === 16,
      `${JSON.stringify(entryD)} qty ${mainAfterD?.qty}`,
    );

    /* ── The refusals that protect the valuation ─────────────────────────── */
    const untracked = await post("/api/v1/inventory/adjustments", {
      item_id: service.id,
      date: "2026-09-20",
      qty_delta: -1,
      reason: "Should not be allowed",
    });
    check(
      "an adjustment for an item that is not stock-tracked is refused (422)",
      untracked.status === 422 && untracked.body.error?.code === "ITEM_NOT_TRACKED",
      `${untracked.status} ${untracked.body.error?.code}`,
    );

    const noCost = await post("/api/v1/inventory/adjustments", {
      item_id: box.id,
      date: "2026-09-20",
      qty_delta: 5,
      reason: "Found some boxes",
    });
    check(
      "stock found with nothing on the book and no unit cost is refused (422)",
      noCost.status === 422 && noCost.body.error?.code === "UNIT_COST_REQUIRED",
      `${noCost.status} ${noCost.body.error?.code}`,
    );

    const sameWarehouse = await post("/api/v1/inventory/transfers", {
      item_id: rice.id,
      from_warehouse_id: main!.id,
      to_warehouse_id: main!.id,
      date: "2026-09-20",
      qty: 1,
    });
    check(
      "a transfer to the warehouse the goods are already in is refused (422)",
      sameWarehouse.status === 422 && sameWarehouse.body.error?.code === "SAME_WAREHOUSE",
      `${sameWarehouse.status} ${sameWarehouse.body.error?.code}`,
    );

    /* ── The readings the screen shows ───────────────────────────────────── */
    const stockView = (await get("/api/v1/inventory/stock")).body.data as {
      balances: BalanceRow[];
      low_stock: { sku: string; on_hand: number }[];
      summary: { total_value_bdt: string; total_qty: number; low_stock_count: number };
    };
    // 16 at Main + 3 at Second Store, read as one item's position — an item is
    // short when the business is short of it, not when one shelf of it is.
    check(
      "the low-stock list reads the quantity across every warehouse (19 ≤ 20)",
      stockView.low_stock.some((row) => row.sku === "RICE-1KG" && row.on_hand === 19),
      JSON.stringify(stockView.low_stock),
    );
    // Ledger and shelf must agree before the movement ledger is even read:
    // 2400.00 at Main + 450.00 at Second Store.
    check(
      "the stock summary values the shelves at 2850.00",
      stockView.summary.total_value_bdt === "2850.00",
      stockView.summary.total_value_bdt,
    );

    const movements = (await get("/api/v1/inventory/movements?limit=200")).body.data.movements as {
      direction: string;
      source: string;
      item_id: string;
      qty: number;
      value_bdt: string;
      reversed: boolean;
    }[];
    const sources = new Set(movements.map((row) => row.source));
    check(
      "the movement ledger explains every change — receipts, sales, adjustments, transfers and counts",
      ["BILL", "INVOICE", "ADJUSTMENT", "TRANSFER", "STOCKTAKE"].every((source) => sources.has(source)),
      [...sources].join(", "),
    );
    check(
      "a reversed movement is marked rather than removed, and keeps its own value",
      movements.some((row) => row.reversed === true && row.source === "BILL" && row.value_bdt === "200.00"),
      JSON.stringify(movements.filter((row) => row.reversed).map((row) => `${row.source}:${row.value_bdt}`)),
    );
    // Two receipts, a sale, the two legs of a transfer, a write-off, a write-on,
    // a count that short, and the sale's reversal: nine movements of rice. (The
    // two legs of the permission-test transfer and its undo happen after this
    // reading, and are counted by the checks above them.)
    check(
      "the rice movements are the ones the arithmetic above predicts (9)",
      movements.filter((row) => row.item_id === rice.id).length === 9,
      `${movements.filter((row) => row.item_id === rice.id).length} movements`,
    );

    /* ── Permissions: reading is everyone's, adjusting is not ────────────── */
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "VIEWER" } });
    check("a VIEWER may read stock", (await get("/api/v1/inventory/stock")).status === 200);
    check("a VIEWER may read the movement ledger", (await get("/api/v1/inventory/movements")).status === 200);
    const viewerWarehouse = await post("/api/v1/inventory/warehouses", { code: "NOPE", name: "Should not exist" });
    check(
      "a VIEWER cannot create a warehouse (403)",
      viewerWarehouse.status === 403,
      `status ${viewerWarehouse.status}`,
    );
    const viewerTransfer = await post("/api/v1/inventory/transfers", {
      item_id: rice.id,
      from_warehouse_id: main!.id,
      to_warehouse_id: store2.id,
      date: "2026-09-21",
      qty: 1,
    });
    check("a VIEWER cannot transfer stock (403)", viewerTransfer.status === 403, `status ${viewerTransfer.status}`);
    const viewerAdjust = await post("/api/v1/inventory/adjustments", {
      item_id: rice.id,
      date: "2026-09-21",
      qty_delta: -1,
      reason: "Should not be allowed",
    });
    check("a VIEWER cannot adjust stock (403)", viewerAdjust.status === 403, `status ${viewerAdjust.status}`);
    const viewerCount = await post("/api/v1/inventory/stocktakes", {
      date: "2026-09-21",
      lines: [{ item_id: rice.id, counted_qty: 16 }],
    });
    check("a VIEWER cannot draw up a count (403)", viewerCount.status === 403, `status ${viewerCount.status}`);
    const viewerPost = await post(`/api/v1/inventory/stocktakes/${agreed.id}/post`, { reason: "Should not be allowed" });
    check("a VIEWER cannot post a variance (403)", viewerPost.status === 403, `status ${viewerPost.status}`);

    // An ACCOUNTANT may record movements but not move the balance sheet's value
    // without a document: `inventory.adjust` is the owner's signature.
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "ACCOUNTANT" } });
    const accountantTransfer = await post("/api/v1/inventory/transfers", {
      item_id: rice.id,
      from_warehouse_id: main!.id,
      to_warehouse_id: store2.id,
      date: "2026-09-21",
      qty: 1,
    });
    check(
      "an ACCOUNTANT may move stock between warehouses",
      accountantTransfer.status === 201,
      `status ${accountantTransfer.status} ${JSON.stringify(accountantTransfer.body.error)}`,
    );
    const accountantAdjust = await post("/api/v1/inventory/adjustments", {
      item_id: rice.id,
      date: "2026-09-21",
      qty_delta: 1,
      unit_cost_bdt: "150.00",
      reason: "Should not be allowed",
    });
    check(
      "an ACCOUNTANT cannot adjust stock — that is the owner's signature (403)",
      accountantAdjust.status === 403,
      `status ${accountantAdjust.status}`,
    );

    // Undo the accountant's transfer so the figures below are the ones the
    // arithmetic above predicts.
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "OWNER" } });
    const backAgain = (
      await post("/api/v1/inventory/transfers", {
        item_id: rice.id,
        from_warehouse_id: store2.id,
        to_warehouse_id: main!.id,
        date: "2026-09-21",
        qty: 1,
        memo: "Undo the permission test",
      })
    ).body.data.transfer;
    check("the test transfer is undone, so the shelves read what the sums say", backAgain?.qty === 1);

    const postedAgreed = (
      await post(`/api/v1/inventory/stocktakes/${agreed.id}/post`, { reason: "Count agreed" })
    ).body.data.stocktake;
    check(
      "a count that found exactly what the book said posts nothing and still records that it happened",
      postedAgreed?.status === "POSTED" && postedAgreed?.journal_entry_id === null,
      `${postedAgreed?.status} ${postedAgreed?.journal_entry_id}`,
    );

    /* ── The phase's exit gate ───────────────────────────────────────────── */
    const report = await runIntegrityChecks();
    const stock = report.checks.find((row) => row.id === "I5-STOCK");
    check(
      "I5 holds for stock — the inventory control account equals the stock ledger's valuation",
      stock?.status === "pass",
      `${stock?.status}: ${stock?.findings.join("; ")}`,
    );
    const moneyFormat = report.checks.find((row) => row.id === "P0-MONEY-FORMAT");
    check(
      "the stock collections keep canonical money strings",
      moneyFormat?.status === "pass",
      JSON.stringify(moneyFormat?.findings),
    );
    check(
      "no integrity check fails",
      report.checks.every((row) => row.status !== "fail"),
      report.checks
        .filter((row) => row.status === "fail")
        .map((row) => row.id)
        .join(", "),
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
          // The stock ledger (P8). Balances, movements and counts are all keyed
          // by org, and a leftover balance row is exactly what would make
          // I5-STOCK report a deleted organisation as out by its own valuation.
          StocktakeModel.deleteMany({ org_id: id }),
          StockMovementModel.deleteMany({ org_id: id }),
          StockBalanceModel.deleteMany({ org_id: id }),
          WarehouseModel.deleteMany({ org_id: id }),
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
