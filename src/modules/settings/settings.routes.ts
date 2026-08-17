import { Router } from "express";

import { UpdateSettingsSchema, getSettings, updateSettings } from "./settings.service.js";
import { UpdateOrgProfileSchema, getOrgProfile, updateOrgProfile } from "./org-settings.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const settingsRouter = Router();

settingsRouter.use(authenticate, attachContext);

settingsRouter.get(
  "/",
  requirePermission("settings.read"),
  handle(async (request, response) => {
    ok(response, { settings: await getSettings(request.context!.uid) });
  }),
);

settingsRouter.put(
  "/",
  requirePermission("settings.manage"),
  handle(async (request, response) => {
    const input = parseInput(UpdateSettingsSchema, request.body);
    const context = request.context!;
    ok(response, {
      settings: await updateSettings(context.uid, input, context.orgId, request.ip),
    });
  }),
);

/*
 * The organisation's profile — what its documents print and how its numbers
 * are prefixed. A separate resource from `GET /settings` above because that one
 * is per-*user* (the DPS rate belongs to a person) and this one is per-*org*;
 * the two only look like one screen because one person happens to be both.
 *
 *   GET /settings/org    any member        — the profile as one form sees it
 *   PUT /settings/org    OWNER / ADMIN     — save it (name, address, BIN/TIN …)
 */
settingsRouter.get(
  "/org",
  requirePermission("settings.read"),
  handle(async (request, response) => {
    ok(response, { profile: await getOrgProfile(request.context!.orgId) });
  }),
);

settingsRouter.put(
  "/org",
  requirePermission("settings.manage"),
  handle(async (request, response) => {
    const input = parseInput(UpdateOrgProfileSchema, request.body);
    const context = request.context!;
    ok(response, {
      profile: await updateOrgProfile(context.orgId, context.uid, input, request.ip),
    });
  }),
);
