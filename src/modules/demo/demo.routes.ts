import { Router } from "express";
import { z } from "zod";

import { clearUser, listCases, seedCase, seedEnterpriseSuite, seedScenario, DemoScenarioType } from "./demo.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

const SeedSchema = z.object({
  case_id: z.string().trim().regex(/^PUB-\d{2}$/, "Case ids look like PUB-01."),
});

const ScenarioSchema = z.object({
  scenario: z.enum(["FMCG", "TECH", "RETAIL"]).default("FMCG"),
});

export const demoRouter = Router();

demoRouter.use(authenticate, attachContext);

/** The 25 published cases, as a summary the client can offer in a list. */
demoRouter.get(
  "/cases",
  requirePermission("dashboard.view"),
  handle(async (_request, response) => {
    ok(response, { cases: listCases() });
  }),
);

/** Load one case into the signed-in user's own account. */
demoRouter.post(
  "/seed",
  // Seeding replaces every expense, salary and pocket in the target months, so
  // it is a destructive write and is gated as one. A VIEWER must not be able to
  // wipe somebody's ledger by pressing a demo button.
  requirePermission("demo.manage"),
  handle(async (request, response) => {
    const { case_id } = parseInput(SeedSchema, request.body);
    const context = request.context!;
    ok(response, { seeded: await seedCase(context.orgId, context.uid, case_id) });
  }),
);

/** Load full enterprise accounting demo dataset into the organisation. */
demoRouter.post(
  "/enterprise",
  requirePermission("demo.manage"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(
      response,
      {
        seeded: await seedEnterpriseSuite(context.orgId, context.uid, request.ip),
      },
      201,
    );
  }),
);

/** Load scenario-specific benchmark dataset (FMCG, TECH, or RETAIL) */
demoRouter.post(
  "/scenario",
  requirePermission("demo.manage"),
  handle(async (request, response) => {
    const { scenario } = parseInput(ScenarioSchema, request.body);
    const context = request.context!;
    ok(
      response,
      {
        seeded: await seedScenario(context.orgId, context.uid, scenario as DemoScenarioType, request.ip),
      },
      201,
    );
  }),
);

demoRouter.delete(
  "/",
  requirePermission("demo.manage"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, { cleared: true, ...await clearUser(context.orgId, context.uid) });
  }),
);
