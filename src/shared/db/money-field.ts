/**
 * ============================ MONEY IN MONGODB ============================
 * BSON `double` is IEEE-754 — the exact representation this codebase exists to
 * avoid. Storing an amount as a plain number corrupts it IN THE DATABASE, where
 * no amount of careful arithmetic downstream can recover it.
 *
 * So amounts are stored as the canonical 2dp STRINGS the engine already speaks.
 * Two reasons for strings over BSON Decimal128, which is also exact:
 *   1. The engine speaks strings at every boundary already, so there is no
 *      conversion layer left to get wrong.
 *   2. A string round-trips through JSON unchanged. Decimal128 does not, so it
 *      would need encoding on the way out and decoding on the way in — two more
 *      places for a value to be silently coerced to a double.
 *
 * If Mongo-side aggregation over amounts is ever needed, Decimal128 becomes the
 * better choice. Convert deliberately at that point, and never via Number().
 * =========================================================================
 */
import type { SchemaDefinitionProperty } from "mongoose";

/** Canonical, non-negative, exactly two decimal places. */
export const MONEY_PATTERN = /^\d+\.\d{2}$/;

export const moneyField = (required = true): SchemaDefinitionProperty<string> => ({
  type: String,
  required,
  trim: true,
  match: [MONEY_PATTERN, "Amount must be a decimal string with exactly two decimal places."],
});

export const MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
