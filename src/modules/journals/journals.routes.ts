/**
 * Journal routes.
 *
 * `journals.read` opens the register for everyone who can see the books;
 * `journals.write` creates, posts and voids. Voiding sits behind the write gate
 * *and* demands a reason in the body — a reversal with no explanation is a
 * number in a report that nobody can reconstruct later.
 */
import { Router } from "express";

import {
  JournalInputSchema,
  ListJournalQuery,
  VoidSchema,
  discardDraft,
  getEntry,
  listEntries,
  postDraft,
  postJournalNow,
  saveDraft,
  voidEntry,
} from "./journals.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";

export const journalRouter = Router();

journalRouter.use(authenticate, attachContext);

journalRouter.get(
  "/",
  requirePermission("journals.read"),
  handle(async (request, response) => {
    const query = parseInput(ListJournalQuery, request.query);
    ok(response, await listEntries(request.context!.orgId, query));
  }),
);

journalRouter.get(
  "/:id",
  requirePermission("journals.read"),
  handle(async (request, response) => {
    ok(response, { entry: await getEntry(request.context!.orgId, String(request.params["id"])) });
  }),
);

journalRouter.post(
  "/",
  requirePermission("journals.write"),
  handle(async (request, response) => {
    const input = parseInput(JournalInputSchema, request.body);
    const context = request.context!;
    // `?draft=true` saves without posting. Kept as a query flag rather than a
    // separate route so the body contract cannot drift between the two.
    const isDraft = request.query["draft"] === "true";
    const entry = isDraft
      ? await saveDraft(context.orgId, context.uid, input, request.ip)
      : await postJournalNow(context.orgId, context.uid, input, request.ip);
    ok(response, { entry }, 201);
  }),
);

journalRouter.post(
  "/:id/post",
  requirePermission("journals.write"),
  handle(async (request, response) => {
    const context = request.context!;
    ok(response, {
      entry: await postDraft(context.orgId, context.uid, String(request.params["id"]), request.ip),
    });
  }),
);

journalRouter.post(
  "/:id/void",
  requirePermission("journals.write"),
  handle(async (request, response) => {
    const { reason } = parseInput(VoidSchema, request.body);
    const context = request.context!;
    ok(response, {
      ...await voidEntry(context.orgId, context.uid, String(request.params["id"]), reason, request.ip),
    });
  }),
);

journalRouter.delete(
  "/:id",
  requirePermission("journals.write"),
  handle(async (request, response) => {
    await discardDraft(request.context!.orgId, String(request.params["id"]));
    ok(response, { deleted: true });
  }),
);
