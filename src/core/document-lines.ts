/**
 * The document line engine — plan §5.4, shared by every buying and selling
 * document in the ledger.
 *
 * ONE ENGINE, TWO DIRECTIONS
 * An invoice line and a bill line are the same arithmetic: quantity × price,
 * less discount, plus tax, rounded half-up at every step. What differs is only
 * where the result lands. A sale credits revenue and debits the customer's
 * control account; a purchase debits an expense and credits the supplier's.
 * That difference is a `DocumentProfile`, not a second copy of this file.
 *
 * A second copy is how a rounding rule drifts. The two files would agree on the
 * day they were written and disagree six months later, and the person to find
 * out would be a customer comparing a printed document against the ledger by
 * hand. So the profiles below are data — an account type to enforce, a fallback
 * account, a VAT control account, a side — and the arithmetic lives once.
 *
 * ONE ROUNDING RULE, ONE PLACE
 * `gross → net → tax → line total`, each step rounded half-up to the paisa by
 * `core/money.ts`. Rounding at every step rather than once at the end is what
 * makes a line's printed tax figure the figure that was actually posted.
 *
 * DISCOUNT BEFORE TAX
 * The plan is explicit, and it is the order a tax authority expects: a discount
 * reduces the taxable value, so tax is computed on the net of it. Doing it the
 * other way round would overstate VAT on every discounted document. The order
 * itself, and the inclusive/exclusive split, live in `core/tax.ts` — this file
 * resolves *what* to tax, that file decides *how much*.
 *
 * WHOSE TAX MODE IS IT
 * Inclusive versus exclusive is a property of the organisation, not of a line
 * (it is how that business states its prices), so `resolveLines` asks the org
 * once per document and hands the answer to the arithmetic. The mode is also
 * snapshotted onto every line, so a report can tell later which way a document
 * read without re-deriving it from a setting that may since have changed.
 *
 * DIRECTION IS NEVER A SIGN
 * A line that subtracts (a settlement discount, a rebate) is marked
 * `is_deduction` and stores positive amounts; the sign appears only in the
 * document totals and in which side of the journal entry it lands on. That is
 * what keeps `net_bdt` readable on its own — "500.00" always means five hundred
 * taka of whatever this line is.
 *
 * SNAPSHOTS ARE WRITTEN ONCE
 * The tax percentage and the account name are resolved here, at line creation,
 * and stored. A rate edited in the catalog next month must not restate a
 * document that is already in somebody's hands.
 */
import { z } from "zod";

import { CoaAccountModel } from "../modules/coa/coa.model.js";
import { ItemModel } from "../modules/masterdata/items.model.js";
import { TaxRateModel } from "../modules/masterdata/catalogs.model.js";
import { add, fmt, money, sum, type Money, ZERO } from "./money.js";
import { lineTax, type TaxMode } from "./tax.js";
import { vatModeFor } from "../modules/settings/org-settings.service.js";
import { MoneyInput } from "../shared/validation/schemas.js";
import { AppError, validationError } from "../shared/errors/app-error.js";
import type { JournalLineInput } from "./posting.js";

/**
 * Which way round a document family runs.
 *
 * Everything here is a fact about the *normal* direction of the family; a
 * document that runs against it (a credit note against an invoice, a debit note
 * against a bill) is that same profile with `reverse: true`, which is why a
 * reversal needs no profile of its own.
 */
export interface DocumentProfile {
  /** The account a line falls back to when neither it nor its item names one. */
  defaultAccountCode: string;
  /** The item field that supplies a line's own default account. */
  itemAccountField: "income_account_code" | "expense_account_code";
  /**
   * Where a **stock-tracked** item's line posts instead of the field above.
   *
   * Only a purchasing document has one. Buying stock is not consuming it, so the
   * debit belongs in inventory until the stock ledger relieves it at the sale
   * (plan §6 Phase 8) — and a profile with no stock account (selling) simply
   * never routes a line here.
   */
  stockAccountCode?: string;
  /** The account types the net amount may post to. */
  allowedAccountTypes: readonly string[];
  /**
   * Account codes admitted even though their type is not among
   * `allowedAccountTypes`.
   *
   * Phase 9's capitalisation path, and deliberately a list of *codes* rather than
   * a fourth entry in the types above: opening the purchase profile to asset
   * accounts in general would let a line post to receivables or to a loan account
   * and still balance, which is the silent wrongness the type guard exists to
   * stop. Naming one code says "this document may capitalise, and nowhere else".
   */
  capitalAccountCodes?: readonly string[];
  /** The error code thrown when a line names an account of the wrong type. */
  accountTypeCode: string;
  /** What to suggest when a line names an account of the wrong type. */
  accountTypeGuidance: string;
  /**
   * Which side the grouped net amounts land on. The control account takes the
   * other side, always — a document that grew a receivable cannot also have
   * grown it.
   */
  netSide: "DEBIT" | "CREDIT";
  /** Where the tax on the document posts: 2100 output VAT, 1300 input VAT. */
  taxAccountCode: string;
  /** What the tax line is called on the entry's memo. */
  taxLabel: string;
}

/** A sale: revenue credited, the customer's control account debited. */
export const SALE: DocumentProfile = {
  defaultAccountCode: "4000",
  itemAccountField: "income_account_code",
  allowedAccountTypes: ["REVENUE"],
  accountTypeCode: "ACCOUNT_NOT_REVENUE",
  accountTypeGuidance:
    "Sales reduce a revenue account — pick one such as 4000 Sales Revenue.",
  netSide: "CREDIT",
  taxAccountCode: "2100",
  taxLabel: "VAT",
};

/**
 * A purchase: the asset or expense debited, the supplier's control account
 * credited.
 *
 * The fallback is 5800 Miscellaneous Expense, which is also what
 * `items.service.ts` defaults a new item's `expense_account_code` to — so a
 * line with no item and a line with an unmapped item land in the same place
 * rather than two places.
 *
 * TWO DESTINATIONS, AND THE ITEM DECIDES WHICH
 * A line for a **stock-tracked** item posts to the inventory control account
 * (1200) — the goods are not consumed, they are on a shelf, and the stock
 * ledger relieves that account when they are sold. Everything else posts to an
 * expense account. The guard therefore admits an expense account for an ordinary
 * line and an asset account for a stock one, and the *same* line shapes the
 * posting and the stock movement: the stock module keys off the account a line
 * landed on, which is what makes the two provably agree.
 *
 * CAPITALISING: A LINE THAT NAMES 1500
 * A fixed-asset purchase has the same shape as stock — buy now, relieve over
 * time — but the relief is depreciation rather than COGS, and the parameters (a
 * life, a salvage value, which accounts it writes down against) are facts about
 * the individual asset that a document line has nowhere to carry. So the bill is
 * the *acquisition* and the register is the *asset*: a line naming 1500 by hand
 * puts the cost in the fixed-asset control account, and the register records what
 * that cost bought through `POST /api/v1/assets` without posting it a second time.
 *
 * That is why 1500 is admitted by code below. The two halves are tied together by
 * the integrity run rather than by a link between the rows: `I5-FIXED-ASSETS`
 * compares the register's total cost against 1500's balance and names the
 * difference, so a capitalised bill nobody registered — or a register row nobody
 * paid for — is reported rather than quietly tolerated.
 */
export const PURCHASE: DocumentProfile = {
  defaultAccountCode: "5800",
  itemAccountField: "expense_account_code",
  stockAccountCode: "1200",
  capitalAccountCodes: ["1500"],
  allowedAccountTypes: ["EXPENSE"],
  accountTypeCode: "ACCOUNT_NOT_EXPENSE",
  accountTypeGuidance:
    "A purchase adds to an expense account — pick one such as 5800 Miscellaneous Expense. Buying stock posts to inventory by itself; buying a fixed asset means naming 1500 capitalises, and registering what it bought.",
  netSide: "DEBIT",
  taxAccountCode: "1300",
  taxLabel: "Input VAT",
};

export const DocumentLineInput = z.object({
  item_id: z.string().trim().nullable().default(null),
  description: z.string().trim().max(300).default(""),
  qty: z.coerce
    .number()
    .min(0, "A quantity cannot be negative.")
    .max(1_000_000, "That quantity is not plausible."),
  unit_price_bdt: MoneyInput,
  discount_bdt: MoneyInput.default("0.00"),
  /** Blank means "no tax on this line" — a deliberate choice, not an omission. */
  tax_code: z.string().trim().max(24).default(""),
  /** Blank means "whatever the item, or the profile's fallback, says". */
  account_code: z.string().trim().max(24).default(""),
  is_deduction: z.boolean().default(false),
});

export type DocumentLineInput = z.output<typeof DocumentLineInput>;

/**
 * Non-blocking advice returned alongside a document that was issued anyway.
 *
 * A warning is never a refusal: by the time one is produced the act has
 * happened, and a ledger that refused a sale because somebody had not filled in
 * a limit field would be making the warning the problem. It exists so the person
 * can be told what it cost without the system stopping them.
 */
export interface DocumentWarning {
  code: string;
  message: string;
}

export interface ResolvedLine {
  sort_order: number;
  label_snapshot: string;
  description: string;
  qty: number;
  unit_price_bdt: string;
  discount_bdt: string;
  net_bdt: string;
  tax_code: string;
  tax_rate_snapshot: string;
  /** Which way round this line's prices were read — from the org's profile. */
  tax_mode: TaxMode;
  tax_bdt: string;
  line_total_bdt: string;
  account_code: string;
  account_name: string;
  item_id: string | null;
  is_deduction: boolean;
}

export interface DocumentTotals {
  subtotal_bdt: string;
  discount_total_bdt: string;
  tax_total_bdt: string;
  total_bdt: string;
}

/**
 * The four amounts a total is derived from. Named as their own type rather than
 * taking a whole `ResolvedLine`, because both a freshly resolved line and a line
 * *read back out of the database* must be totallable — and forcing the latter to
 * be re-resolved would let a stored document's totals drift from the amounts
 * actually written on it.
 */
export type LineAmounts = {
  net_bdt?: string | null;
  discount_bdt?: string | null;
  tax_bdt?: string | null;
  is_deduction?: boolean | null;
};

/** What the posting engine needs from a line: its amounts, its account and
 *  which direction it runs. */
export type LineForPosting = LineAmounts & {
  account_code?: string | null;
  account_name?: string | null;
};

/** The signed contribution of one line: positive, or negative for a deduction. */
function signed(line: { is_deduction?: boolean | null }, amount: Money): Money {
  return line.is_deduction ? amount.negated() : amount;
}

/**
 * Resolve one request's worth of lines against master data.
 *
 * Batched: items, tax rates and accounts are read once for the whole document
 * rather than per line. A 40-line bill is therefore three reads, not 120 — and
 * the validation messages still name the offending line, because a refusal that
 * says "no account 9999" without saying *where* costs the user a search.
 */
export async function resolveLines(
  orgId: string,
  inputs: DocumentLineInput[],
  profile: DocumentProfile,
  /** Overrides the organisation's own VAT mode. Only tests and the smoke run
   *  pass it; a real document always asks the profile. */
  taxMode?: TaxMode,
): Promise<ResolvedLine[]> {
  const itemIds = [...new Set(inputs.map((line) => line.item_id).filter((id): id is string => Boolean(id)))];
  const taxCodes = [...new Set(inputs.map((line) => line.tax_code).filter(Boolean))];

  const [items, rates, mode] = await Promise.all([
    itemIds.length
      ? ItemModel.find({ org_id: orgId, _id: { $in: itemIds } }).lean()
      : Promise.resolve([]),
    taxCodes.length
      ? TaxRateModel.find({ org_id: orgId, code: { $in: taxCodes }, is_active: true }).lean()
      : Promise.resolve([]),
    // Whose mode it is: the organisation's. Read once for the document rather
    // than per line, because a document is written one way round.
    taxMode ?? vatModeFor(orgId),
  ]);

  // Accounts are read in a second pass because two of the codes that can be
  // posted to — an item's own account and the profile's fallback — are not known
  // until the items have been read. Resolving the fallback lazily inside the map
  // below is the bug this avoids: the default account was never fetched, so a
  // line that named no account failed as though 4000 did not exist.
  const accountCodes = [
    ...new Set([
      ...inputs.map((line) => line.account_code).filter(Boolean),
      ...items.map((item) => item[profile.itemAccountField]),
      ...(profile.stockAccountCode ? [profile.stockAccountCode] : []),
      profile.defaultAccountCode,
    ]),
  ];

  const accounts = await CoaAccountModel.find({ org_id: orgId, code: { $in: accountCodes } }).lean();

  const itemsById = new Map(items.map((item) => [String(item._id), item]));
  const ratesByCode = new Map(rates.map((rate) => [rate.code, rate]));
  const accountsByCode = new Map(accounts.map((account) => [account.code, account]));

  return inputs.map((input, index) => {
    const where = `Line ${index + 1}`;

    const item = input.item_id ? itemsById.get(input.item_id) : undefined;
    if (input.item_id && !item) {
      throw new AppError(422, "ITEM_NOT_FOUND", `${where} names an item that does not exist in this ledger.`);
    }

    // The account the net amount posts to. A sale belongs on a revenue account,
    // a purchase on an expense account, and a purchase of *stock* on inventory;
    // anything else means the mapping is wrong, and a wrong mapping still
    // balances the trial balance while making every margin figure in it wrong.
    //
    // An account named on the line itself wins: somebody who says "expense this"
    // has made a decision, and that line then moves no stock — which is the
    // behaviour the stock module's own selection rule expects.
    const isStockLine = Boolean(profile.stockAccountCode) && item?.track_stock === true && !input.account_code;
    const accountCode =
      input.account_code ||
      (isStockLine ? profile.stockAccountCode! : item?.[profile.itemAccountField]) ||
      profile.defaultAccountCode;
    const account = accountsByCode.get(accountCode);
    if (!account) {
      throw new AppError(422, "ACCOUNT_NOT_FOUND", `No account with code ${accountCode} exists in this ledger.`);
    }
    if (account.is_active === false) {
      throw new AppError(422, "ACCOUNT_INACTIVE", `Account ${accountCode} (${account.name}) is inactive.`);
    }
    if (isStockLine) {
      // Inventory is an asset, so the profile's expense-only guard does not
      // apply to it — but it must still be an asset, or the goods have been
      // booked somewhere nothing will ever relieve them.
      if (account.type !== "ASSET") {
        throw new AppError(
          422,
          "ACCOUNT_NOT_ASSET",
          `${where} posts stock-tracked ${item!.name} to ${account.code} (${account.name}), which is a ${account.type.toLowerCase()} account. ` +
            "Stock has to land in an asset account so the stock ledger can relieve it when it is sold.",
        );
      }
      // A stock movement of nothing cannot be valued, and a value with no
      // quantity would sit in inventory for ever with nothing to sell.
      if (input.qty <= 0) {
        throw new AppError(
          422,
          "STOCK_LINE_NEEDS_QTY",
          `${where} is stock-tracked ${item!.name}, so it needs a quantity greater than zero.`,
        );
      }
    } else if (
      !profile.allowedAccountTypes.includes(account.type) &&
      !profile.capitalAccountCodes?.includes(account.code)
    ) {
      throw new AppError(
        422,
        profile.accountTypeCode,
        `${where} would post to ${account.code} (${account.name}), which is a ${account.type.toLowerCase()} account. ` +
          profile.accountTypeGuidance,
      );
    }

    const rate = input.tax_code ? ratesByCode.get(input.tax_code) : undefined;
    if (input.tax_code && !rate) {
      throw new AppError(
        422,
        "TAX_RATE_NOT_FOUND",
        `${where} names tax code ${input.tax_code}, which is not an active rate in this ledger.`,
      );
    }
    // A withholding rate is deducted from a payment, never added to a line.
    // Accepting one here would post the supplier's source tax as though it were
    // VAT the customer owed, and the two control accounts would disagree for
    // ever. Which rate is which is a fact about the rate, so the rate knows.
    if (rate && rate.kind === "WITHHOLDING") {
      throw new AppError(
        422,
        "TAX_CODE_NOT_APPLICABLE",
        `${where} names ${input.tax_code} (${rate.name}), which is a withholding rate. ` +
          "Withholding is deducted from a supplier payment, not added to a line — pick a VAT rate here.",
      );
    }

    // One order, one rounding point: discount reduces the taxable value, then
    // tax is computed on what is left (core/tax.ts).
    const amounts = lineTax({
      unitPrice: money(input.unit_price_bdt),
      qty: input.qty,
      discount: money(input.discount_bdt),
      ratePercent: rate ? money(rate.rate_percent) : ZERO,
      mode,
    });
    if (amounts.net.isNegative()) {
      throw new AppError(
        422,
        "DISCOUNT_EXCEEDS_LINE",
        `${where} discounts ${fmt(amounts.discount)} off ${fmt(amounts.gross)}. A discount cannot exceed the amount it discounts.`,
      );
    }

    return {
      sort_order: index,
      label_snapshot: item?.name ?? "",
      description: input.description,
      qty: input.qty,
      unit_price_bdt: fmt(money(input.unit_price_bdt)),
      discount_bdt: fmt(amounts.discount),
      net_bdt: fmt(amounts.net),
      tax_code: input.tax_code,
      tax_rate_snapshot: rate ? rate.rate_percent : "0.00",
      tax_mode: mode,
      tax_bdt: fmt(amounts.tax),
      line_total_bdt: fmt(amounts.total),
      account_code: account.code,
      account_name: account.name,
      item_id: input.item_id,
      is_deduction: input.is_deduction,
    };
  });
}

/**
 * Document totals, derived from the lines every time (plan §5.4 — "totals are
 * derived, never stored stale"). Nothing in this codebase increments a total.
 */
export function totalsOf(lines: LineAmounts[]): DocumentTotals {
  const net = sum(lines.map((line) => signed(line, money(line.net_bdt ?? "0.00"))));
  const discount = sum(lines.map((line) => signed(line, money(line.discount_bdt ?? "0.00"))));
  const tax = sum(lines.map((line) => signed(line, money(line.tax_bdt ?? "0.00"))));

  return {
    subtotal_bdt: fmt(net),
    discount_total_bdt: fmt(discount),
    tax_total_bdt: fmt(tax),
    total_bdt: fmt(add(net, tax)),
  };
}

/**
 * Refuse a document whose deductions outgrow its amounts.
 *
 * Zero is allowed — an all-zero draft has nothing to post and will be refused
 * when it is issued — but negative is not: a document with a negative total is a
 * credit note (or a debit note) with extra steps, and those name the document
 * they correct.
 */
export function assertTotalsUsable(totals: DocumentTotals): void {
  if (money(totals.subtotal_bdt).isNegative() || money(totals.total_bdt).isNegative()) {
    throw validationError(
      "The deductions on this document are larger than its amounts. A negative document is a correction — raise it against the document it corrects.",
    );
  }
}

/**
 * The journal entry a document produces.
 *
 * Grouped by account: one line per account and one per tax code, rather than one
 * per document line. A forty-line bill produces three journal lines, which is
 * what an accountant expects to see in the register and what keeps the general
 * ledger from filling with rows nobody will ever read.
 *
 * `reverse` is the whole difference between a document and the correction of it:
 * the same arithmetic with every side swapped.
 */
export function documentPostingLines(
  lines: LineForPosting[],
  options: {
    profile: DocumentProfile;
    controlAccountCode: string;
    controlAccountName: string;
    partyId: string;
    reverse?: boolean;
    memo: string;
  },
): JournalLineInput[] {
  const netByAccount = new Map<string, { name: string; amount: Money }>();
  let taxTotal: Money = ZERO;

  for (const line of lines) {
    const accountCode = line.account_code ?? "";
    const amount = signed(line, money(line.net_bdt ?? "0.00"));
    const existing = netByAccount.get(accountCode);
    netByAccount.set(accountCode, {
      name: existing?.name ?? line.account_name ?? "",
      amount: (existing?.amount ?? ZERO).plus(amount),
    });
    taxTotal = taxTotal.plus(signed(line, money(line.tax_bdt ?? "0.00")));
  }

  const totals = totalsOf(lines);
  const documentTotal = money(totals.total_bdt);

  // The two orientations, stated once. A document runs its profile's direction,
  // and its correction runs the opposite one; the control account always takes
  // whichever side the net amounts do not.
  const reverse = options.reverse === true;
  const netsDebit = (options.profile.netSide === "DEBIT") !== reverse;

  const out: JournalLineInput[] = [];

  const push = (
    accountCode: string,
    memo: string,
    amount: Money,
    debitWhenPositive: boolean,
  ): void => {
    if (amount.isZero()) return;
    // The side comes from the sign of the grouped amount: a net credit on a
    // revenue account credits, and an account the document pulls net-negative
    // (a deduction heavier than the amounts booked to it) debits instead.
    // Nothing is ever stored with a minus sign.
    const onDebit = amount.isPositive() ? debitWhenPositive : !debitWhenPositive;
    out.push({
      account_code: accountCode,
      debit_bdt: onDebit ? fmt(amount.abs()) : "0.00",
      credit_bdt: onDebit ? "0.00" : fmt(amount.abs()),
      memo,
      ...(options.partyId ? { party_id: options.partyId } : {}),
    });
  };

  // The control side first: the party's balance moves by the document total,
  // which is the one figure that must tie to the sub-ledger (integrity I5).
  push(
    options.controlAccountCode,
    `${options.memo} — ${options.controlAccountName}`,
    documentTotal,
    !netsDebit,
  );

  for (const [code, group] of netByAccount) {
    push(code, options.memo, group.amount, netsDebit);
  }
  push(
    options.profile.taxAccountCode,
    `${options.memo} — ${options.profile.taxLabel}`,
    taxTotal,
    netsDebit,
  );

  return out;
}

/**
 * The stored shape of a resolved line.
 *
 * Kept here, next to `ResolvedLine`, so a field added to §5.4 is written to the
 * collections in exactly one place. Every document's line — invoice, credit
 * note, bill, debit note — is the same record with a different `doc_type`, and
 * they must not diverge; a field added to one line mapper and forgotten in the
 * other is a document kind that silently stops recording something.
 */
export function lineDocs(lines: readonly ResolvedLine[]): Record<string, unknown>[] {
  return lines.map((line) => ({
    sort_order: line.sort_order,
    label_snapshot: line.label_snapshot,
    description: line.description,
    qty: line.qty,
    unit_price_bdt: line.unit_price_bdt,
    discount_bdt: line.discount_bdt,
    net_bdt: line.net_bdt,
    tax_code: line.tax_code,
    tax_rate_snapshot: line.tax_rate_snapshot,
    tax_mode: line.tax_mode,
    tax_bdt: line.tax_bdt,
    line_total_bdt: line.line_total_bdt,
    account_code: line.account_code,
    account_name: line.account_name,
    item_id: line.item_id,
    is_deduction: line.is_deduction,
  }));
}

/** One stored line, as the wire and the screen see it. */
export interface DocumentLineView {
  id: string;
  sort_order: number;
  label_snapshot: string;
  description: string;
  qty: number;
  unit_price_bdt: string;
  discount_bdt: string;
  net_bdt: string;
  tax_code: string;
  tax_rate_snapshot: string;
  /** Which way round this line's prices were read when it was written. */
  tax_mode: TaxMode;
  tax_bdt: string;
  line_total_bdt: string;
  account_code: string;
  account_name: string;
  item_id: string | null;
  is_deduction: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lineView(doc: any): DocumentLineView {
  return {
    id: String(doc._id),
    sort_order: doc.sort_order ?? 0,
    label_snapshot: doc.label_snapshot ?? "",
    description: doc.description ?? "",
    qty: doc.qty,
    unit_price_bdt: doc.unit_price_bdt,
    discount_bdt: doc.discount_bdt,
    net_bdt: doc.net_bdt,
    tax_code: doc.tax_code ?? "",
    tax_rate_snapshot: doc.tax_rate_snapshot ?? "0.00",
    tax_mode: doc.tax_mode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE",
    tax_bdt: doc.tax_bdt,
    line_total_bdt: doc.line_total_bdt,
    account_code: doc.account_code,
    account_name: doc.account_name ?? "",
    item_id: doc.item_id ? String(doc.item_id) : null,
    is_deduction: doc.is_deduction === true,
  };
}
