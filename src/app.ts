import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import { allowedOrigins } from "./config/env.js";
import { authRouter } from "./modules/auth/auth.routes.js";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes.js";
import { demoRouter } from "./modules/demo/demo.routes.js";
import { expenseRouter } from "./modules/expenses/expense.routes.js";
import { healthRouter } from "./modules/health/health.routes.js";
import { orgRouter } from "./modules/org/org.routes.js";
import { coaRouter } from "./modules/coa/coa.routes.js";
import { catalogRouter, itemsRouter, partiesRouter } from "./modules/masterdata/masterdata.routes.js";
import { sequenceRouter } from "./modules/sequence/sequence.routes.js";
import { journalRouter } from "./modules/journals/journals.routes.js";
import { periodRouter } from "./modules/periods/periods.routes.js";
import { reportRouter } from "./modules/reports/report.routes.js";
import { pocketRouter } from "./modules/pockets/pocket.routes.js";
import { receiptRouter } from "./modules/receipts/receipt.routes.js";
import { purchasesRouter } from "./modules/purchases/purchases.routes.js";
import { salesRouter } from "./modules/sales/sales.routes.js";
import { bankingRouter } from "./modules/banking/banking.routes.js";
import { taxRouter } from "./modules/tax/tax.routes.js";
import { inventoryRouter } from "./modules/inventory/inventory.routes.js";
import { assetsRouter } from "./modules/fixed-assets/assets.routes.js";
import { advancesRouter } from "./modules/advances/advances.routes.js";
import { payrollRouter } from "./modules/payroll/payroll.routes.js";
import { segmentsRouter } from "./modules/segments/segments.routes.js";
import { budgetsRouter } from "./modules/budgets/budgets.routes.js";
import { recurringRouter } from "./modules/recurring/recurring.routes.js";
import { salaryRouter } from "./modules/salary/salary.routes.js";
import { settingsRouter } from "./modules/settings/settings.routes.js";
import { warehouseRouter } from "./modules/warehouse/warehouse.routes.js";
import { auditRouter } from "./modules/audit/audit.routes.js";
import { connectDatabase } from "./config/database.js";
import { errorHandler, notFound } from "./shared/middleware/error-handler.js";

// Some deployment environments (e.g. Vercel serverless / @vercel/node) resolve
// dual CJS/ESM packages as namespace objects rather than directly callable functions.
const helmetMiddleware: any =
  typeof helmet === "function" ? helmet : (helmet as any)?.default ?? helmet;

const rateLimitMiddleware: any =
  typeof rateLimit === "function"
    ? rateLimit
    : (rateLimit as any)?.default ?? (rateLimit as any)?.rateLimit ?? rateLimit;

export function createApp(): Express {
  const app = express();
  const origins = allowedOrigins();

  app.disable("x-powered-by");
  // Render terminates TLS in front of the app; without this, express-rate-limit
  // sees every request as coming from the proxy and rate-limits all users as one.
  app.set("trust proxy", 1);

  // Allow Firebase / Google authentication popups by configuring Cross-Origin-Opener-Policy
  app.use(
    helmetMiddleware({
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    }),
  );

  app.use(
    cors({
      origin(origin, callback) {
        // A server-to-server call or a curl has no Origin header. CORS exists to
        // protect browsers, so those are not the thing it is guarding against.
        if (
          !origin ||
          origins.includes(origin) ||
          origin.startsWith("http://localhost:") ||
          origin.endsWith(".vercel.app")
        ) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} is not allowed.`));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.use(express.json({ limit: "1mb" }));
  app.use(
    rateLimitMiddleware({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: "draft-7",
      legacyHeaders: false,
    }),
  );

  // Auto-connect MongoDB in serverless environments (e.g. Vercel)
  app.use(async (_req, _res, next) => {
    try {
      await connectDatabase();
      next();
    } catch (err) {
      next(err);
    }
  });

  // Root health probe
  app.get("/", (_req, res) => {
    res.json({
      name: "Ledger API",
      status: "healthy",
      version: "1.0.0",
      docs: "/api/v1/health",
    });
  });

  // Normalize route paths so requests without /api/v1 (e.g. /auth/me or /settings)
  // are seamlessly routed to their /api/v1/ counterparts.
  app.use((req, _res, next) => {
    if (!req.url.startsWith("/api/v1") && req.url !== "/") {
      if (req.url.startsWith("/api/")) {
        req.url = req.url.replace(/^\/api\//, "/api/v1/");
      } else {
        req.url = `/api/v1${req.url.startsWith("/") ? "" : "/"}${req.url}`;
      }
    }
    next();
  });

  app.use("/api/v1/health", healthRouter);
  app.use("/api/v1/auth", authRouter);
  app.use("/api/v1/org", orgRouter);
  app.use("/api/v1/dashboard", dashboardRouter);
  app.use("/api/v1/demo", demoRouter);
  app.use("/api/v1/salaries", salaryRouter);
  app.use("/api/v1/coa", coaRouter);
  app.use("/api/v1/parties", partiesRouter);
  app.use("/api/v1/items", itemsRouter);
  app.use("/api/v1/catalogs", catalogRouter);
  app.use("/api/v1/sequence", sequenceRouter);
  app.use("/api/v1/periods", periodRouter);
  app.use("/api/v1/journals", journalRouter);
  app.use("/api/v1/reports", reportRouter);
  app.use("/api/v1/expenses", expenseRouter);
  app.use("/api/v1/savings-pockets", pocketRouter);
  app.use("/api/v1/receipts", receiptRouter);
  app.use("/api/v1/settings", settingsRouter);
  app.use("/api/v1/sales", salesRouter);
  app.use("/api/v1/purchases", purchasesRouter);
  app.use("/api/v1/banking", bankingRouter);
  app.use("/api/v1/tax", taxRouter);
  app.use("/api/v1/inventory", inventoryRouter);
  app.use("/api/v1/assets", assetsRouter);
  app.use("/api/v1/advances", advancesRouter);
  app.use("/api/v1/staff", payrollRouter);
  app.use("/api/v1/segments", segmentsRouter);
  app.use("/api/v1/budgets", budgetsRouter);
  app.use("/api/v1/recurring", recurringRouter);
  app.use("/api/v1/warehouse", warehouseRouter);
  app.use("/api/warehouse", warehouseRouter);
  app.use("/api/v1/audit", auditRouter);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

const defaultApp = createApp();
export default defaultApp;
