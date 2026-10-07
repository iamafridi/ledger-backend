/**
 * Payroll routes (plan §6, Phase 11).
 *
 * One router under `/api/v1/staff`. Reading the payroll — the staff list, a
 * person's ledger, the runs, their payslips and the loans outstanding — is
 * `staff.read`, held by every role, on the same reasoning as stock, banking and
 * the asset register: these are balances of the books, and a person who cannot
 * see them cannot answer for them. Every act that posts — running payroll,
 * paying it, reversing it, disbursing or collecting a loan — is `staff.write`,
 * the accountant's side of the line.
 *
 * Registration order matters here: `/loans`, `/runs` and `/payslips` are
 * mounted before `/:id` so a literal segment is never read as an id.
 */
import { Router } from "express";

import {
  CollectSchema,
  CreateRunSchema,
  ListLoanQuery,
  ListPayslipQuery,
  ListRunQuery,
  ListStaffQuery,
  LoanInputSchema,
  PayRunSchema,
  PreviewRunSchema,
  ReverseRunSchema,
  SettleSchema,
  StaffInputSchema,
  UpdateStaffSchema,
  collectLoan,
  createLoan,
  createRun,
  createStaff,
  getLoan,
  getPayslip,
  getStaff,
  listLoans,
  listPayslips,
  listRuns,
  listStaff,
  payRun,
  previewRun,
  reverseRun,
  runDetail,
  settleLoan,
  staffLedger,
  updateStaff,
} from "./payroll.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const payrollRouter = Router();

payrollRouter.use(authenticate, attachContext);

/* ── Staff ──────────────────────────────────────────────────────────────── */

payrollRouter.get(
  "/",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    const query = parseInput(ListStaffQuery, request.query);
    ok(response, { staff: await listStaff(request.context!.orgId, query) });
  }),
);

payrollRouter.post(
  "/",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(StaffInputSchema, request.body);
    const context = request.context!;
    ok(response, { staff: await createStaff(context.orgId, context.uid, input) }, 201);
  }),
);

/* ── Loans (before /:id — a literal segment is never an id) ─────────────── */

payrollRouter.get(
  "/loans",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    const query = parseInput(ListLoanQuery, request.query);
    ok(response, { loans: await listLoans(request.context!.orgId, query) });
  }),
);

payrollRouter.post(
  "/loans",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(LoanInputSchema, request.body);
    const context = request.context!;
    ok(response, { loan: await createLoan(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

payrollRouter.get(
  "/loans/:id",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    ok(response, { loan: await getLoan(request.context!.orgId, String(request.params["id"])) });
  }),
);

payrollRouter.post(
  "/loans/:id/collect",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(CollectSchema, request.body);
    const context = request.context!;
    ok(
      response,
      await collectLoan(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    );
  }),
);

payrollRouter.post(
  "/loans/:id/settle",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(SettleSchema, request.body);
    const context = request.context!;
    ok(
      response,
      await settleLoan(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    );
  }),
);

/* ── Payroll runs ───────────────────────────────────────────────────────── */

payrollRouter.get(
  "/runs",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    const query = parseInput(ListRunQuery, request.query);
    ok(response, { runs: await listRuns(request.context!.orgId, query) });
  }),
);

/** The wizard's preview — a read: it posts nothing and burns no numbers. */
payrollRouter.post(
  "/runs/preview",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    const input = parseInput(PreviewRunSchema, request.body);
    const context = request.context!;
    ok(response, { preview: await previewRun(context.orgId, context.uid, input) });
  }),
);

payrollRouter.post(
  "/runs",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateRunSchema, request.body);
    const context = request.context!;
    ok(response, { run: await createRun(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

payrollRouter.get(
  "/runs/:id",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    ok(response, { run: await runDetail(request.context!.orgId, String(request.params["id"])) });
  }),
);

payrollRouter.post(
  "/runs/:id/pay",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(PayRunSchema, request.body ?? {});
    const context = request.context!;
    ok(
      response,
      {
        run: await payRun(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
      },
    );
  }),
);

payrollRouter.post(
  "/runs/:id/reverse",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(ReverseRunSchema, request.body);
    const context = request.context!;
    ok(
      response,
      {
        run: await reverseRun(
          context.orgId,
          context.uid,
          String(request.params["id"]),
          input.reason,
          request.ip,
        ),
      },
    );
  }),
);

/* ── Payslips ───────────────────────────────────────────────────────────── */

payrollRouter.get(
  "/payslips",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    const query = parseInput(ListPayslipQuery, request.query);
    ok(response, { payslips: await listPayslips(request.context!.orgId, query) });
  }),
);

payrollRouter.get(
  "/payslips/:id",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    ok(response, { payslip: await getPayslip(request.context!.orgId, String(request.params["id"])) });
  }),
);

/* ── One staff member (registered last: /:id is the greedy pattern) ─────── */

payrollRouter.get(
  "/:id",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    ok(response, { staff: await getStaff(request.context!.orgId, String(request.params["id"])) });
  }),
);

payrollRouter.patch(
  "/:id",
  requirePermission("staff.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateStaffSchema, request.body);
    const context = request.context!;
    ok(response, { staff: await updateStaff(context.orgId, context.uid, String(request.params["id"]), input) });
  }),
);

payrollRouter.get(
  "/:id/ledger",
  requirePermission("staff.read"),
  handle(async (request, response) => {
    ok(response, await staffLedger(request.context!.orgId, String(request.params["id"])));
  }),
);
