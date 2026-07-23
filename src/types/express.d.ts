import type { VerifiedUser } from "../shared/auth/verify-token.js";

declare global {
  namespace Express {
    interface Request {
      /** Set by the `authenticate` middleware. Absent on public routes. */
      user?: VerifiedUser;

      /**
       * Set by the `attachContext` middleware, which only runs after
       * `authenticate`. Holds the resolved organisation, role and permissions.
       *
       * It is `undefined` rather than optional-with-defaults on purpose: a
       * handler that reads `request.context!` before the middleware ran fails
       * loudly instead of operating with an empty permission set, which would
       * read as "allowed" in a naive `permissions.includes(...)` check.
       */
      context?: import("../shared/middleware/context.js").RequestContext;
    }
  }
}

export {};
