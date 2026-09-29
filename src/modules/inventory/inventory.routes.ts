/**
 * Inventory routes (plan §6, Phase 8).
 *
 * One router under `/api/v1/inventory` because the five things here are one
 * workflow: see what is on hand, read how it got that way, move it between
 * warehouses, correct the book when it is wrong, and count it.
 *
 * READ VS WRITE vs ADJUST
 * Reading stock is `inventory.read`, held by every role — what is on the shelf
 * is part of the books. Moving goods between two of your own warehouses is
 * `inventory.write`: it changes where stock is and never what it is worth, so it
 * is ordinary work. An adjustment and a posted stocktake variance are
 * `inventory.adjust`, held by the owner and admin only, because they are the one
 * path by which the value of the balance sheet moves with no document to explain
 * it — the same line `periods.close` draws.
 */
import { Router } from "express";

import {
  CreateAdjustmentSchema,
  CreateStockTransferSchema,
  CreateStocktakeSchema,
  ListMovementsQuery,
  ListStockQuery,
  ListStocktakeQuery,
  PostStocktakeSchema,
  createAdjustment,
  createStocktake,
  createStockTransfer,
  getStocktake,
  listMovements,
  listStock,
  listStocktakes,
  postStocktake,
} from "./stock.service.js";
import {
  CreateWarehouseSchema,
  UpdateWarehouseSchema,
  createWarehouse,
  listWarehouses,
  updateWarehouse,
} from "./warehouse.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const inventoryRouter = Router();

inventoryRouter.use(authenticate, attachContext);

const includeInactive = (query: Record<string, unknown>): boolean => query["include_inactive"] === "true";

/* ── Warehouses ──────────────────────────────────────────────────────────── */

inventoryRouter.get(
  "/warehouses",
  requirePermission("inventory.read"),
  handle(async (request, response) => {
    ok(response, {
      warehouses: await listWarehouses(request.context!.orgId, {
        includeInactive: includeInactive(request.query),
      }),
    });
  }),
);

inventoryRouter.post(
  "/warehouses",
  requirePermission("inventory.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateWarehouseSchema, request.body);
    const context = request.context!;
    ok(response, { warehouse: await createWarehouse(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

inventoryRouter.patch(
  "/warehouses/:id",
  requirePermission("inventory.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateWarehouseSchema, request.body);
    const context = request.context!;
    ok(response, {
      warehouse: await updateWarehouse(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    });
  }),
);

/* ── Stock on hand ───────────────────────────────────────────────────────── */

inventoryRouter.get(
  "/stock",
  requirePermission("inventory.read"),
  handle(async (request, response) => {
    const query = parseInput(ListStockQuery, request.query);
    ok(response, await listStock(request.context!.orgId, query));
  }),
);

inventoryRouter.get(
  "/movements",
  requirePermission("inventory.read"),
  handle(async (request, response) => {
    const query = parseInput(ListMovementsQuery, request.query);
    ok(response, { movements: await listMovements(request.context!.orgId, query) });
  }),
);

/* ── Adjustments and transfers ───────────────────────────────────────────── */

inventoryRouter.post(
  "/adjustments",
  requirePermission("inventory.adjust"),
  handle(async (request, response) => {
    const input = parseInput(CreateAdjustmentSchema, request.body);
    const context = request.context!;
    ok(response, { adjustment: await createAdjustment(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

inventoryRouter.post(
  "/transfers",
  requirePermission("inventory.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateStockTransferSchema, request.body);
    const context = request.context!;
    ok(response, { transfer: await createStockTransfer(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

/* ── Stocktakes ──────────────────────────────────────────────────────────── */

inventoryRouter.get(
  "/stocktakes",
  requirePermission("inventory.read"),
  handle(async (request, response) => {
    const query = parseInput(ListStocktakeQuery, request.query);
    ok(response, { stocktakes: await listStocktakes(request.context!.orgId, query) });
  }),
);

inventoryRouter.get(
  "/stocktakes/:id",
  requirePermission("inventory.read"),
  handle(async (request, response) => {
    ok(response, { stocktake: await getStocktake(request.context!.orgId, String(request.params["id"])) });
  }),
);

inventoryRouter.post(
  "/stocktakes",
  requirePermission("inventory.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateStocktakeSchema, request.body);
    const context = request.context!;
    ok(response, { stocktake: await createStocktake(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

inventoryRouter.post(
  "/stocktakes/:id/post",
  requirePermission("inventory.adjust"),
  handle(async (request, response) => {
    const input = parseInput(PostStocktakeSchema, request.body);
    const context = request.context!;
    ok(response, {
      stocktake: await postStocktake(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);
