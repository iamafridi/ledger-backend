/**
 * Chart of accounts routes.
 *
 * Reading the chart is open to every role — a VIEWER looking at a trial balance
 * needs account names to make sense of it — while creating, changing and
 * deactivating are `coa.write`, held by OWNER/ADMIN/ACCOUNTANT. Deactivation
 * goes through `DELETE` rather than a flag on `PATCH` because it is a distinct
 * act with distinct guards, and an accidental `PATCH {is_active:false}` from a
 * form that defaulted the field would be a nasty surprise.
 */
import { Router } from "express";

import {
  CreateAccountSchema,
  UpdateAccountSchema,
  createAccount,
  deactivateAccount,
  listAccounts,
  updateAccount,
} from "./coa.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const coaRouter = Router();

coaRouter.use(authenticate, attachContext);

coaRouter.get(
  "/",
  requirePermission("coa.read"),
  handle(async (request, response) => {
    const includeInactive = request.query["include_inactive"] === "true";
    ok(response, { accounts: await listAccounts(request.context!.orgId, { includeInactive }) });
  }),
);

coaRouter.post(
  "/",
  requirePermission("coa.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateAccountSchema, request.body);
    const context = request.context!;
    ok(response, { account: await createAccount(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

coaRouter.patch(
  "/:id",
  requirePermission("coa.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateAccountSchema, request.body);
    const context = request.context!;
    ok(response, {
      account: await updateAccount(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    });
  }),
);

coaRouter.delete(
  "/:id",
  requirePermission("coa.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, {
      account: await deactivateAccount(context.orgId, context.uid, String(request.params["id"]), request.ip),
    });
  }),
);
