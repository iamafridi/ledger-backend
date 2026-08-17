/**
 * Organisation routes.
 *
 * Three endpoints, and the first place in the codebase where `requirePermission`
 * actually decides something:
 *
 *   GET   /            any member       — the organisation's own profile
 *   GET   /members     ACCOUNTANT+      — who has access to these books
 *   PATCH /            OWNER / ADMIN    — rename, set the fiscal year start
 *
 * `GET /members` is the clearest demonstration of why roles exist at all: it
 * returns the identity of everyone who can see the data, so it is withheld from
 * VIEWER, while an ACCOUNTANT — who by definition works with those people's
 * numbers — may read it but may not change how the organisation is configured.
 */
import { Router } from "express";

import { UpdateOrgSchema, getOrgView, listMembers, updateOrg } from "./org.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const orgRouter = Router();

orgRouter.use(authenticate, attachContext);

orgRouter.get(
  "/",
  requirePermission("org.read"),
  handle(async (request, response) => {
    ok(response, { org: await getOrgView(request.context!.orgId) });
  }),
);

orgRouter.get(
  "/members",
  requirePermission("members.read"),
  handle(async (request, response) => {
    ok(response, { members: await listMembers(request.context!.orgId) });
  }),
);

orgRouter.patch(
  "/",
  requirePermission("org.manage"),
  handle(async (request, response) => {
    const input = parseInput(UpdateOrgSchema, request.body);
    const context = request.context!;
    ok(response, {
      org: await updateOrg(context.orgId, context.uid, input, request.ip),
    });
  }),
);
