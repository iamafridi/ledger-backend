import { Router } from "express";

import {
  CreatePocketSchema,
  UpdatePocketSchema,
  createPocket,
  deletePocket,
  listPockets,
  updatePocket,
} from "./pocket.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const pocketRouter = Router();

pocketRouter.use(authenticate, attachContext);

pocketRouter.get(
  "/",
  requirePermission("pockets.read"),
  handle(async (request, response) => {
    ok(response, { pockets: await listPockets(request.context!.uid) });
  }),
);

pocketRouter.post(
  "/",
  requirePermission("pockets.write"),
  handle(async (request, response) => {
    const input = parseInput(CreatePocketSchema, request.body);
    ok(response, { pocket: await createPocket(request.context!.uid, input) }, 201);
  }),
);

pocketRouter.patch(
  "/:id",
  requirePermission("pockets.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdatePocketSchema, request.body);
    ok(response, {
      pocket: await updatePocket(request.context!.uid, String(request.params["id"]), input),
    });
  }),
);

pocketRouter.delete(
  "/:id",
  requirePermission("pockets.write"),
  handle(async (request, response) => {
    await deletePocket(request.context!.uid, String(request.params["id"]));
    ok(response, { deleted: true });
  }),
);
