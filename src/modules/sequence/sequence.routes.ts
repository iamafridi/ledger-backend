/**
 * Numbering routes — peek only, and that is a deliberate omission.
 *
 * `GET /:kind/peek?date=…` answers "what would the next number be?" for a
 * form's preview. It must never allocate (the P2 exit gate: `peek` never
 * allocates), so there is no HTTP way to burn a number: an abandoned form,
 * a double-mounted page load or a stray script cannot punch holes in a
 * gapless sequence. Allocation stays where it belongs — inside the write that
 * creates the document (`allocateNumber`, called by the posting engine).
 *
 * Permission: `journals.read`. Journals are the only issuing kind until P3's
 * invoices arrive, so the journal read gate stands in for what will become a
 * per-kind document gate; a preview is a read either way.
 */
import { Router } from "express";

import { peekNumber } from "./sequence.service.js";
import { authenticate } from "../../shared/middleware/authenticate.js";
import { attachContext } from "../../shared/middleware/context.js";
import { requirePermission } from "../../shared/middleware/require-permission.js";
import { handle, ok } from "../../shared/http/respond.js";
import { parseInput } from "../../shared/validation/validation.js";
import { DateInput } from "../../shared/validation/schemas.js";
import { validationError } from "../../shared/errors/app-error.js";

export const sequenceRouter = Router();

sequenceRouter.use(authenticate, attachContext);

sequenceRouter.get(
  "/:kind/peek",
  requirePermission("journals.read"),
  handle(async (request, response) => {
    const kind = String(request.params["kind"]);
    if (!/^[a-z][a-z_]{0,31}$/.test(kind)) {
      throw validationError("Unknown document kind.");
    }
    const date = parseInput(DateInput, request.query["date"] ?? "");

    ok(response, { kind, date, next: await peekNumber(request.context!.orgId, kind, date) });
  }),
);
