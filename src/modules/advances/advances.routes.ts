/**
 * Advance routes (plan §6, Phase 10; ADR 0004).
 *
 * One router under `/api/v1/advances`. Reading the advances a party holds with
 * us — the list, the per-party outstanding, the ledger — is `advances.read`,
 * held by every role, on the same reasoning as stock, banking and the asset
 * register: it is the balance of money we are holding for somebody, and a person
 * who cannot see it cannot answer the question the screen exists for. Creating a
 * manual advance, claiming one against a document, or reversing a claim is a
 * posting or a sub-ledger write, so those sit on `advances.write`.
 *
 * Note what is *absent*: there is no "set an advance fully adjusted" endpoint.
 * The status is derived from the adjustment rows after every write (ADR §1), the
 * same way an invoice is never marked PAID by hand.
 */
import { Router } from "express";

import {
  ApplyAdvanceSchema,
  CreateAdvanceSchema,
  LedgerQuery,
  ListAdvanceQuery,
  UndoAdvanceSchema,
  advanceLedger,
  applyAdvance,
  createAdvance,
  getAdvance,
  listAdvances,
  listOutstanding,
  outstandingFor,
  undoAdvanceForDocument,
} from "./advance.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";
import { DateInput } from "../../shared/validation/schemas.js";
import { z } from "zod";

export const advancesRouter = Router();

advancesRouter.use(authenticate, attachContext);

const AsOfQuery = z.object({ as_of: DateInput.optional() });

/** The FIFO order the engine would drain, so the list is the queue it acts on. */
advancesRouter.get(
  "/",
  requirePermission("advances.read"),
  handle(async (request, response) => {
    const query = parseInput(ListAdvanceQuery, request.query);
    ok(response, { advances: await listAdvances(request.context!.orgId, query) });
  }),
);

/** Everything we are holding for anybody, largest balance first. */
advancesRouter.get(
  "/outstanding",
  requirePermission("advances.read"),
  handle(async (request, response) => {
    ok(response, { outstanding: await listOutstanding(request.context!.orgId) });
  }),
);

/** The advance ledger: advances and their claims merged into a running balance. */
advancesRouter.get(
  "/ledger",
  requirePermission("advances.read"),
  handle(async (request, response) => {
    const query = parseInput(LedgerQuery, request.query);
    ok(response, await advanceLedger(request.context!.orgId, query));
  }),
);

/** One party's balance, optionally as it stood on a date. */
advancesRouter.get(
  "/parties/:partyId/outstanding",
  requirePermission("advances.read"),
  handle(async (request, response) => {
    const query = parseInput(AsOfQuery, request.query);
    ok(
      response,
      {
        party_id: String(request.params["partyId"]),
        as_of: query.as_of ?? null,
        outstanding_bdt: await outstandingFor(
          request.context!.orgId,
          String(request.params["partyId"]),
          query.as_of,
        ),
      },
    );
  }),
);

advancesRouter.post(
  "/",
  requirePermission("advances.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateAdvanceSchema, request.body);
    const context = request.context!;
    ok(response, { advance: await createAdvance(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

/** Claim an advance against a document already in the books. */
advancesRouter.post(
  "/apply",
  requirePermission("advances.write"),
  handle(async (request, response) => {
    const input = parseInput(ApplyAdvanceSchema, request.body);
    const context = request.context!;
    ok(response, await applyAdvance(context.orgId, context.uid, input));
  }),
);

/** Undo a claim on an already-void document (a no-op when already undone). */
advancesRouter.post(
  "/reverse",
  requirePermission("advances.write"),
  handle(async (request, response) => {
    const input = parseInput(UndoAdvanceSchema, request.body);
    const context = request.context!;
    ok(response, await undoAdvanceForDocument(context.orgId, context.uid, input));
  }),
);

advancesRouter.get(
  "/:id",
  requirePermission("advances.read"),
  handle(async (request, response) => {
    ok(response, { advance: await getAdvance(request.context!.orgId, String(request.params["id"])) });
  }),
);
