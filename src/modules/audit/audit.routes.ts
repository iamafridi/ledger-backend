import { Router } from "express";
import { AuditLogModel } from "../../core/audit.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { handle, ok } from "../../shared/http/respond.js";

export const auditRouter = Router();

auditRouter.use(authenticate, attachContext);

auditRouter.get(
  "/",
  handle(async (request, response) => {
    const entity = typeof request.query["entity"] === "string" ? request.query["entity"] : undefined;
    const limit = Math.min(Number(request.query["limit"]) || 50, 100);
    const filter: Record<string, unknown> = { org_id: request.context!.orgId };
    if (entity) filter["entity"] = entity;
    const logs = await AuditLogModel.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
    ok(response, { logs });
  }),
);
