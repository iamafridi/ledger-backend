/**
 * Response envelope and the async-handler wrapper.
 *
 * Express 5 forwards a rejected promise to the error middleware on its own, but
 * wrapping is kept explicit so the intent survives a future downgrade and so
 * every route reads the same way.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";

export function ok<T>(response: Response, data: T, status = 200): void {
  response.status(status).json({ success: true, data });
}

type AsyncHandler = (request: Request, response: Response, next: NextFunction) => Promise<unknown>;

export function handle(fn: AsyncHandler): RequestHandler {
  return (request, response, next) => {
    fn(request, response, next).catch(next);
  };
}
