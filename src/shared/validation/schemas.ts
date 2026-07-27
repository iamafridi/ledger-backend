/**
 * The primitives every request body is built from.
 *
 * Money is accepted as a string with one or two decimal places and normalised
 * to exactly two, because "500.5" from a form field and "500.50" from the OCR
 * are the same amount and both must land in the database in one canonical form.
 * A number is rejected outright: JSON has no decimal type, so `500.50` arrives
 * as an IEEE-754 double and the precision is already gone by the time we see it.
 */
import { z } from "zod";

import { CATEGORIES } from "../ocr/types.js";

export const MoneyInput = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Enter an amount like 1250 or 1250.50.")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });

export const RateInput = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, "Enter a rate like 8 or 8.25.")
  .transform((value) => {
    const [whole, fraction = ""] = value.split(".");
    return `${whole}.${fraction.padEnd(2, "0")}`;
  });

export const MonthInput = z
  .string()
  .trim()
  .regex(/^\d{4}-(?:0[1-9]|1[0-2])$/, "Month must look like 2026-04.");

export const DateInput = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must look like 2026-04-17.")
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number) as [number, number, number];
    if (m < 1 || m > 12 || d < 1) return false;
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return d <= (lengths[m - 1] as number);
  }, "That date does not exist.");

export const CategoryInput = z.enum(CATEGORIES);

export const ObjectIdInput = z
  .string()
  .trim()
  .regex(/^[0-9a-fA-F]{24}$/, "That record id is not valid.");
