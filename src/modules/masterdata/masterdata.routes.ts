/**
 * Master-data routes — parties, items, and the three small catalogs.
 *
 * Reading master data is `masterdata.read`, held by every role: a VIEWER
 * looking at a document needs the party and item names to read it at all.
 * Writing is `masterdata.write`, held by OWNER/ADMIN/ACCOUNTANT — the same
 * line the chart of accounts draws, because these rows are the vocabulary the
 * books are written in.
 *
 * Three routers from one file because they are one screen's worth of API: the
 * catalogs especially are three tables with identical lifecycle (list, add,
 * patch, retire), and splitting that across three files would make the
 * sameness harder to see, not easier.
 */
import { Router } from "express";
import type { z } from "zod";

import {
  CreateCategorySchema,
  CreateTaxRateSchema,
  CreateUnitSchema,
  UpdateCategorySchema,
  UpdateTaxRateSchema,
  UpdateUnitSchema,
  createCategory,
  createTaxRate,
  createUnit,
  deactivateCategory,
  deactivateTaxRate,
  deactivateUnit,
  ensureMasterData,
  listCategories,
  listTaxRates,
  listUnits,
  updateCategory,
  updateTaxRate,
  updateUnit,
} from "./catalogs.service.js";
import {
  CreateItemSchema,
  UpdateItemSchema,
  createItem,
  deactivateItem,
  listItems,
  updateItem,
} from "./items.service.js";
import {
  CreatePartySchema,
  UpdatePartySchema,
  createParty,
  deactivateParty,
  listParties,
  updateParty,
} from "./parties.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

const includeInactive = (query: Record<string, unknown>): boolean => query["include_inactive"] === "true";

/* ── Parties ─────────────────────────────────────────────────────────────── */

export const partiesRouter = Router();

partiesRouter.use(authenticate, attachContext);

partiesRouter.get(
  "/",
  requirePermission("masterdata.read"),
  handle(async (request, response) => {
    ok(response, {
      parties: await listParties(request.context!.orgId, { includeInactive: includeInactive(request.query) }),
    });
  }),
);

partiesRouter.post(
  "/",
  requirePermission("masterdata.write"),
  handle(async (request, response) => {
    const input = parseInput(CreatePartySchema, request.body);
    const context = request.context!;
    ok(response, { party: await createParty(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

partiesRouter.patch(
  "/:id",
  requirePermission("masterdata.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdatePartySchema, request.body);
    const context = request.context!;
    ok(response, {
      party: await updateParty(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    });
  }),
);

partiesRouter.delete(
  "/:id",
  requirePermission("masterdata.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, {
      party: await deactivateParty(context.orgId, context.uid, String(request.params["id"]), request.ip),
    });
  }),
);

/* ── Items ───────────────────────────────────────────────────────────────── */

export const itemsRouter = Router();

itemsRouter.use(authenticate, attachContext);

itemsRouter.get(
  "/",
  requirePermission("masterdata.read"),
  handle(async (request, response) => {
    ok(response, {
      items: await listItems(request.context!.orgId, { includeInactive: includeInactive(request.query) }),
    });
  }),
);

itemsRouter.post(
  "/",
  requirePermission("masterdata.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateItemSchema, request.body);
    const context = request.context!;
    ok(response, { item: await createItem(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

itemsRouter.patch(
  "/:id",
  requirePermission("masterdata.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateItemSchema, request.body);
    const context = request.context!;
    ok(response, {
      item: await updateItem(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    });
  }),
);

itemsRouter.delete(
  "/:id",
  requirePermission("masterdata.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, {
      item: await deactivateItem(context.orgId, context.uid, String(request.params["id"]), request.ip),
    });
  }),
);

/* ── Catalogs: units, tax rates, categories ──────────────────────────────── */

export const catalogRouter = Router();

catalogRouter.use(authenticate, attachContext);

/**
 * Seed the default catalog (0/5/15 rates, common units, the personal-ledger
 * categories). Idempotent, so it doubles as the repair path for organisations
 * created before this module existed — they cannot re-run signup seeding, and
 * a silent "you have no units" is worse than a button that says so.
 */
catalogRouter.post(
  "/seed",
  requirePermission("masterdata.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, { seeded: await ensureMasterData(context.orgId, context.uid) }, 201);
  }),
);

/** The three catalogs share one shape: list, add, patch, retire. */
function mountCatalog<
  TCreate extends object,
  TUpdate extends object,
>(
  path: string,
  schemas: { create: z.ZodType<TCreate>; update: z.ZodType<TUpdate> },
  service: {
    list: (orgId: string, options: { includeInactive?: boolean }) => Promise<unknown>;
    create: (orgId: string, uid: string, input: TCreate, ip?: string) => Promise<unknown>;
    update: (orgId: string, uid: string, id: string, input: TUpdate, ip?: string) => Promise<unknown>;
    deactivate: (orgId: string, uid: string, id: string, ip?: string) => Promise<unknown>;
  },
  // The key the list response wraps its rows in — `{ units }`, `{ tax_rates }`.
  collection: string,
  singular: string,
): void {
  catalogRouter.get(
    path,
    requirePermission("masterdata.read"),
    handle(async (request, response) => {
      ok(response, {
        [collection]: await service.list(request.context!.orgId, {
          includeInactive: includeInactive(request.query),
        }),
      });
    }),
  );

  catalogRouter.post(
    path,
    requirePermission("masterdata.write"),
    handle(async (request, response) => {
      const input = parseInput(schemas.create, request.body);
      const context = request.context!;
      ok(response, { [singular]: await service.create(context.orgId, context.uid, input, request.ip) }, 201);
    }),
  );

  catalogRouter.patch(
    `${path}/:id`,
    requirePermission("masterdata.write"),
    handle(async (request, response) => {
      const input = parseInput(schemas.update, request.body);
      const context = request.context!;
      ok(response, {
        [singular]: await service.update(
          context.orgId,
          context.uid,
          String(request.params["id"]),
          input,
          request.ip,
        ),
      });
    }),
  );

  catalogRouter.delete(
    `${path}/:id`,
    requirePermission("masterdata.write"),
    handle(async (request, response) => {
      const context = request.context!;
      ok(response, {
        [singular]: await service.deactivate(
          context.orgId,
          context.uid,
          String(request.params["id"]),
          request.ip,
        ),
      });
    }),
  );
}

mountCatalog(
  "/units",
  { create: CreateUnitSchema, update: UpdateUnitSchema },
  { list: listUnits, create: createUnit, update: updateUnit, deactivate: deactivateUnit },
  "units",
  "unit",
);

mountCatalog(
  "/tax-rates",
  { create: CreateTaxRateSchema, update: UpdateTaxRateSchema },
  { list: listTaxRates, create: createTaxRate, update: updateTaxRate, deactivate: deactivateTaxRate },
  "tax_rates",
  "tax_rate",
);

mountCatalog(
  "/categories",
  { create: CreateCategorySchema, update: UpdateCategorySchema },
  { list: listCategories, create: createCategory, update: updateCategory, deactivate: deactivateCategory },
  "categories",
  "category",
);
