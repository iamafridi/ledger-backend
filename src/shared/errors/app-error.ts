/**
 * The one error type every handler throws.
 *
 * Carrying the status and a stable machine code on the error means route
 * handlers never touch `response.status(...)` for a failure — they throw, and
 * the error middleware renders one consistent envelope. That is what keeps the
 * client's error handling a single code path.
 */
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const unauthenticated = (message = "Sign in to continue.") =>
  new AppError(401, "UNAUTHENTICATED", message);

export const notFoundError = (message = "That record does not exist.") =>
  new AppError(404, "NOT_FOUND", message);

export const validationError = (message: string, details?: unknown) =>
  new AppError(400, "VALIDATION_ERROR", message, details);
