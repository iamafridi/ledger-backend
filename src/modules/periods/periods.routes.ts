/**
 * Fiscal year, period and opening-balance routes.
 *
 * Reading the calendar is open to everyone who can see the books; changing it
 * is not. Closing a period locks it, so `periods.close` is OWNER/ADMIN — the
 * accountant prepares and posts, but the person who answers for the books is
 * the one who signs them off. Reopening carries the same gate and always writes
 * an audit row, because a reopened month is the single most useful thing to see
 * when a figure changes between two runs of a report.
 */
import { Router } from "express";

import {
  CreateYearSchema,
  ClosePeriodSchema,
  OpeningBalancesSchema,
  accountsForOpening,
  closePeriod,
  createFiscalYear,
  listFiscalYears,
  postOpeningBalances,
  reopenPeriod,
} from "./periods.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const periodRouter = Router();

periodRouter.use(authenticate, attachContext);

periodRouter.get(
  "/",
  requirePermission("periods.read"),
  handle(async (request, response) => {
    ok(response, { fiscal_years: await listFiscalYears(request.context!.orgId) });
  }),
);

periodRouter.post(
  "/years",
  requirePermission("periods.close"),
  handle(async (request, response) => {
    const input = parseInput(CreateYearSchema, request.body);
    const context = request.context!;
    ok(response, { fiscal_year: await createFiscalYear(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

periodRouter.post(
  "/close",
  requirePermission("periods.close"),
  handle(async (request, response) => {
    const input = parseInput(ClosePeriodSchema, request.body);
    const context = request.context!;
    ok(response, { period: await closePeriod(context.orgId, context.uid, input, request.ip) });
  }),
);

periodRouter.post(
  "/reopen",
  requirePermission("periods.close"),
  handle(async (request, response) => {
    const input = parseInput(ClosePeriodSchema, request.body);
    const context = request.context!;
    ok(response, { period: await reopenPeriod(context.orgId, context.uid, input.key, request.ip) });
  }),
);

/** The account list the opening-balance form offers. */
periodRouter.get(
  "/opening-accounts",
  requirePermission("periods.read"),
  handle(async (request, response) => {
    ok(response, { accounts: await accountsForOpening(request.context!.orgId) });
  }),
);

periodRouter.post(
  "/opening-balances",
  requirePermission("journals.write"),
  handle(async (request, response) => {
    const input = parseInput(OpeningBalancesSchema, request.body);
    const context = request.context!;
    ok(
      response,
      { opening: await postOpeningBalances(context.orgId, context.uid, input, request.ip) },
      201,
    );
  }),
);
