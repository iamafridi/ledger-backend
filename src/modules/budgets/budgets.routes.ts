import { Router } from "express";

import {
  listBudgets,
  bulkUpsertBudgets,
  getBudgetVariance,
  BulkUpsertBudgetSchema,
} from "./budgets.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";

export const budgetsRouter = Router();

budgetsRouter.use(authenticate, attachContext);

budgetsRouter.get(
  "/",
  requirePermission("budgets.read"),
  handle(async (request, response) => {
    const periodKey = typeof request.query["period_key"] === "string" ? request.query["period_key"] : undefined;
    const segmentId = typeof request.query["segment_id"] === "string" ? request.query["segment_id"] : undefined;
    const budgets = await listBudgets(request.context!.orgId, { periodKey, segmentId });
    ok(response, { budgets });
  }),
);

budgetsRouter.put(
  "/bulk",
  requirePermission("budgets.write"),
  handle(async (request, response) => {
    const parsed = BulkUpsertBudgetSchema.parse(request.body);
    const result = await bulkUpsertBudgets(request.context!.orgId, parsed, {
      uid: request.context!.uid,
      ip: request.ip || "127.0.0.1",
    });
    ok(response, result);
  }),
);

budgetsRouter.get(
  "/variance",
  requirePermission("budgets.read"),
  handle(async (request, response) => {
    const periodKey = typeof request.query["period_key"] === "string" ? request.query["period_key"] : "";
    const segmentId = typeof request.query["segment_id"] === "string" ? request.query["segment_id"] : undefined;
    const result = await getBudgetVariance(request.context!.orgId, { periodKey, segmentId });
    ok(response, result);
  }),
);
