import { Router } from "express";

import { SetSalarySchema, effectiveSalary, listSalaries, setSalary } from "./salary.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";
import { MonthInput } from "../../shared/validation/schemas.js";
import { currentMonth } from "../../shared/dates/today.js";

export const salaryRouter = Router();

salaryRouter.use(authenticate, attachContext);

salaryRouter.get(
  "/",
  requirePermission("salary.read"),
  handle(async (request, response) => {
    ok(response, { salaries: await listSalaries(request.context!.uid) });
  }),
);

salaryRouter.get(
  "/effective",
  requirePermission("salary.read"),
  handle(async (request, response) => {
    const month = request.query["month"]
      ? parseInput(MonthInput, request.query["month"])
      : currentMonth();
    ok(response, { month, amount_bdt: await effectiveSalary(request.context!.uid, month) });
  }),
);

salaryRouter.put(
  "/",
  requirePermission("salary.write"),
  handle(async (request, response) => {
    const input = parseInput(SetSalarySchema, request.body);
    const context = request.context!;
    ok(response, { salary: await setSalary(context.uid, input, context.orgId, request.ip) });
  }),
);
