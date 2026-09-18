/**
 * Sales & AR routes (plan §6, Phase 3).
 *
 * Mounted as one router under `/api/v1/sales` because invoices, receipts and
 * credit notes are one workflow: a screen that takes a receipt has just been
 * looking at the invoices it settles, and splitting them across three mounts
 * would make the frontend's API surface describe our file layout instead of the
 * user's task.
 *
 * READ VS WRITE follows `sales.read` / `sales.write`. Reading a receivable is
 * reading the books, which every role may do; issuing, correcting and voiding is
 * the accountant's work. The two `print` and statement endpoints are reads —
 * they assemble documents, they do not change one.
 *
 * Note the deliberate absence of a "set an invoice PAID" endpoint. Nothing here
 * sets a status by hand: an invoice becomes PAID when allocations and credit
 * notes say it is, which is the only way the status and the ledger can be made
 * to disagree without also making them disagree with each other.
 */
import { Router } from "express";

import {
  CreateInvoiceSchema,
  IssueInvoiceSchema,
  ListInvoiceQuery,
  UpdateInvoiceSchema,
  VoidInvoiceSchema,
  deleteInvoice,
  getInvoice,
  issueInvoice,
  listInvoices,
  updateInvoice,
  createInvoice,
  voidInvoice,
} from "./invoice.service.js";
import {
  CreateReceiptSchema,
  ListReceiptQuery,
  createReceipt,
  getReceipt,
  listReceipts,
} from "./receipt.service.js";
import {
  CreateCreditNoteSchema,
  ListCreditNoteQuery,
  VoidCreditNoteSchema,
  createCreditNote,
  getCreditNote,
  listCreditNotes,
  voidCreditNote,
} from "./credit-note.service.js";
import {
  AgingQuery,
  OutstandingQuery,
  StatementQuery,
  agingReport,
  creditStatus,
  customerStatement,
  listOutstanding,
} from "./ar.service.js";
import { getOrgProfile } from "../settings/org-settings.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const salesRouter = Router();

salesRouter.use(authenticate, attachContext);

/* ── Invoices ────────────────────────────────────────────────────────────── */

salesRouter.get(
  "/invoices",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    const query = parseInput(ListInvoiceQuery, request.query);
    ok(response, { invoices: await listInvoices(request.context!.orgId, query) });
  }),
);

salesRouter.post(
  "/invoices",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateInvoiceSchema, request.body);
    const context = request.context!;
    ok(response, { invoice: await createInvoice(context.orgId, context.uid, input) }, 201);
  }),
);

salesRouter.get(
  "/invoices/:id",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    ok(response, { invoice: await getInvoice(request.context!.orgId, String(request.params["id"])) });
  }),
);

/**
 * The print preview.
 *
 * A read that assembles the two things a printed invoice needs — the document
 * and the organisation it is issued in the name of — so the browser has no
 * reason to stitch them together itself and get the order wrong. Deliberately
 * *not* a PDF: rendering a PDF server-side is a dependency and a queue, and the
 * browser already has a print dialog.
 */
salesRouter.get(
  "/invoices/:id/print",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    const orgId = request.context!.orgId;
    const [invoice, org] = await Promise.all([
      getInvoice(orgId, String(request.params["id"])),
      getOrgProfile(orgId),
    ]);
    ok(response, { document: { org, invoice } });
  }),
);

salesRouter.patch(
  "/invoices/:id",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateInvoiceSchema, request.body);
    const context = request.context!;
    ok(response, {
      invoice: await updateInvoice(context.orgId, context.uid, String(request.params["id"]), input),
    });
  }),
);

salesRouter.delete(
  "/invoices/:id",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const context = request.context!;
    const id = String(request.params["id"]);
    await deleteInvoice(context.orgId, context.uid, id);
    ok(response, { discarded: true, id });
  }),
);

/** Issue — the act that claims a number and puts the receivable in the books. */
salesRouter.post(
  "/invoices/:id/issue",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const input = parseInput(IssueInvoiceSchema, request.body ?? {});
    const context = request.context!;
    const result = await issueInvoice(
      context.orgId,
      context.uid,
      String(request.params["id"]),
      input,
      request.ip,
    );
    ok(response, { invoice: result.invoice, warnings: result.warnings });
  }),
);

salesRouter.post(
  "/invoices/:id/void",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const input = parseInput(VoidInvoiceSchema, request.body);
    const context = request.context!;
    ok(response, {
      invoice: await voidInvoice(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);

/* ── Receipts ────────────────────────────────────────────────────────────── */

salesRouter.get(
  "/receipts",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    const query = parseInput(ListReceiptQuery, request.query);
    ok(response, { receipts: await listReceipts(request.context!.orgId, query) });
  }),
);

salesRouter.post(
  "/receipts",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateReceiptSchema, request.body);
    const context = request.context!;
    const result = await createReceipt(context.orgId, context.uid, input, request.ip);
    ok(response, { receipt: result.receipt, warnings: result.warnings }, 201);
  }),
);

salesRouter.get(
  "/receipts/:id",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    ok(response, { receipt: await getReceipt(request.context!.orgId, String(request.params["id"])) });
  }),
);

/* ── Credit notes ────────────────────────────────────────────────────────── */

salesRouter.get(
  "/credit-notes",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    const query = parseInput(ListCreditNoteQuery, request.query);
    ok(response, { credit_notes: await listCreditNotes(request.context!.orgId, query) });
  }),
);

salesRouter.post(
  "/credit-notes",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateCreditNoteSchema, request.body);
    const context = request.context!;
    ok(response, { credit_note: await createCreditNote(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

salesRouter.get(
  "/credit-notes/:id",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    ok(response, {
      credit_note: await getCreditNote(request.context!.orgId, String(request.params["id"])),
    });
  }),
);

salesRouter.post(
  "/credit-notes/:id/void",
  requirePermission("sales.write"),
  handle(async (request, response) => {
    const input = parseInput(VoidCreditNoteSchema, request.body);
    const context = request.context!;
    ok(response, {
      credit_note: await voidCreditNote(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);

/* ── Receivable views ────────────────────────────────────────────────────── */

salesRouter.get(
  "/outstanding",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    const query = parseInput(OutstandingQuery, request.query);
    ok(response, await listOutstanding(request.context!.orgId, query));
  }),
);

salesRouter.get(
  "/aging",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    const query = parseInput(AgingQuery, request.query);
    ok(response, await agingReport(request.context!.orgId, query));
  }),
);

salesRouter.get(
  "/customers/:partyId/statement",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    const query = parseInput(StatementQuery, request.query);
    ok(response, {
      statement: await customerStatement(
        request.context!.orgId,
        String(request.params["partyId"]),
        query,
      ),
    });
  }),
);

salesRouter.get(
  "/customers/:partyId/credit",
  requirePermission("sales.read"),
  handle(async (request, response) => {
    ok(response, {
      credit: await creditStatus(request.context!.orgId, String(request.params["partyId"])),
    });
  }),
);
