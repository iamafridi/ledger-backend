/**
 * Purchases & AP routes (plan §6, Phase 4).
 *
 * Mounted as one router under `/api/v1/purchases` because bills, payments and
 * debit notes are one workflow: a screen that records a payment has just been
 * looking at the bills it settles, and splitting them across three mounts would
 * make the frontend's API surface describe our file layout instead of the user's
 * task.
 *
 * READ VS WRITE follows `purchases.read` / `purchases.write`, the same line the
 * sales router draws. Reading a payable is reading the books, which every role
 * may do; entering, correcting and voiding is the accountant's work. The `print`
 * and statement endpoints are reads — they assemble documents, they do not
 * change one.
 *
 * Note the deliberate absence of a "set a bill PAID" endpoint. Nothing here sets
 * a status by hand: a bill becomes PAID when allocations and debit notes say it
 * is, which is the only way the status and the ledger can be made to disagree
 * without also making them disagree with each other.
 */
import { Router } from "express";

import {
  CreateBillSchema,
  IssueBillSchema,
  ListBillQuery,
  UpdateBillSchema,
  VoidBillSchema,
  createBill,
  deleteBill,
  getBill,
  issueBill,
  listBills,
  updateBill,
  voidBill,
} from "./bill.service.js";
import {
  CreatePaymentSchema,
  ListPaymentQuery,
  createPayment,
  getPayment,
  listPayments,
} from "./payment.service.js";
import {
  CreateDebitNoteSchema,
  ListDebitNoteQuery,
  VoidDebitNoteSchema,
  createDebitNote,
  getDebitNote,
  listDebitNotes,
  voidDebitNote,
} from "./debit-note.service.js";
import {
  AgingQuery,
  OutstandingQuery,
  StatementQuery,
  agingReport,
  listOutstanding,
  supplierPosition,
  supplierStatement,
} from "./ap.service.js";
import { getOrgProfile } from "../settings/org-settings.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const purchasesRouter = Router();

purchasesRouter.use(authenticate, attachContext);

/* ── Bills ───────────────────────────────────────────────────────────────── */

purchasesRouter.get(
  "/bills",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    const query = parseInput(ListBillQuery, request.query);
    ok(response, { bills: await listBills(request.context!.orgId, query) });
  }),
);

purchasesRouter.post(
  "/bills",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateBillSchema, request.body);
    const context = request.context!;
    ok(response, { bill: await createBill(context.orgId, context.uid, input) }, 201);
  }),
);

purchasesRouter.get(
  "/bills/:id",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    ok(response, { bill: await getBill(request.context!.orgId, String(request.params["id"])) });
  }),
);

/**
 * The print preview.
 *
 * A read that assembles the two things a printed bill needs — the document and
 * the organisation it is recorded against — so the browser has no reason to
 * stitch them together itself and get the order wrong. Deliberately *not* a PDF:
 * rendering one server-side is a dependency and a queue, and the browser already
 * has a print dialog.
 */
purchasesRouter.get(
  "/bills/:id/print",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    const orgId = request.context!.orgId;
    const [bill, org] = await Promise.all([
      getBill(orgId, String(request.params["id"])),
      getOrgProfile(orgId),
    ]);
    ok(response, { document: { org, bill } });
  }),
);

purchasesRouter.patch(
  "/bills/:id",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateBillSchema, request.body);
    const context = request.context!;
    ok(response, {
      bill: await updateBill(context.orgId, context.uid, String(request.params["id"]), input),
    });
  }),
);

purchasesRouter.delete(
  "/bills/:id",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const context = request.context!;
    const id = String(request.params["id"]);
    await deleteBill(context.orgId, context.uid, id);
    ok(response, { discarded: true, id });
  }),
);

/** Issue — the act that claims a number and puts the payable in the books. */
purchasesRouter.post(
  "/bills/:id/issue",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const input = parseInput(IssueBillSchema, request.body ?? {});
    const context = request.context!;
    const result = await issueBill(
      context.orgId,
      context.uid,
      String(request.params["id"]),
      input,
      request.ip,
    );
    ok(response, { bill: result.bill, warnings: result.warnings });
  }),
);

purchasesRouter.post(
  "/bills/:id/void",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const input = parseInput(VoidBillSchema, request.body);
    const context = request.context!;
    ok(response, {
      bill: await voidBill(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);

/* ── Payments ────────────────────────────────────────────────────────────── */

purchasesRouter.get(
  "/payments",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    const query = parseInput(ListPaymentQuery, request.query);
    ok(response, { payments: await listPayments(request.context!.orgId, query) });
  }),
);

purchasesRouter.post(
  "/payments",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const input = parseInput(CreatePaymentSchema, request.body);
    const context = request.context!;
    const result = await createPayment(context.orgId, context.uid, input, request.ip);
    ok(response, { payment: result.payment, warnings: result.warnings }, 201);
  }),
);

purchasesRouter.get(
  "/payments/:id",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    ok(response, { payment: await getPayment(request.context!.orgId, String(request.params["id"])) });
  }),
);

/* ── Debit notes ─────────────────────────────────────────────────────────── */

purchasesRouter.get(
  "/debit-notes",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    const query = parseInput(ListDebitNoteQuery, request.query);
    ok(response, { debit_notes: await listDebitNotes(request.context!.orgId, query) });
  }),
);

purchasesRouter.post(
  "/debit-notes",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateDebitNoteSchema, request.body);
    const context = request.context!;
    ok(
      response,
      { debit_note: await createDebitNote(context.orgId, context.uid, input, request.ip) },
      201,
    );
  }),
);

purchasesRouter.get(
  "/debit-notes/:id",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    ok(response, {
      debit_note: await getDebitNote(request.context!.orgId, String(request.params["id"])),
    });
  }),
);

purchasesRouter.post(
  "/debit-notes/:id/void",
  requirePermission("purchases.write"),
  handle(async (request, response) => {
    const input = parseInput(VoidDebitNoteSchema, request.body);
    const context = request.context!;
    ok(response, {
      debit_note: await voidDebitNote(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);

/* ── Payable views ───────────────────────────────────────────────────────── */

purchasesRouter.get(
  "/outstanding",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    const query = parseInput(OutstandingQuery, request.query);
    ok(response, await listOutstanding(request.context!.orgId, query));
  }),
);

purchasesRouter.get(
  "/aging",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    const query = parseInput(AgingQuery, request.query);
    ok(response, await agingReport(request.context!.orgId, query));
  }),
);

purchasesRouter.get(
  "/suppliers/:partyId/statement",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    const query = parseInput(StatementQuery, request.query);
    ok(response, {
      statement: await supplierStatement(
        request.context!.orgId,
        String(request.params["partyId"]),
        query,
      ),
    });
  }),
);

purchasesRouter.get(
  "/suppliers/:partyId/position",
  requirePermission("purchases.read"),
  handle(async (request, response) => {
    ok(response, {
      position: await supplierPosition(request.context!.orgId, String(request.params["partyId"])),
    });
  }),
);
