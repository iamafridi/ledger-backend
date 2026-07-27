/**
 * Input parsing. Every request body and query string goes through here.
 *
 * `parse`, never `cast`: a malformed money string must fail at the edge with a
 * field-level message, not become NaN somewhere in the engine.
 */
import type { z } from "zod";

import { notFoundError, validationError } from "../errors/app-error.js";

export function parseInput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw validationError(
      "Check the highlighted fields and try again.",
      result.error.flatten().fieldErrors,
    );
  }
  return result.data;
}

/**
 * A 24-hex id, or the 404 the caller's message describes.
 *
 * Reached before any database read, so a mistyped link reads as "that page does
 * not exist" rather than as a driver cast error — which looks to a user like the
 * server broke, and to us like a bug report with no useful detail in it.
 */
export function assertObjectId(id: string, message: string): void {
  if (!/^[0-9a-fA-F]{24}$/.test(id)) throw notFoundError(message);
}
