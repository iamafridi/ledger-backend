/**
 * Attaches the verified user to the request, or rejects it.
 *
 * Every downstream handler reads `request.user.uid` and nothing else. There is
 * deliberately no route anywhere that accepts a uid from the body or the query:
 * such a parameter would be trivially forgeable and would let any signed-in
 * caller read any other user's ledger.
 */
import type { NextFunction, Request, Response } from "express";

import { unauthenticated } from "../errors/app-error.js";
import { verifyIdToken } from "../auth/verify-token.js";

export async function authenticate(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  const user = await verifyIdToken(request.header("authorization"));

  if (!user) {
    next(unauthenticated("Your session is missing or has expired. Sign in again."));
    return;
  }

  request.user = user;
  next();
}
