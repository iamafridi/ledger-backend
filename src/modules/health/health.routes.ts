import { Router } from "express";

import { databaseReady } from "../../config/database.js";
import { activeProvider } from "../../shared/ocr/index.js";
import { ok } from "../../shared/http/respond.js";
import { todayInLedgerZone } from "../../shared/dates/today.js";

export const healthRouter = Router();

/**
 * Public. Render polls this to decide whether an instance is live, and the
 * frontend shows it as a connection indicator, so it reports the state of the
 * dependencies rather than just answering 200 from the process itself.
 */
healthRouter.get("/", (_request, response) => {
  ok(response, {
    service: "ledger-api",
    status: "ok",
    database: databaseReady() ? "connected" : "disconnected",
    receipt_ocr: activeProvider(),
    ledger_date: todayInLedgerZone(),
    timestamp: new Date().toISOString(),
  });
});
