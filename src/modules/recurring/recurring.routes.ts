import { Router } from "express";

import {
  listRecurringTemplates,
  getRecurringTemplateById,
  createRecurringTemplate,
  updateRecurringTemplate,
  runRecurringTemplate,
  CreateRecurringTemplateSchema,
  UpdateRecurringTemplateSchema,
} from "./recurring.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";

export const recurringRouter = Router();

recurringRouter.use(authenticate, attachContext);

recurringRouter.get(
  "/",
  requirePermission("recurring.read"),
  handle(async (request, response) => {
    const status = typeof request.query["status"] === "string" ? request.query["status"] : undefined;
    const templates = await listRecurringTemplates(request.context!.orgId, { status });
    ok(response, { templates });
  }),
);

recurringRouter.get(
  "/:id",
  requirePermission("recurring.read"),
  handle(async (request, response) => {
    const template = await getRecurringTemplateById(request.context!.orgId, String(request.params["id"]));
    ok(response, { template });
  }),
);

recurringRouter.post(
  "/",
  requirePermission("recurring.write"),
  handle(async (request, response) => {
    const parsed = CreateRecurringTemplateSchema.parse(request.body);
    const template = await createRecurringTemplate(request.context!.orgId, parsed, {
      uid: request.context!.uid,
      ip: request.ip || "127.0.0.1",
    });
    ok(response, { template }, 201);
  }),
);

recurringRouter.patch(
  "/:id",
  requirePermission("recurring.write"),
  handle(async (request, response) => {
    const parsed = UpdateRecurringTemplateSchema.parse(request.body);
    const template = await updateRecurringTemplate(request.context!.orgId, String(request.params["id"]), parsed, {
      uid: request.context!.uid,
      ip: request.ip || "127.0.0.1",
    });
    ok(response, { template });
  }),
);

recurringRouter.post(
  "/:id/run",
  requirePermission("recurring.write"),
  handle(async (request, response) => {
    const runDate = typeof request.body?.run_date === "string" ? request.body.run_date : undefined;
    const result = await runRecurringTemplate(request.context!.orgId, String(request.params["id"]), { runDate }, {
      uid: request.context!.uid,
      ip: request.ip || "127.0.0.1",
    });
    ok(response, result);
  }),
);
