/**
 * Banking & cash routes (plan §6, Phase 6).
 *
 * One router under `/api/v1/banking` because a bank account, its statement and
 * the transfer that moved money between accounts are one workflow: somebody
 * opens the account, notices the statement disagrees, and fixes it without ever
 * leaving the screen.
 *
 * READ VS WRITE follows `banking.read` / `banking.write`. Reading what the bank
 * holds is reading the books, which every role may do; moving money, importing a
 * statement and posting a correction are the accountant's work.
 *
 * Note what is *not* here: no endpoint sets a statement line to MATCHED by
 * itself, and none posts a "bank balance". A line is matched to a journal line
 * that already exists, or it posts a correction with a named counter account —
 * both of which the posting engine then re-validates. There is no path from a
 * statement file to the ledger that skips double entry.
 */
import { Router } from "express";

import {
  CreateBankAccountSchema,
  UpdateBankAccountSchema,
  cashPosition,
  createBankAccount,
  deactivateBankAccount,
  getBankAccount,
  listBankAccounts,
  updateBankAccount,
} from "./accounts.service.js";
import {
  CreateTransferSchema,
  ListTransferQuery,
  VoidTransferSchema,
  createTransfer,
  getTransfer,
  listTransfers,
  voidTransfer,
} from "./transfer.service.js";
import {
  CorrectSchema,
  IgnoreSchema,
  ImportStatementSchema,
  ListStatementLinesQuery,
  MatchSchema,
  correctStatementLine,
  ignoreStatementLine,
  importStatement,
  listImports,
  listStatementLines,
  matchStatementLine,
  unmatchStatementLine,
} from "./statement.service.js";
import { ReconciliationQuery, reconciliation } from "./reconciliation.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const bankingRouter = Router();

bankingRouter.use(authenticate, attachContext);

/* ── Cash position & accounts ────────────────────────────────────────────── */

/** What is in the till, right now — the number the banking screen opens with. */
bankingRouter.get(
  "/position",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    const asOf = typeof request.query["as_of"] === "string" ? request.query["as_of"] : undefined;
    ok(response, await cashPosition(request.context!.orgId, asOf));
  }),
);

bankingRouter.get(
  "/accounts",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    const includeInactive = request.query["include_inactive"] === "true";
    ok(response, { accounts: await listBankAccounts(request.context!.orgId, { includeInactive }) });
  }),
);

bankingRouter.post(
  "/accounts",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateBankAccountSchema, request.body);
    const context = request.context!;
    ok(response, { account: await createBankAccount(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

bankingRouter.get(
  "/accounts/:id",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    ok(response, { account: await getBankAccount(request.context!.orgId, String(request.params["id"])) });
  }),
);

bankingRouter.patch(
  "/accounts/:id",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(UpdateBankAccountSchema, request.body);
    const context = request.context!;
    ok(response, {
      account: await updateBankAccount(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
    });
  }),
);

/** Deactivate — a treasury row with statement history is never deleted. */
bankingRouter.delete(
  "/accounts/:id",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, {
      account: await deactivateBankAccount(context.orgId, context.uid, String(request.params["id"]), request.ip),
    });
  }),
);

/* ── Transfers ───────────────────────────────────────────────────────────── */

bankingRouter.get(
  "/transfers",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    const query = parseInput(ListTransferQuery, request.query);
    ok(response, { transfers: await listTransfers(request.context!.orgId, query) });
  }),
);

bankingRouter.post(
  "/transfers",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(CreateTransferSchema, request.body);
    const context = request.context!;
    ok(response, { transfer: await createTransfer(context.orgId, context.uid, input, request.ip) }, 201);
  }),
);

bankingRouter.get(
  "/transfers/:id",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    ok(response, { transfer: await getTransfer(request.context!.orgId, String(request.params["id"])) });
  }),
);

bankingRouter.post(
  "/transfers/:id/void",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(VoidTransferSchema, request.body);
    const context = request.context!;
    ok(response, {
      transfer: await voidTransfer(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.reason,
        request.ip,
      ),
    });
  }),
);

/* ── Statements ──────────────────────────────────────────────────────────── */

bankingRouter.get(
  "/accounts/:id/statements",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    ok(response, {
      imports: await listImports(request.context!.orgId, String(request.params["id"])),
    });
  }),
);

bankingRouter.post(
  "/accounts/:id/statements",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(ImportStatementSchema, request.body);
    const context = request.context!;
    ok(
      response,
      await importStatement(context.orgId, context.uid, String(request.params["id"]), input, request.ip),
      201,
    );
  }),
);

bankingRouter.get(
  "/accounts/:id/statement-lines",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    const query = parseInput(ListStatementLinesQuery, request.query);
    ok(response, {
      lines: await listStatementLines(request.context!.orgId, String(request.params["id"]), query),
    });
  }),
);

/** The workspace: the walk, the lines with their suggestions, and the book side. */
bankingRouter.get(
  "/accounts/:id/reconciliation",
  requirePermission("banking.read"),
  handle(async (request, response) => {
    const query = parseInput(ReconciliationQuery, request.query);
    ok(response, await reconciliation(request.context!.orgId, String(request.params["id"]), query));
  }),
);

bankingRouter.post(
  "/statement-lines/:id/match",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(MatchSchema, request.body);
    const context = request.context!;
    const line = await matchStatementLine(
      context.orgId,
      context.uid,
      String(request.params["id"]),
      input.journal_line_id,
      request.ip,
    );
    // The summary comes back with the decision so the screen can show what it did
    // to the unexplained figure without a second round trip.
    const workspace = await reconciliation(context.orgId, line.bank_account_id, {});
    ok(response, { line, summary: workspace.summary });
  }),
);

bankingRouter.post(
  "/statement-lines/:id/unmatch",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, {
      line: await unmatchStatementLine(context.orgId, context.uid, String(request.params["id"]), request.ip),
    });
  }),
);

bankingRouter.post(
  "/statement-lines/:id/ignore",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(IgnoreSchema, request.body);
    const context = request.context!;
    ok(response, {
      line: await ignoreStatementLine(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.note,
        request.ip,
      ),
    });
  }),
);

bankingRouter.post(
  "/statement-lines/:id/correct",
  requirePermission("banking.write"),
  handle(async (request, response) => {
    const input = parseInput(CorrectSchema, request.body);
    const context = request.context!;
    ok(response, {
      line: await correctStatementLine(
        context.orgId,
        context.uid,
        String(request.params["id"]),
        input.counter_account_code,
        input.memo,
        request.ip,
      ),
    });
  }),
);
