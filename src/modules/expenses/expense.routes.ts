import { Router } from "express";

import {
  CreateExpenseSchema,
  ListExpenseQuery,
  RegisterQuery,
  UpdateExpenseSchema,
  createExpense,
  deleteExpense,
  expenseLedgerStatus,
  expenseRegister,
  listExpenses,
  postExpensesToLedger,
  updateExpense,
} from "./expense.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const expenseRouter = Router();

expenseRouter.use(authenticate, attachContext);

expenseRouter.get(
  "/",
  requirePermission("expenses.read"),
  handle(async (request, response) => {
    const query = parseInput(ListExpenseQuery, request.query);
    ok(response, { expenses: await listExpenses(request.context!.uid, query) });
  }),
);

/**
 * The expense register (plan §6, Phase 4): a date-window and category view with
 * per-category totals. Read like everything else here — the caller's own rows,
 * nobody else's.
 */
expenseRouter.get(
  "/register",
  requirePermission("expenses.read"),
  handle(async (request, response) => {
    const query = parseInput(RegisterQuery, request.query);
    ok(response, { register: await expenseRegister(request.context!.uid, query) });
  }),
);

/**
 * How much of this person's spending is in the books.
 *
 * Registered before the `/:id` routes below, and deliberately named as a
 * sub-resource rather than a query flag: the screen needs it on every load, not
 * only when something is wrong.
 */
expenseRouter.get(
  "/ledger-status",
  requirePermission("expenses.read"),
  handle(async (request, response) => {
    ok(response, { ledger: await expenseLedgerStatus(request.context!.uid) });
  }),
);

/**
 * Put every unposted expense into the ledger. Idempotent — the query only ever
 * returns rows with no entry, so a second call posts nothing.
 */
expenseRouter.post(
  "/post-to-ledger",
  requirePermission("expenses.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, { result: await postExpensesToLedger(context.orgId, context.uid, request.ip) });
  }),
);

expenseRouter.post(
  "/",
  requirePermission("expenses.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateExpenseSchema, request.body);
    const context = request.context!;
    ok(
      response,
      { expense: await createExpense(context.uid, input, context.orgId, request.ip) },
      201,
    );
  }),
);

expenseRouter.patch(
  "/:id",
  requirePermission("expenses.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateExpenseSchema, request.body);
    const context = request.context!;
    ok(response, {
      expense: await updateExpense(
        context.uid,
        String(request.params["id"]),
        input,
        context.orgId,
        request.ip,
      ),
    });
  }),
);

expenseRouter.delete(
  "/:id",
  requirePermission("expenses.write"),
  handle(async (request, response) => {
    const context = request.context!;
    await deleteExpense(context.uid, String(request.params["id"]), context.orgId, request.ip);
    ok(response, { deleted: true });
  }),
);
