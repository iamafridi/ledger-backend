/**
 * The single place a failure becomes a response body.
 *
 * Two rules:
 *   1. One envelope shape, always: { success: false, error: { code, message } }.
 *   2. An unexpected error never leaks its message to the client — it is logged
 *      server-side and reported as a generic 500. A stack trace or a Mongo
 *      connection string in an error body is an information disclosure.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";

import { AppError } from "../errors/app-error.js";

export const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
  void _next;

  if (error instanceof AppError) {
    response.status(error.statusCode).json({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    });
    return;
  }

  console.error("[unhandled]", error);
  response.status(500).json({
    success: false,
    error: { code: "INTERNAL_ERROR", message: "Something went wrong. Please try again." },
  });
};

export const notFound: RequestHandler = (request, response) => {
  response.status(404).json({
    success: false,
    error: { code: "NOT_FOUND", message: `No route matches ${request.method} ${request.path}.` },
  });
};
