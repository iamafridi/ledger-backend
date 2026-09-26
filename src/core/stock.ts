/**
 * Moving-average stock costing — the pure half of the inventory ledger
 * (plan §6, Phase 8).
 *
 * ONE NUMBER DECIDES EVERYTHING: THE AVERAGE
 * A warehouse holds a quantity and a value. The value is what the goods on the
 * shelf cost; the average is that value divided by that quantity, and it is what
 * an issue is costed at. Nothing here stores a per-batch cost, because a
 * per-batch cost is a second copy of the same truth and the two would drift the
 * moment one of them was updated without the other.
 *
 * THE VALUE IS THE TRUTH, NOT THE AVERAGE
 * Because a purchase debits the inventory control account by exactly the line's
 * net amount, the value carried here must equal that debit to the paisa — so a
 * receipt adds the document's own figure and the average is *derived* from it,
 * never the other way round. Deriving the value from a rounded average would
 * leave a paisa behind on every large receipt, and a stock ledger that trails the
 * control account by a paisa is a stock ledger nobody can tie out. This is what
 * makes integrity check `I5-STOCK` an equality rather than a tolerance.
 *
 * ISSUING EVERYTHING RELIEVES EVERYTHING
 * A weighted average multiplied back out rarely lands on the balance exactly, so
 * an issue of the whole position returns the whole value rather than
 * `qty × average`. Without that special case, emptying a warehouse would leave a
 * residue of a few paisa on a shelf that is physically bare — and, worse, leave
 * the control account non-zero with nothing behind it.
 *
 * Pure: no database, no clock. The service layer owns those, this owns the
 * arithmetic, and that is the split that makes the costing testable on its own.
 */
import { Decimal, money, toPaisa, ZERO, type Money } from "./money.js";

/** What a quantity of one item in one warehouse is worth. */
export interface Position {
  qty: Decimal;
  value: Money;
}

export const emptyPosition = (): Position => ({ qty: new Decimal(0), value: ZERO });

/** Build a position from stored values. `qty` may be a number (as MongoDB
 *  stores it) or a Decimal; it goes through the string form so a float never
 *  reaches the arithmetic. */
export function positionOf(qty: Decimal.Value, value: Money): Position {
  return { qty: new Decimal(String(qty)), value };
}

/**
 * Cost per unit, unrounded — "0" when nothing is on hand, so an empty shelf
 *  reports a zero cost rather than a division by zero.
 *
 * `greaterThan(ZERO)` rather than `isPositive()`, and this is load-bearing:
 * decimal.js gives zero a *positive* sign, so `new Decimal(0).isPositive()` is
 * true and an `isPositive()` guard would divide by zero and store "NaN" as an
 * average cost. Quantities are compared against zero, always.
 */
export function averageCost(position: Position): Money {
  if (!position.qty.greaterThan(ZERO)) return ZERO;
  return position.value.dividedBy(position.qty);
}

/** The value a receipt of `qty` at `unitCost` adds, rounded to the paisa. */
export function receiptValue(qty: Decimal, unitCost: Money): Money {
  return toPaisa(unitCost.times(qty));
}

/** The value an issue of `qty` relieves from `position`.
 *
 *  Issuing the whole position relieves the whole value — see the header note. */
export function issueValue(position: Position, qty: Decimal): Money {
  if (!position.qty.greaterThan(ZERO)) return ZERO;
  if (qty.greaterThanOrEqualTo(position.qty)) return toPaisa(position.value);
  return toPaisa(position.value.times(qty).dividedBy(position.qty));
}

/** Whether this position can cover an issue of `qty`. Negative stock is never
 *  allowed, so the sale that would create it is refused instead.
 *
 * Again against `ZERO` rather than `isPositive()`: a zero-quantity issue that
 * read as positive would let a movement of nothing through. */
export function canIssue(position: Position, qty: Decimal): boolean {
  return qty.greaterThan(ZERO) && !qty.greaterThan(position.qty);
}

/** A position as it is stored: a plain quantity and a canonical 2dp value. */
export function toStored(position: Position): { qty: number; value_bdt: string; avg_cost_bdt: string } {
  return {
    qty: Number(position.qty.toString()),
    value_bdt: toPaisa(position.value).toFixed(2),
    avg_cost_bdt: toPaisa(averageCost(position)).toFixed(2),
  };
}

/** Convenience for callers that hold a stored row rather than a Position. */
export function storedPosition(row: { qty?: number | null; value_bdt?: string | null } | null): Position {
  if (!row) return emptyPosition();
  return positionOf(row.qty ?? 0, money(row.value_bdt ?? "0.00"));
}
