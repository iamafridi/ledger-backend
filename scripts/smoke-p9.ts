/**
 * Phase 9 smoke — fixed assets, run in-process against the real app and the real
 * database on a throwaway org, which is deleted at the end.
 *
 *   npx tsx scripts/smoke-p9.ts
 *
 * The point of this script is the phase's exit gate: **cost − accumulated
 * depreciation = net book value = the ledger's position**, to the paisa, after
 * enough activity that the equality is worth something — three assets bought at
 * different prices and lives, a prorated first month, a run, a double run, a
 * reversal and a re-run, a closed period, a capitalised bill registered after the
 * fact, a mid-month disposal with its own stub charge, a voided disposal
 * re-disposed, and a second asset scrapped at a gain.
 *
 * Every figure below is hand-checkable, and the arithmetic is in the comments.
 *
 * Exit 0 = every check passed.
 */
// Must be first: pins the JWKS URL before any src module (and its cached
// environment) can load.
import "./smoke-p9-env.js";
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

/* ── Token minting (the same recipe as the Phase 5–8 smokes) ─────────────── */
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWKS_PORT = 4575;
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

interface AssetRow {
  id: string;
  code: string;
  name: string;
  cost_bdt: string;
  salvage_bdt: string;
  useful_life_months: number;
  useful_life_label: string;
  monthly_charge_bdt: string;
  depreciable_base_bdt: string;
  accumulated_depreciation_bdt: string;
  net_book_value_bdt: string;
  remaining_bdt: string;
  fully_depreciated: boolean;
  acquired_via: "POSTED" | "REGISTERED";
  journal_entry_id: string | null;
  last_depreciated_period: string;
  status: "ACTIVE" | "DISPOSED";
  disposal: { nbv_bdt: string; gain_bdt: string; loss_bdt: string; journal_entry_id: string | null } | null;
}

interface RegisterSummary {
  asset_count: number;
  disposed_count: number;
  total_cost_bdt: string;
  total_accumulated_bdt: string;
  total_net_book_value_bdt: string;
  fully_depreciated_count: number;
}

interface RunLine {
  asset_id: string;
  code: string;
  amount_bdt: string;
  accum_before_bdt: string;
  accum_after_bdt: string;
  nbv_after_bdt: string;
  days_charged: number;
  days_in_month: number;
  prorated: boolean;
  final: boolean;
}

interface Preview {
  period_key: string;
  period_status: "OPEN" | "CLOSED" | "MISSING";
  postable: boolean;
  blocked_reason: string;
  lines: RunLine[];
  skipped: { code: string; reason: string }[];
  total_bdt: string;
  eligible_count: number;
  already_run_count: number;
}

async function register(): Promise<{ assets: AssetRow[]; summary: RegisterSummary }> {
  return (await get("/api/v1/assets")).body.data as { assets: AssetRow[]; summary: RegisterSummary };
}

async function assetByCode(code: string): Promise<AssetRow | undefined> {
  return (await register()).assets.find((row) => row.code === code);
}

async function preview(period: string): Promise<Preview> {
  return (await get(`/api/v1/assets/depreciation/preview?period=${period}`)).body.data.preview as Preview;
}

interface DisposalResult {
  asset: AssetRow;
  stub_period: string | null;
  stub_amount_bdt: string;
  journal_entry_id: string;
  gain_bdt: string;
  loss_bdt: string;
}

async function main(): Promise<void> {
  Object.assign(CACHED_JWK, await exportJWK(publicKey));
  await new Promise<void>((resolve) => jwksServer.listen(JWKS_PORT, resolve));

  const environment = getEnvironment();
  await connectDatabase();
  console.log("Phase 9 smoke — the fixed-asset register, depreciation and disposal\n");

  const uid = `smoke-p9-${Date.now()}`;
  authorization = `Bearer ${await mintToken(uid, environment.FIREBASE_PROJECT_ID)}`;

  const first = await get("/api/v1/auth/me");
  const orgId = first.body.data?.org as string;
  check("signup bootstraps an org with OWNER context", first.status === 200 && Boolean(orgId));

  try {
    const empty = await register();
    check(
      "a fresh ledger has an empty register",
      empty.assets.length === 0 && empty.summary.total_cost_bdt === "0.00",
      JSON.stringify(empty.summary),
    );

    const supplier = (
      await post("/api/v1/parties", { code: "SUPP", name: "Smoke Supplier", kind: "SUPPLIER" })
    ).body.data.party;
    check("supplier created", Boolean(supplier?.id));

    /* ── A. Three assets, two bought outright ────────────────────────────── */
    //
    //   MACHINE  cost 120,000.00, salvage 12,000.00, 60 months
    //            → base 108,000.00, monthly 1,800.00, bought 2026-09-01
    //   DEVICE   cost  24,000.00, salvage      0.00, 12 months
    //            → base  24,000.00, monthly 2,000.00, bought 2026-09-16
    //   SHORT    cost   1,200.00, salvage      0.00,  1 month
    //            → base   1,200.00, monthly 1,200.00, bought 2026-09-01
    const machine = (
      await post("/api/v1/assets", {
        code: "MACHINE",
        name: "Rice milling machine",
        category: "Plant",
        purchase_date: "2026-09-01",
        cost_bdt: "120000.00",
        salvage_bdt: "12000.00",
        useful_life_months: 60,
        acquisition: { credit_account_code: "1010", memo: "Bank transfer" },
      })
    ).body.data.asset as AssetRow;
    check(
      "a direct acquisition posts DR 1500 / CR the account the money came from",
      Boolean(machine?.id) &&
        machine.acquired_via === "POSTED" &&
        Boolean(machine.journal_entry_id),
      JSON.stringify({ id: machine?.id, via: machine?.acquired_via }),
    );

    const machineEntry = await entryLines(machine.journal_entry_id!);
    check(
      "the acquisition entry is the cost, nothing more",
      machineEntry.length === 2 &&
        hasLine(machineEntry, "1500", "debit", "120000.00") &&
        hasLine(machineEntry, "1010", "credit", "120000.00"),
      JSON.stringify(machineEntry),
    );

    const device = (
      await post("/api/v1/assets", {
        code: "DEVICE",
        name: "Delivery device",
        category: "Equipment",
        purchase_date: "2026-09-16",
        cost_bdt: "24000.00",
        useful_life_months: 12,
        acquisition: { credit_account_code: "1000" },
      })
    ).body.data.asset as AssetRow;

    const short = (
      await post("/api/v1/assets", {
        code: "SHORT",
        name: "Small tooling set",
        purchase_date: "2026-09-01",
        cost_bdt: "1200.00",
        useful_life_months: 1,
        acquisition: { credit_account_code: "1000" },
      })
    ).body.data.asset as AssetRow;
    check("three assets registered", Boolean(device?.id && short?.id));

    check(
      "the schedule is derived server-side: base, monthly charge and life label",
      machine.depreciable_base_bdt === "108000.00" &&
        machine.monthly_charge_bdt === "1800.00" &&
        machine.useful_life_label === "5 years" &&
        device.monthly_charge_bdt === "2000.00" &&
        short.useful_life_label === "1 month",
      JSON.stringify({
        base: machine.depreciable_base_bdt,
        monthly: machine.monthly_charge_bdt,
        label: machine.useful_life_label,
      }),
    );

    const afterBuy = await register();
    check(
      "the register totals 145,200.00 of cost, none of it yet written down",
      afterBuy.summary.total_cost_bdt === "145200.00" &&
        afterBuy.summary.total_accumulated_bdt === "0.00" &&
        afterBuy.summary.total_net_book_value_bdt === "145200.00" &&
        afterBuy.summary.asset_count === 3,
      JSON.stringify(afterBuy.summary),
    );

    /* ── B. Preview September: full month, a prorated one, and a final one ── */
    //   1,800.00 + 1,000.00 + 1,200.00 = 4,000.00
    const previewSep = await preview("2026-09");
    const deviceSep = previewSep.lines.find((line) => line.code === "DEVICE");
    const shortSep = previewSep.lines.find((line) => line.code === "SHORT");
    check(
      "the first month is prorated by the days the asset was in service",
      deviceSep?.amount_bdt === "1000.00" &&
        deviceSep?.days_charged === 15 &&
        deviceSep?.days_in_month === 30 &&
        deviceSep?.prorated === true,
      JSON.stringify(deviceSep),
    );
    check(
      "an asset bought on the first of the month takes a full month, with no special case",
      previewSep.lines.find((line) => line.code === "MACHINE")?.prorated === false &&
        previewSep.lines.find((line) => line.code === "MACHINE")?.amount_bdt === "1800.00",
    );
    check(
      "a one-month life is charged in full, once, and marked as the last charge",
      shortSep?.amount_bdt === "1200.00" && shortSep?.final === true && shortSep?.prorated === false,
      JSON.stringify(shortSep),
    );
    check(
      "the preview totals 4,000.00 for September and says it is postable",
      previewSep.total_bdt === "4000.00" && previewSep.eligible_count === 3 && previewSep.postable === true,
      JSON.stringify({ total: previewSep.total_bdt, eligible: previewSep.eligible_count }),
    );

    /* ── C. Run September ────────────────────────────────────────────────── */
    const runSep = (await post("/api/v1/assets/depreciation/run", { period: "2026-09" })).body.data.run as {
      batch_id: string;
      journal_entry_id: string;
      total_bdt: string;
      asset_count: number;
    };
    check(
      "the run posts one entry for the batch: DR 5400 / CR 1510",
      runSep?.asset_count === 3 && runSep.total_bdt === "4000.00",
      JSON.stringify(runSep),
    );

    const sepEntry = await entryLines(runSep.journal_entry_id);
    check(
      "the depreciation entry is the charge, on both sides",
      sepEntry.length === 2 &&
        hasLine(sepEntry, "5400", "debit", "4000.00") &&
        hasLine(sepEntry, "1510", "credit", "4000.00"),
      JSON.stringify(sepEntry),
    );

    const afterSep = await register();
    check(
      "the register now shows 4,000.00 written off and 141,200.00 of book value",
      afterSep.summary.total_accumulated_bdt === "4000.00" &&
        afterSep.summary.total_net_book_value_bdt === "141200.00" &&
        afterSep.assets.find((row) => row.code === "SHORT")?.fully_depreciated === true,
      JSON.stringify(afterSep.summary),
    );

    /* ── D. Running the same month again refuses ─────────────────────────── */
    const rerunSep = await post("/api/v1/assets/depreciation/run", { period: "2026-09" });
    check(
      "re-running a month posts nothing (409 NOTHING_TO_DEPRECIATE)",
      rerunSep.status === 409 && rerunSep.body.error?.code === "NOTHING_TO_DEPRECIATE",
      `status ${rerunSep.status} ${rerunSep.body.error?.code}`,
    );
    const previewSepAgain = await preview("2026-09");
    check(
      "the preview reports every asset as already charged for that month",
      previewSepAgain.already_run_count === 3 &&
        previewSepAgain.eligible_count === 0 &&
        previewSepAgain.postable === false,
      JSON.stringify({ already: previewSepAgain.already_run_count, eligible: previewSepAgain.eligible_count }),
    );

    /* ── E. October: the short-lived asset is done ───────────────────────── */
    //   1,800.00 + 2,000.00 = 3,800.00
    const previewOct = await preview("2026-10");
    check(
      "a fully written-down asset is skipped, by name and by reason",
      previewOct.skipped.some((row) => row.code === "SHORT" && row.reason === "FULLY_DEPRECIATED") &&
        previewOct.total_bdt === "3800.00",
      JSON.stringify(previewOct.skipped),
    );

    const runOct = (await post("/api/v1/assets/depreciation/run", { period: "2026-10" })).body.data.run as {
      batch_id: string;
      total_bdt: string;
    };
    check("October charges 3,800.00 across two assets", runOct?.total_bdt === "3800.00");

    /* ── F. Reverse October, then re-run it ──────────────────────────────── */
    const reverseOct = await post(`/api/v1/assets/depreciation/batches/${runOct.batch_id}/reverse`, {
      reason: "Wrong month — correcting the schedule",
    });
    check(
      "a batch reverses as one voided entry (the mirror of the run)",
      reverseOct.status === 200 && reverseOct.body.data.reversal.total_bdt === "3800.00",
      `status ${reverseOct.status}`,
    );
    const octReversal = await entryLines(reverseOct.body.data.reversal.reversal_entry_id);
    check(
      "the reversal is the run inside out: DR 1510 / CR 5400",
      octReversal.length === 2 &&
        hasLine(octReversal, "1510", "debit", "3800.00") &&
        hasLine(octReversal, "5400", "credit", "3800.00"),
      JSON.stringify(octReversal),
    );

    const afterReverse = await register();
    check(
      "reversing a run rolls the accumulated figure back to where it was",
      afterReverse.summary.total_accumulated_bdt === "4000.00" &&
        afterReverse.assets.find((row) => row.code === "MACHINE")?.accumulated_depreciation_bdt === "1800.00" &&
        afterReverse.assets.find((row) => row.code === "MACHINE")?.last_depreciated_period === "2026-09",
      JSON.stringify(afterReverse.summary),
    );

    const runOctAgain = (await post("/api/v1/assets/depreciation/run", { period: "2026-10" })).body.data.run as {
      batch_id: string;
      total_bdt: string;
    };
    check(
      "October can be posted again after the reversal — the index is partial on POSTED",
      runOctAgain?.total_bdt === "3800.00" && runOctAgain.batch_id !== runOct.batch_id,
    );

    const batchesOct = (
      await get("/api/v1/assets/depreciation/batches")
    ).body.data.batches as { batch_id: string; period_key: string; status: string; total_bdt: string }[];
    check(
      "the history keeps both October runs, one reversed and one posted",
      batchesOct.filter((row) => row.period_key === "2026-10").length === 2 &&
        batchesOct.some((row) => row.period_key === "2026-10" && row.status === "REVERSED") &&
        batchesOct.some((row) => row.period_key === "2026-10" && row.status === "POSTED"),
      JSON.stringify(batchesOct),
    );

    const runsForMachine = (
      await get(`/api/v1/assets/depreciation/runs?asset_id=${machine.id}`)
    ).body.data.runs as { period_key: string; status: string }[];
    check(
      "one asset's charge history is readable, reversal and all",
      runsForMachine.filter((row) => row.status === "POSTED").length === 2 &&
        runsForMachine.filter((row) => row.status === "REVERSED").length === 1,
      JSON.stringify(runsForMachine),
    );

    /* ── G. A closed period is blocked ───────────────────────────────────── */
    await post("/api/v1/periods/close", { key: "2026-12", note: "Smoke close" });
    const closedPreview = await preview("2026-12");
    const closedRun = await post("/api/v1/assets/depreciation/run", { period: "2026-12" });
    check(
      "a closed period is refused before anything is computed or posted",
      closedPreview.period_status === "CLOSED" &&
        closedPreview.postable === false &&
        closedPreview.blocked_reason.includes("closed") &&
        closedRun.status === 422 &&
        closedRun.body.error?.code === "PERIOD_CLOSED",
      `preview ${closedPreview.period_status} / run ${closedRun.status} ${closedRun.body.error?.code}`,
    );
    await post("/api/v1/periods/reopen", { key: "2026-12" });

    const missingRun = await post("/api/v1/assets/depreciation/run", { period: "2031-01" });
    check(
      "a month with no accounting period says so instead of failing obscurely",
      missingRun.status === 422 && missingRun.body.error?.code === "PERIOD_MISSING",
      `status ${missingRun.status} ${missingRun.body.error?.code}`,
    );

    /* ── H. A bill capitalises 1500, and the register notices ────────────── */
    //   The bill puts 50,000.00 into 1500 with nothing registered behind it, so
    //   the tie-out has to *fail* — and name both figures. This is the check
    //   earning its keep rather than passing because nothing happened.
    const vanBillDraft = (
      await post("/api/v1/purchases/bills", {
        party_id: supplier.id,
        date: "2026-09-20",
        memo: "Delivery van",
        lines: [{ description: "Delivery van", qty: 1, unit_price_bdt: "50000.00", account_code: "1500" }],
      })
    ).body.data.bill;
    const vanBill = (await post(`/api/v1/purchases/bills/${vanBillDraft.id}/issue`, {})).body.data.bill;
    const billEntry = await entryLines(vanBill.journal_entry_id);
    check(
      "a purchase line naming 1500 capitalises instead of being refused",
      Boolean(vanBill?.journal_entry_id) &&
        billEntry.some((line) => line.account_code === "1500" && line.debit_bdt === "50000.00"),
      JSON.stringify(billEntry),
    );

    const broken = await runIntegrityChecks();
    const brokenCheck = broken.checks.find((row) => row.id === "I5-FIXED-ASSETS");
    check(
      "a capitalised bill nobody registered makes the tie-out fail, naming both figures",
      brokenCheck?.status === "fail" &&
        brokenCheck.findings.some((row) => row.includes("1500") && row.includes("195200.00")),
      JSON.stringify(brokenCheck?.findings),
    );

    /* ── I. Register what the bill bought — no second posting ────────────── */
    const van = (
      await post("/api/v1/assets", {
        code: "VAN",
        name: "Delivery van",
        category: "Vehicles",
        purchase_date: "2026-09-01",
        cost_bdt: "50000.00",
        salvage_bdt: "5000.00",
        useful_life_months: 45,
        source_doc_no: vanBill.doc_no,
      })
    ).body.data.asset as AssetRow;
    check(
      "an asset registered against somebody else's posting does not post again",
      van?.acquired_via === "REGISTERED" && van.journal_entry_id === null && van.monthly_charge_bdt === "1000.00",
      JSON.stringify({ via: van?.acquired_via, entry: van?.journal_entry_id }),
    );

    const healed = await runIntegrityChecks();
    check(
      "registering it repairs the tie-out with no new journal entry",
      healed.checks.find((row) => row.id === "I5-FIXED-ASSETS")?.status === "pass",
      JSON.stringify(healed.checks.find((row) => row.id === "I5-FIXED-ASSETS")?.findings),
    );

    /* ── J. Re-running September charges only what is missing ────────────── */
    const sepCatchUp = await preview("2026-09");
    check(
      "a late-registered asset is what is still due for the month",
      sepCatchUp.eligible_count === 1 &&
        sepCatchUp.lines[0]?.code === "VAN" &&
        sepCatchUp.total_bdt === "1000.00" &&
        sepCatchUp.already_run_count === 3,
      JSON.stringify({ eligible: sepCatchUp.eligible_count, already: sepCatchUp.already_run_count }),
    );
    await post("/api/v1/assets/depreciation/run", { period: "2026-09" });
    const afterCatchUp = await register();
    check(
      "the catch-up charged the van and left the other three alone",
      afterCatchUp.assets.find((row) => row.code === "VAN")?.accumulated_depreciation_bdt === "1000.00" &&
        afterCatchUp.assets.find((row) => row.code === "MACHINE")?.accumulated_depreciation_bdt === "3600.00",
      JSON.stringify(afterCatchUp.summary),
    );

    /* ── K. Dispose the DEVICE mid-month ────────────────────────────────── */
    //   Its own month is charged first: 2,000.00 × 10/30 = 666.67.
    //   accum 1,000.00 + 2,000.00 + 666.67 = 3,666.67, NBV 20,333.33.
    //   Sold for 20,000.00 → a loss of 333.33.
    const deviceDisposal = (
      await post(`/api/v1/assets/${device.id}/dispose`, {
        date: "2026-11-10",
        proceeds_bdt: "20000.00",
        proceeds_account_code: "1000",
        reason: "Sold to a neighbouring shop",
      })
    ).body.data.disposal as DisposalResult;

    check(
      "a disposal charges its own month up to the day the asset left",
      deviceDisposal?.stub_period === "2026-11" && deviceDisposal.stub_amount_bdt === "666.67",
      JSON.stringify({ period: deviceDisposal?.stub_period, amount: deviceDisposal?.stub_amount_bdt }),
    );
    check(
      "proceeds below the book value post a loss, and nothing posts as a gain",
      deviceDisposal.loss_bdt === "333.33" && deviceDisposal.gain_bdt === "0.00",
      JSON.stringify({ gain: deviceDisposal.gain_bdt, loss: deviceDisposal.loss_bdt }),
    );

    const disposalEntry = await entryLines(deviceDisposal.journal_entry_id);
    check(
      "the disposal entry clears the cost and the write-down, takes the proceeds and posts the loss",
      hasLine(disposalEntry, "1510", "debit", "3666.67") &&
        hasLine(disposalEntry, "1000", "debit", "20000.00") &&
        hasLine(disposalEntry, "5800", "debit", "333.33") &&
        hasLine(disposalEntry, "1500", "credit", "24000.00"),
      JSON.stringify(disposalEntry),
    );
    check(
      "the asset reports what it fetched against what it was worth",
      deviceDisposal.asset.status === "DISPOSED" &&
        deviceDisposal.asset.disposal?.nbv_bdt === "20333.33" &&
        deviceDisposal.asset.disposal?.loss_bdt === "333.33",
      JSON.stringify(deviceDisposal.asset.disposal),
    );

    /* ── L. A fully written-down asset scrapped at a gain ───────────────── */
    //   accum 1,200.00 = cost, so nothing more is charged; 500.00 of proceeds
    //   against a book value of zero is a 500.00 gain.
    const shortDisposal = (
      await post(`/api/v1/assets/${short.id}/dispose`, {
        date: "2026-11-15",
        proceeds_bdt: "500.00",
        reason: "Scrapped, sold for parts",
      })
    ).body.data.disposal as DisposalResult;
    check(
      "a fully written-down asset is charged nothing more, and disposes at a gain",
      shortDisposal.stub_amount_bdt === "0.00" &&
        shortDisposal.gain_bdt === "500.00" &&
        shortDisposal.loss_bdt === "0.00",
      JSON.stringify({ stub: shortDisposal.stub_amount_bdt, gain: shortDisposal.gain_bdt }),
    );

    const reverseDisposed = await post(`/api/v1/assets/depreciation/batches/${runOctAgain.batch_id}/reverse`, {
      reason: "Should not be possible",
    });
    check(
      "a run behind a disposed asset cannot be reversed out from under the disposal (409)",
      reverseDisposed.status === 409 && reverseDisposed.body.error?.code === "ASSET_DISPOSED",
      `status ${reverseDisposed.status} ${reverseDisposed.body.error?.code}`,
    );

    /* ── M. Undo a disposal, then dispose again ─────────────────────────── */
    const undone = await post(`/api/v1/assets/${device.id}/disposal/void`, {
      reason: "The sale fell through",
    });
    check(
      "undoing a disposal puts the asset back with its write-down intact",
      undone.status === 200 &&
        undone.body.data.asset.status === "ACTIVE" &&
        undone.body.data.asset.accumulated_depreciation_bdt === "3666.67" &&
        undone.body.data.asset.net_book_value_bdt === "20333.33",
      `status ${undone.status} ${JSON.stringify(undone.body.data?.asset?.accumulated_depreciation_bdt)}`,
    );

    const resold = (
      await post(`/api/v1/assets/${device.id}/dispose`, {
        date: "2026-11-20",
        proceeds_bdt: "22000.00",
        reason: "Resold at the agreed price",
      })
    ).body.data.disposal as DisposalResult;
    check(
      "re-disposing in the same month charges no second stub — the month is already run",
      resold.stub_amount_bdt === "0.00" && resold.gain_bdt === "1666.67",
      JSON.stringify({ stub: resold.stub_amount_bdt, gain: resold.gain_bdt }),
    );
    const resoldEntry = await entryLines(resold.journal_entry_id);
    check(
      "the second disposal still clears the same cost and write-down",
      hasLine(resoldEntry, "1510", "debit", "3666.67") &&
        hasLine(resoldEntry, "1500", "credit", "24000.00") &&
        hasLine(resoldEntry, "4100", "credit", "1666.67"),
      JSON.stringify(resoldEntry),
    );

    /* ── N. November: the stub is already charged, the rest is due ──────── */
    //   1,800.00 (machine) + 1,000.00 (van) = 2,800.00
    const previewNov = await preview("2026-11");
    check(
      "the disposed assets are skipped with the reason they are gone",
      previewNov.skipped.filter((row) => row.reason === "DISPOSED").length === 2 &&
        previewNov.total_bdt === "2800.00",
      JSON.stringify(previewNov.skipped),
    );
    const runNov = (await post("/api/v1/assets/depreciation/run", { period: "2026-11" })).body.data.run as {
      total_bdt: string;
      asset_count: number;
    };
    check("November charges 2,800.00 across the two assets still on the books", runNov?.total_bdt === "2800.00");

    /* ── O. The schedule ────────────────────────────────────────────────── */
    //   The machine has been written down 3 × 1,800.00 = 5,400.00 of its
    //   108,000.00 base, so 102,600.00 is left over 1,800.00 a month: 57 rows.
    const machineSchedule = (await get(`/api/v1/assets/${machine.id}/schedule`)).body.data as {
      history: { period_key: string; status: string }[];
      projected: { period_key: string; amount_bdt: string; nbv_after_bdt: string }[];
      projected_truncated: boolean;
    };
    check(
      "an asset's schedule projects the rest of its life from where it stands",
      machineSchedule.projected.length === 57 &&
        machineSchedule.projected[0]?.period_key === "2026-12" &&
        machineSchedule.projected[0]?.amount_bdt === "1800.00" &&
        machineSchedule.projected[56]?.nbv_after_bdt === "12000.00" &&
        machineSchedule.projected_truncated === false,
      JSON.stringify({
        rows: machineSchedule.projected.length,
        first: machineSchedule.projected[0],
        last: machineSchedule.projected[56],
      }),
    );

    const deviceSchedule = (await get(`/api/v1/assets/${device.id}/schedule`)).body.data as {
      projected: unknown[];
      asset: AssetRow;
    };
    check(
      "an asset that has left the books has no future to project",
      deviceSchedule.asset.status === "DISPOSED" && deviceSchedule.projected.length === 0,
    );

    /* ── P. Permissions ─────────────────────────────────────────────────── */
    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "VIEWER" } });
    check("a VIEWER may read the register", (await get("/api/v1/assets")).status === 200);
    check("a VIEWER may read the depreciation preview", (await get("/api/v1/assets/depreciation/preview?period=2026-11")).status === 200);
    check(
      "a VIEWER cannot register an asset (403)",
      (
        await post("/api/v1/assets", {
          code: "NOPE",
          name: "Not allowed",
          purchase_date: "2026-09-01",
          cost_bdt: "100.00",
          useful_life_months: 12,
        })
      ).status === 403,
    );
    check(
      "a VIEWER cannot run depreciation (403)",
      (await post("/api/v1/assets/depreciation/run", { period: "2026-11" })).status === 403,
    );
    check(
      "a VIEWER cannot dispose of an asset (403)",
      (await post(`/api/v1/assets/${machine.id}/dispose`, { date: "2026-11-30", reason: "Not allowed" })).status === 403,
    );
    check(
      "a VIEWER cannot reverse a run (403)",
      (await post(`/api/v1/assets/depreciation/batches/${runOctAgain.batch_id}/reverse`, { reason: "Not allowed" }))
        .status === 403,
    );

    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "ACCOUNTANT" } });
    // A run for a month that is already fully charged: the permission let it
    // through and the month had nothing due, which is exactly the distinction
    // between 403 and 409.
    const accountantRun = await post("/api/v1/assets/depreciation/run", { period: "2026-09" });
    check(
      "an ACCOUNTANT may run depreciation (refused for having nothing to do, not for permission)",
      accountantRun.status === 409 && accountantRun.body.error?.code === "NOTHING_TO_DEPRECIATE",
      `status ${accountantRun.status} ${accountantRun.body.error?.code}`,
    );

    const extra = (
      await post("/api/v1/assets", {
        code: "EXTRA",
        name: "Office cabinet",
        purchase_date: "2026-12-01",
        cost_bdt: "1000.00",
        useful_life_months: 600,
        acquisition: { credit_account_code: "1000" },
      })
    ).body.data.asset as AssetRow;
    check("an ACCOUNTANT may register an asset", Boolean(extra?.id) && extra.acquired_via === "POSTED");

    // An account that is not of the type the field needs is refused, named.
    const wrongType = await post("/api/v1/assets", {
      code: "BADDEP",
      name: "Wrong expense account",
      purchase_date: "2026-12-01",
      cost_bdt: "100.00",
      useful_life_months: 12,
      dep_expense_account_code: "1500",
      acquisition: { credit_account_code: "1000" },
    });
    check(
      "an account of the wrong type is refused before the asset exists",
      wrongType.status === 422 && wrongType.body.error?.code === "ACCOUNT_WRONG_TYPE",
      `status ${wrongType.status} ${wrongType.body.error?.code}`,
    );

    await OrgMembershipModel.updateOne({ org_id: orgId }, { $set: { role: "OWNER" } });

    /* ── Q. The register and the ledger agree ───────────────────────────── */
    //   Live assets: MACHINE 120,000.00 + VAN 50,000.00 + EXTRA 1,000.00
    //   Written off: MACHINE 5,400.00 + VAN 2,000.00 = 7,400.00
    const finalRegister = await register();
    check(
      "the register's live assets cost 171,000.00 and 7,400.00 of it is written off",
      finalRegister.summary.total_cost_bdt === "171000.00" &&
        finalRegister.summary.total_accumulated_bdt === "7400.00" &&
        finalRegister.summary.total_net_book_value_bdt === "163600.00" &&
        finalRegister.summary.disposed_count === 2,
      JSON.stringify(finalRegister.summary),
    );

    const machineNow = await assetByCode("MACHINE");
    check(
      "the one asset still on the books throughout reads back correctly",
      machineNow?.status === "ACTIVE" &&
        machineNow.accumulated_depreciation_bdt === "5400.00" &&
        machineNow.net_book_value_bdt === "114600.00" &&
        machineNow.remaining_bdt === "102600.00",
      JSON.stringify(machineNow),
    );

    const report = await runIntegrityChecks();
    const fixedAssets = report.checks.find((row) => row.id === "I5-FIXED-ASSETS");
    check(
      "I5 holds for fixed assets: cost − accumulated = book value = the ledger",
      fixedAssets?.status === "pass",
      JSON.stringify(fixedAssets?.findings),
    );
    check(
      "the money-format check covers the new register and its runs",
      report.checks.find((row) => row.id === "P0-MONEY-FORMAT")?.status === "pass",
    );
    check(
      "no integrity check fails",
      report.checks.every((row) => row.status !== "fail"),
      report.checks
        .filter((row) => row.status === "fail")
        .map((row) => row.id)
        .join(", "),
    );

    // A last look at the tables themselves: every charge is a 2dp string and no
    // asset was ever charged into the negative.
    const storedRuns = await DepreciationRunModel.find({ org_id: orgId }).lean();
    check(
      "every stored charge is a canonical amount, and every one of them is positive",
      storedRuns.every((row) => /^\d+\.\d{2}$/.test(row.amount_bdt) && Number(row.amount_bdt) > 0),
      JSON.stringify(storedRuns.map((row) => row.amount_bdt).filter((value) => !/^\d+\.\d{2}$/.test(value))),
    );
    const storedAssets = await FixedAssetModel.find({ org_id: orgId }).lean();
    check(
      "no asset is written down past what it can be written down to",
      storedAssets.every(
        (row) =>
          Number(row.accumulated_depreciation_bdt) <=
          Number(row.cost_bdt) - Number(row.salvage_bdt),
      ),
      JSON.stringify(
        storedAssets.map((row) => `${row.code}:${row.accumulated_depreciation_bdt}/${row.cost_bdt}`),
      ),
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
          // The register (P9). A leftover run row points at an asset in a
          // deleted organisation, which is exactly what I5-FIXED-ASSETS reports
          // as a difference.
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
          // The stock ledger (P8) — added here too, because a phase's cleanup
          // list has to cover every collection the phases before it introduced.
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
