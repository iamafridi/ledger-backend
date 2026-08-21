import { Router } from "express";

import { buildDashboard } from "./dashboard.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";
import { MonthInput } from "../../shared/validation/schemas.js";
import { currentMonth } from "../../shared/dates/today.js";

export const dashboardRouter = Router();

dashboardRouter.use(authenticate, attachContext);

dashboardRouter.get(
  "/",
  requirePermission("dashboard.view"),
  handle(async (request, response) => {
    const month = request.query["month"]
      ? parseInput(MonthInput, request.query["month"])
      : currentMonth();

    ok(response, await buildDashboard(request.context!.uid, month));
  }),
);
