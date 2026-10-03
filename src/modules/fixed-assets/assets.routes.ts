/**
 * Fixed-asset routes (plan §6, Phase 9).
 *
 * One router under `/api/v1/assets` because the register and its depreciation are
 * one workflow: register what you own, write it down monthly, and take it off the
 * books when it goes.
 *
 * READ VS WRITE
 * Reading the register — what is owned, what has been written off, what the
 * remaining life looks like — is `assets.read`, held by every role, on the same
 * reasoning as stock and banking: it is the balance of an asset account, and
 * somebody who cannot see it cannot answer the question the screen exists for.
 * Registering, depreciating, reversing a run and disposing are all `assets.write`.
 *
 * Disposal deliberately sits on the same permission as the rest rather than on an
 * owner-only code like `inventory.adjust`. A disposal is a *documented* event with
 * a reason and proceeds — the machinery of a trade, which is the accountant's
 * work. What `inventory.adjust` guards is value moving with nothing behind it,
 * and a disposal is the opposite of that.
 */
import { Router } from "express";

import {
  CreateAssetSchema,
  DisposeAssetSchema,
  ListAssetsQuery,
  UpdateAssetSchema,
  VoidDisposalSchema,
  createAsset,
  disposeAsset,
  getAsset,
  listAssets,
  updateAsset,
  voidDisposal,
} from "./assets.service.js";
import {
  DepreciationPlanSchema,
  DepreciationPreviewQuery,
  ListBatchesQuery,
  ListRunsQuery,
  ReverseRunSchema,
  assetSchedule,
  getBatch,
  listBatches,
  listRuns,
  previewDepreciation,
  reverseRun,
  runDepreciation,
} from "./depreciation.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const assetsRouter = Router();

assetsRouter.use(authenticate, attachContext);

/* ── Depreciation ────────────────────────────────────────────────────────── */

assetsRouter.get(
  "/depreciation/preview",
  requirePermission("assets.read"),
  handle(async (request, response) => {
    const query = parseInput(DepreciationPreviewQuery, request.query);
    ok(response, { preview: await previewDepreciation(request.context!.orgId, query) });
  }),
);

assetsRouter.post(
  "/depreciation/run",
  requirePermission("assets.write"),
  handle(async (request, response) => {
    const input = parseInput(DepreciationPlanSchema, request.body);
    const context = request.context!;
    ok(response, { run: await runDepreciation(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

assetsRouter.get(
  "/depreciation/runs",
  requirePermission("assets.read"),
  handle(async (request, response) => {
    const query = parseInput(ListRunsQuery, request.query);
    ok(response, { runs: await listRuns(request.context!.orgId, query) });
  }),
);

assetsRouter.get(
  "/depreciation/batches",
  requirePermission("assets.read"),
  handle(async (request, response) => {
    const query = parseInput(ListBatchesQuery, request.query);
    ok(response, { batches: await listBatches(request.context!.orgId, query.limit) });
  }),
);

assetsRouter.get(
  "/depreciation/batches/:batchId",
  requirePermission("assets.read"),
  handle(async (request, response) => {
    const batchId = String(request.params["batchId"]);
    const orgId = request.context!.orgId;
    ok(response, {
      batch_id: batchId,
      runs: await getBatch(orgId, batchId),
    });
  }),
);

assetsRouter.post(
  "/depreciation/batches/:batchId/reverse",
  requirePermission("assets.write"),
  handle(async (request, response) => {
    const input = parseInput(ReverseRunSchema, request.body);
    const context = request.context!;
    ok(response, {
      reversal: await reverseRun(
        context.orgId,
        context.uid,
        String(request.params["batchId"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);

/* ── The register ────────────────────────────────────────────────────────── */

assetsRouter.get(
  "/",
  requirePermission("assets.read"),
  handle(async (request, response) => {
    const query = parseInput(ListAssetsQuery, request.query);
    ok(response, await listAssets(request.context!.orgId, query));
  }),
);

assetsRouter.post(
  "/",
  requirePermission("assets.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateAssetSchema, request.body);
    const context = request.context!;
    ok(response, { asset: await createAsset(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

assetsRouter.get(
  "/:id",
  requirePermission("assets.read"),
  handle(async (request, response) => {
    ok(response, { asset: await getAsset(request.context!.orgId, String(request.params["id"])) });
  }),
);

assetsRouter.get(
  "/:id/schedule",
  requirePermission("assets.read"),
  handle(async (request, response) => {
    ok(response, await assetSchedule(request.context!.orgId, String(request.params["id"])));
  }),
);

assetsRouter.patch(
  "/:id",
  requirePermission("assets.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateAssetSchema, request.body);
    const context = request.context!;
    ok(response, {
      asset: await updateAsset(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    });
  }),
);

/* ── Disposal ────────────────────────────────────────────────────────────── */

assetsRouter.post(
  "/:id/dispose",
  requirePermission("assets.write"),
  handle(async (request, response) => {
    const input = parseInput(DisposeAssetSchema, request.body);
    const context = request.context!;
    ok(
      response,
      { disposal: await disposeAsset(context.orgId, context.uid, String(request.params["id"]), input, request.ip) },
      201,
    );
  }),
);

assetsRouter.post(
  "/:id/disposal/void",
  requirePermission("assets.write"),
  handle(async (request, response) => {
    const input = parseInput(VoidDisposalSchema, request.body);
    const context = request.context!;
    ok(response, {
      asset: await voidDisposal(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);
