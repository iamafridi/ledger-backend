/**
 * Attaches the caller's organisation context to the request.
 *
 * Runs after `authenticate`: authentication answers "who is this" from a
 * verified Firebase token, this answers "which organisation, and with what
 * powers" from the database. Keeping them apart means an unauthenticated
 * request never costs a database round trip, and the context can never be
 * populated from anything the client sent.
 *
 * Every handler that touches books reads `request.context` and nothing else.
 */
import type { NextFunction, Request, Response } from "express";

import { AppError, unauthenticated } from "../errors/app-error.js";
import { permissionsFor, type Permission, type Role } from "../../core/permissions.js";
import { getOrCreateOrgForUser } from "../../modules/org/org.service.js";

export interface RequestContext {
  uid: string;
  orgId: string;
  role: Role;
  permissions: Permission[];
}

export async function attachContext(
  request: Request,
  _response: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = request.user;
    if (!user) {
      next(unauthenticated("Your session is missing or has expired. Sign in again."));
      return;
    }

    const { org, membership } = await getOrCreateOrgForUser(user.uid, user.email);

    if (org.status === "SUSPENDED") {
      next(
        new AppError(
          403,
          "ORG_SUSPENDED",
          "This organisation is suspended. Contact the owner to restore access.",
        ),
      );
      return;
    }

    const role = membership.role as Role;
    request.context = {
      uid: user.uid,
      orgId: String(org._id),
      role,
      permissions: permissionsFor(role),
    };
    next();
  } catch (error) {
    next(error);
  }
}
