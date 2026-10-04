/**
 * The tax engine — plan §6 Phase 7.
 *
 * ONE ORDER, ONE ROUNDING POINT
 * Tax on a line is always computed the same way, and it is the order a tax
 * authority expects:
 *
 *     gross = quantity × price
 *     discount reduces the taxable value        ← discount BEFORE tax
 *     net   = taxable value
 *     tax   = net × rate
 *     total = net + tax
 *
 * Discounting after tax would overstate the tax on every discounted document,
 * which is the one mistake a VAT assessment is guaranteed to find. So the order
 * lives here, once, and every buying and selling document funnels through it —
 * the same argument `core/money.ts` makes for rounding.
 *
 * INCLUSIVE VERSUS EXCLUSIVE, AND WHY THE SPLIT IS NOT A DIVISION
 * In exclusive mode the price is net and tax is added on top: `tax = net × rate`.
 * In inclusive mode the price already *contains* the tax, so the tax has to be
 * extracted: `net = round(taxable × 100 ÷ (100 + rate))` and then
 * `tax = taxable − net`. Deriving the tax directly (`taxable × rate ÷ (100+rate)`)
 * and rounding it gives a figure that does not always add back to the taxable
 * value — the printed net and tax would sum to a paisa more or less than the
 * price the customer was quoted. Subtracting instead makes `net + tax === taxable`
 * exact by construction.
 *
 * WHOLE-TAKA TRUNCATION
 * A VAT return is filed in whole taka while the books carry paisa. Truncating
 * (rounding towards zero) rather than rounding half-up is deliberate: the return
 * claims no more than the ledger supports, per rate band, and the difference is
 * reported rather than hidden — see the return builder in `modules/tax`.
 *
 * WHAT THIS FILE IS NOT
 * It is pure: no database, no request, no clock. Everything it needs arrives as
 * arguments, which is what makes the tax maths checkable to the paisa.
 */
import { Decimal } from "decimal.js";

import { add, div, mul, sub, toPaisa, ZERO, type Money } from "./money.js";

/** How a rate is used. A line is taxed with a VAT rate; a payment is *reduced*
 *  by a withholding rate. The two never mix, which is why a line naming a
 *  withholding code is refused rather than quietly accepted. */
export type TaxKind = "VAT" | "WITHHOLDING";

/**
 * How a document's prices are stated.
 *
 * `NONE` in the organisation's profile (a business not registered for VAT) maps
 * to `EXCLUSIVE` here rather than to "ignore every tax code": a line that names
 * a rate is asking for that rate to be applied, and silently dropping it would
 * post a document whose printed tax the ledger does not carry.
 */
export type TaxMode = "EXCLUSIVE" | "INCLUSIVE";

const HUNDRED = new Decimal(100);

export interface LineTaxInput {
  /** The price of one unit, before any discount. */
  unitPrice: Money;
  /** A physical quantity (1.5 kg), not money. */
  qty: Decimal.Value;
  /** Reduces the taxable value before tax is computed. */
  discount: Money;
  /** The percentage, e.g. 15.00. Zero means "no tax on this line". */
  ratePercent: Money;
  mode: TaxMode;
}

export interface LineTax {
  /** Before discount. */
  gross: Money;
  discount: Money;
  /** The taxable value — what `line_total` splits into `net + tax`. */
  net: Money;
  tax: Money;
  total: Money;
}

/**
 * Tax on one line, rounded half-up to the paisa at every step.
 *
 * The caller refuses a discount larger than the gross (it has the line number
 * to put in the message); this function assumes a non-negative taxable value and
 * would simply return a negative net if handed one.
 */
export function lineTax(input: LineTaxInput): LineTax {
  const gross = toPaisa(mul(input.unitPrice, input.qty));
  const discount = toPaisa(input.discount);
  const taxable = sub(gross, discount);

  if (input.mode === "INCLUSIVE") {
    // The taxable value already contains the tax, so extract the net and take
    // the tax as the remainder: `net + tax === taxable`, always.
    const net = toPaisa(div(mul(taxable, HUNDRED), add(HUNDRED, input.ratePercent)));
    const tax = sub(taxable, net);
    return { gross, discount, net, tax, total: add(net, tax) };
  }

  const net = taxable;
  const tax = toPaisa(div(mul(net, input.ratePercent), HUNDRED));
  return { gross, discount, net, tax, total: add(net, tax) };
}

/**
 * Drop the paisa, always towards zero.
 *
 * `ROUND_DOWN` on a positive amount is truncation; on a negative one it is also
 * truncation towards zero, which is what "the return declares no more than the
 * books hold" means on both sides of a net payable figure.
 */
export function truncateToTaka(amount: Money): Money {
  return amount.toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

/** The parts of a document line the return builder needs. Both a freshly
 *  resolved line and one read back out of Mongo satisfy this. */
export interface TaxableLine {
  tax_code?: string | null;
  tax_rate_snapshot?: string | null;
  net_bdt?: string | null;
  tax_bdt?: string | null;
  is_deduction?: boolean | null;
}

/** A rate band on the return: one tax code, the percentage it was applied at,
 *  and what it added up to over the month. */
export interface TaxBand {
  tax_code: string;
  rate_percent: string;
  net_bdt: string;
  tax_bdt: string;
  /** What the return declares for this band — `tax_bdt` truncated to taka. */
  declared_bdt: string;
}

/** One rate band being accumulated. */
export interface BandAccumulator {
  rate_percent: string;
  net: Money;
  tax: Money;
}

/**
 * Fold a set of lines into bands, in place.
 *
 * `sign` is how a whole set of lines runs: `-1` for a credit note or debit note,
 * which is the same arithmetic pointed the other way. It is applied on top of
 * `is_deduction` rather than instead of it, because a credit note may itself
 * contain a deduction line — and a shared map lets a return accumulate the
 * invoices and their credit notes into one band per code, so "output VAT on
 * 15%" is a single figure rather than two that somebody has to net by hand.
 */
export function accumulateBands(
  into: Map<string, BandAccumulator>,
  lines: readonly TaxableLine[],
  sign: 1 | -1 = 1,
): void {
  for (const line of lines) {
    const code = line.tax_code ?? "";
    if (code === "") continue;

    const direction = (line.is_deduction === true ? -1 : 1) * sign;
    const net = new Decimal(line.net_bdt ?? "0.00");
    const tax = new Decimal(line.tax_bdt ?? "0.00");
    const existing = into.get(code);

    into.set(code, {
      rate_percent: existing?.rate_percent ?? line.tax_rate_snapshot ?? "0.00",
      net: (existing?.net ?? ZERO).plus(direction === 1 ? net : net.negated()),
      tax: (existing?.tax ?? ZERO).plus(direction === 1 ? tax : tax.negated()),
    });
  }
}

/** Shape accumulated bands for the wire: largest first, each with the figure a
 *  return would declare for it. */
export function finalizeBands(into: Map<string, BandAccumulator>): TaxBand[] {
  return [...into.entries()]
    .map(([code, band]) => ({
      tax_code: code,
      rate_percent: band.rate_percent,
      net_bdt: band.net.toFixed(2),
      tax_bdt: band.tax.toFixed(2),
      declared_bdt: truncateToTaka(band.tax).toFixed(2),
    }))
    .sort((a, b) => new Decimal(b.tax_bdt).comparedTo(new Decimal(a.tax_bdt)) || a.tax_code.localeCompare(b.tax_code));
}

/** Bands for one set of lines, largest band first. Deductions subtract, exactly
 *  as they do everywhere else. */
export function bandsOf(lines: readonly TaxableLine[], sign: 1 | -1 = 1): TaxBand[] {
  const into = new Map<string, BandAccumulator>();
  accumulateBands(into, lines, sign);
  return finalizeBands(into);
}

/**
 * The note a return prints when truncation moved the figure.
 *
 * A return that declares 12,342 while the ledger holds 12,345.67 is a
 * difference somebody will have to explain to an auditor, so the explanation is
 * produced by the same function that produced the difference rather than left to
 * whoever notices it.
 */
export function roundingNote(bookNet: Money, declaredNet: Money): string {
  const difference = sub(bookNet, declaredNet);
  if (difference.isZero()) {
    return "Both figures are already whole taka, so the return and the books agree exactly.";
  }
  const direction = difference.isPositive() ? "reduces" : "increases";
  return (
    `Whole-taka truncation ${direction} the net payable by ${difference.abs().toFixed(2)}: ` +
    `the books carry ${bookNet.toFixed(2)} while the return declares ${declaredNet.toFixed(2)}. ` +
    `The difference is shown so the two figures can be reconciled line by line rather than argued about.`
  );
}
