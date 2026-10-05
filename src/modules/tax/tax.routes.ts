/**
 * Tax routes (plan §6, Phase 7).
 *
 * One router under `/api/v1/tax` because the four things here are one workflow:
 * read what a month's tax came to, see what is still withheld and undeposited,
 * pay it over on a challan, and give the supplier the certificate they will
 * claim it with.
 *
 * READ VS WRITE follows `tax.read` / `tax.write`, and exporting follows
 * `tax.export` — the same three-line distinction the reports module draws, and
 * for the same reason: a return on a screen and a return as a file that leaves
 * the building are not the same act.
 *
 * Note what is *not* here. There is no endpoint that files a return, and none
 * that sets what tax a document owed: the first has no ledger consequence to
 * record, and the second is already on the document's lines. What this module
 * can do is read the tax those lines produced and move the withheld part to the
 * government, both through the ordinary posting engine.
 */
import { Router } from "express";

import {
  CreateCertificateSchema,
  CreateChallanSchema,
  ListTaxDocumentsQuery,
  VatReturnQuery,
  createChallan,
  issueCertificate,
  listCertificates,
  listChallans,
  vatReturn,
  vatReturnRows,
  withholdingRegister,
} from "./tax.service.js";
import { CsvWriter } from "../reports/csv.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const taxRouter = Router();

taxRouter.use(authenticate, attachContext);

/** The VAT return for one fiscal month. */
taxRouter.get(
  "/vat-return",
  requirePermission("tax.read"),
  handle(async (request, response) => {
    const query = parseInput(VatReturnQuery, request.query);
    ok(response, { vat_return: await vatReturn(request.context!.orgId, query.month) });
  }),
);

/**
 * The same return as a file.
 *
 * Rows are written through `CsvWriter` as they are produced, so the export
 * streams and sets no Content-Length — plan D7, and the reason there is no
 * `rows.map(...).join()` anywhere in this file.
 */
taxRouter.get(
  "/vat-return/export",
  requirePermission("tax.export"),
  handle(async (request, response) => {
    const query = parseInput(VatReturnQuery, request.query);
    const view = await vatReturn(request.context!.orgId, query.month);

    const columns = [
      { key: "side", label: "Side" },
      { key: "tax_code", label: "Tax code" },
      { key: "rate_percent", label: "Rate %" },
      { key: "net_bdt", label: "Net" },
      { key: "tax_bdt", label: "Tax (books)" },
      { key: "declared_bdt", label: "Declared (taka)" },
    ];

    const writer = new CsvWriter(response, `vat-return-${query.month}.csv`);
    await writer.header(columns);
    for (const row of vatReturnRows(view)) {
      await writer.row(columns, row);
    }
    response.end();
  }),
);

/** Every withholding taken, with what is still undeposited. */
taxRouter.get(
  "/withholding",
  requirePermission("tax.read"),
  handle(async (request, response) => {
    const query = parseInput(ListTaxDocumentsQuery, request.query);
    ok(response, { register: await withholdingRegister(request.context!.orgId, query) });
  }),
);

/** The same register as a file, for the tax office. */
taxRouter.get(
  "/withholding/export",
  requirePermission("tax.export"),
  handle(async (request, response) => {
    const query = parseInput(ListTaxDocumentsQuery, request.query);
    const register = await withholdingRegister(request.context!.orgId, query);

    const columns = [
      { key: "doc_no", label: "Payment" },
      { key: "date", label: "Date" },
      { key: "party_name", label: "Supplier" },
      { key: "tax_code", label: "Tax code" },
      { key: "tax_rate_snapshot", label: "Rate %" },
      { key: "amount_bdt", label: "Withheld" },
      { key: "certified", label: "Certified" },
    ];

    const writer = new CsvWriter(response, `withholding-${new Date().toISOString().slice(0, 10)}.csv`);
    await writer.header(columns);
    for (const row of register.rows) {
      await writer.row(columns, { ...row, certified: row.certified ? "yes" : "no" });
    }
    response.end();
  }),
);

/* ── Challans ────────────────────────────────────────────────────────────── */

taxRouter.get(
  "/challans",
  requirePermission("tax.read"),
  handle(async (request, response) => {
    const query = parseInput(ListTaxDocumentsQuery, request.query);
    ok(response, { challans: await listChallans(request.context!.orgId, query) });
  }),
);

taxRouter.post(
  "/challans",
  requirePermission("tax.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateChallanSchema, request.body);
    const context = request.context!;
    ok(response, { challan: await createChallan(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

/* ── Certificates ────────────────────────────────────────────────────────── */

taxRouter.get(
  "/certificates",
  requirePermission("tax.read"),
  handle(async (request, response) => {
    const query = parseInput(ListTaxDocumentsQuery, request.query);
    ok(response, { certificates: await listCertificates(request.context!.orgId, query) });
  }),
);

taxRouter.post(
  "/certificates",
  requirePermission("tax.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateCertificateSchema, request.body);
    const context = request.context!;
    ok(response, { certificate: await issueCertificate(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);
