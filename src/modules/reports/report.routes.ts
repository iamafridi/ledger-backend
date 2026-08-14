/**
 * Report routes — the catalog, running one report, and exporting it.
 *
 * Reads are `reports.view`. Export is its own permission (`reports.export`)
 * because walking out with the whole ledger as a file is one step past reading
 * figures on screen — a distinction that matters far more now that the CSV
 * exists for every report in the catalog.
 *
 * Definitions are imported here for their side effect: importing the query
 * modules is what registers their reports.
 */
import { Router } from "express";

import { getCatalog, getReport, parseParams } from "./report-registry.js";
import { CsvWriter } from "./csv.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { AppError } from "../../shared/errors/app-error.js";
import { handle, ok } from "../../shared/http/respond.js";

// The registered catalogs. Phase 1 registered the GL reports; Phase 5 adds the
// document and sub-ledger sets, the statements and the org-wide views.
import "./queries/ledger.js";
import "./queries/documents.js";
import "./queries/subledger.js";
import "./queries/financials.js";
import "./queries/budgets.js";

export const reportRouter = Router();

reportRouter.use(authenticate, attachContext);

reportRouter.get(
  "/catalog",
  requirePermission("reports.view"),
  handle(async (_request, response) => {
    ok(response, { reports: getCatalog() });
  }),
);

reportRouter.get(
  "/:code",
  requirePermission("reports.view"),
  handle(async (request, response) => {
    const code = String(request.params["code"]);
    const definition = getReport(code);
    if (!definition) {
      throw new AppError(404, "NOT_FOUND", `There is no report called ${code}.`);
    }

    // The declaration is the contract: params are parsed against it before the
    // query runs, so a report receives a clean record or the request fails with
    // a 422 that names the problem — never a silent "all data".
    const params = parseParams(definition, request.query as Record<string, unknown>);

    // The definition travels with the rows so a client can render columns from
    // one source of truth instead of hard-coding a second copy that drifts.
    const data = await definition.query(request.context!.orgId, params);
    ok(response, {
      report: {
        code: definition.code,
        name: definition.name,
        group: definition.group,
        description: definition.description,
        columns: definition.columns,
        params: definition.params ?? [],
        additive: definition.additive ?? [],
      },
      rows: data,
    });
  }),
);

/**
 * The CSV export.
 *
 * Same definition, same parsed params, same query — only the rendering differs.
 * That is the whole registry argument made real: a report cannot drift between
 * its screen and its file, because both are the query function's output wearing
 * different clothes.
 *
 * The rows are written through `CsvWriter` as the query produces them, so the
 * response streams — the plan's D7 requirement, and the reason there is no
 * `const csv = rows.map(...).join()` anywhere in this file.
 */
reportRouter.get(
  "/:code/export",
  requirePermission("reports.export"),
  handle(async (request, response) => {
    const code = String(request.params["code"]);
    const definition = getReport(code);
    if (!definition) {
      throw new AppError(404, "NOT_FOUND", `There is no report called ${code}.`);
    }

    const params = parseParams(definition, request.query as Record<string, unknown>);
    const writer = new CsvWriter(response, `ledger-${code}-${new Date().toISOString().slice(0, 10)}.csv`);
    await writer.header(definition.columns);

    // One page of rows in memory at a time, not the whole report. The query
    // returns an array today; feeding it through the writer per chunk keeps
    // this loop the single place to change when a report grows a cursor.
    const rows = await definition.query(request.context!.orgId, params);
    for (const row of rows) {
      await writer.row(definition.columns, row);
    }
    response.end();
  }),
);
