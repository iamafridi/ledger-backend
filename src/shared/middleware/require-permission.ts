/**
 * The one gate every permission-protected route uses.
 *
 * Denial is 403 with a plain-language message that tells the user what to do
 * next, not a 500 and not a silent redirect — a role problem the user cannot
 * act on is worse than no check at all from their side of the screen.
 *
 * The message deliberately does not enumerate what other roles *can* do: that is
 * an information disclosure about the organisation's structure to anyone who can
 * read a response body.
 */
import type { RequestHandler } from "express";

import { AppError, unauthenticated } from "../errors/app-error.js";
import type { Permission } from "../../core/permissions.js";

export function requirePermission(permission: Permission): RequestHandler {
  return (request, _response, next) => {
    const context = request.context;

    if (!context) {
      // Reached only if the route forgot `attachContext`. Failing closed is the
      // only safe reading of that: an absent context is not "no restrictions".
      next(unauthenticated());
      return;
    }

    if (!context.permissions.includes(permission)) {
      next(
        new AppError(
          403,
          "FORBIDDEN",
          `Your role (${context.role}) cannot do that. An owner or administrator can change your role.`,
        ),
      );
      return;
    }

    next();
  };
}
