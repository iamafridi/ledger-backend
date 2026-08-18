import { Router } from "express";

import {
  listSegments,
  getSegmentById,
  createSegment,
  updateSegment,
  CreateSegmentSchema,
  UpdateSegmentSchema,
} from "./segments.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";

export const segmentsRouter = Router();

segmentsRouter.use(authenticate, attachContext);

segmentsRouter.get(
  "/",
  requirePermission("segments.read"),
  handle(async (request, response) => {
    const type = typeof request.query["type"] === "string" ? request.query["type"] : undefined;
    const activeOnly = request.query["active"] === "true";
    const segments = await listSegments(request.context!.orgId, { type, activeOnly });
    ok(response, { segments });
  }),
);

segmentsRouter.get(
  "/:id",
  requirePermission("segments.read"),
  handle(async (request, response) => {
    const segment = await getSegmentById(request.context!.orgId, String(request.params["id"]));
    ok(response, { segment });
  }),
);

segmentsRouter.post(
  "/",
  requirePermission("segments.write"),
  handle(async (request, response) => {
    const parsed = CreateSegmentSchema.parse(request.body);
    const segment = await createSegment(request.context!.orgId, parsed, {
      uid: request.context!.uid,
      ip: request.ip || "127.0.0.1",
    });
    ok(response, { segment }, 201);
  }),
);

segmentsRouter.patch(
  "/:id",
  requirePermission("segments.write"),
  handle(async (request, response) => {
    const parsed = UpdateSegmentSchema.parse(request.body);
    const segment = await updateSegment(request.context!.orgId, String(request.params["id"]), parsed, {
      uid: request.context!.uid,
      ip: request.ip || "127.0.0.1",
    });
    ok(response, { segment });
  }),
);
