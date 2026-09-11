/**
 * Bank statement CSV parsing — a pure function, no database and no framework.
 *
 * WHY A PARSER AT ALL, AND NOT A LIBRARY
 * Bank exports are not one format. The date column is sometimes `Date`, sometimes
 * `Value Date`, sometimes `Transaction Date`; the amount is sometimes one signed
 * `Amount`, sometimes a Debit/Credit pair, sometimes `Withdrawal`/`Deposit`;
 * thousands separators and currency symbols wander in and out; and a debit is
 * sometimes `(1,234.56)` and sometimes `1,234.56 DR`. Every one of those is a
 * shape somebody's actual bank produces, so the parser normalises rather than
 * insisting. It is a pure function because that is the only way this can be
 * reasoned about at all — and it is deliberately the only place a statement file
 * is interpreted.
 *
 * WHAT IT WILL NOT DO
 * Guess silently. A row it cannot read is a row it names, with its line number
 * and the offending value, and the caller refuses the whole file. A partially
 * imported statement is worse than a rejected one: the reconciliation would then
 * be explaining a file nobody actually has.
 *
 * WHAT IS NOT SUPPORTED, STATED PLAINLY
 * PDF statements (a different project), and delimiters other than a comma or a
 * tab. Both refusals are loud rather than approximate.
 */
import { fmt, money } from "../../core/money.js";

export interface ParsedStatementLine {
  /** Position in the file, 1-based and counting the header, so an error message
   *  and a spreadsheet row agree. */
  seq: number;
  date: string;
  description: string;
  reference: string;
  direction: "IN" | "OUT";
  amount_bdt: string;
  /** Blank when the statement did not print a running balance. */
  balance_bdt: string;
}

export interface StatementCsvParseResult {
  lines: ParsedStatementLine[];
  /** Which headings were recognised, for the import summary the screen shows. */
  columns: { date: string; amount: string; balance: string };
  errors: string[];
}

/* ── Field splitting ─────────────────────────────────────────────────────── */

/**
 * Split CSV text into rows of fields, honouring RFC 4180 quoting.
 *
 * A character scanner rather than `split(",")`, because a description is allowed
 * to contain the delimiter, the quote character (doubled) and even a newline —
 * and an invoice description like `"Rent, March ""final"""` arrives in the real
 * world often enough that a naive split would mis-file it.
 */
function splitRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  // A UTF-8 BOM survives the upload and would otherwise become part of the first
  // heading, so no column would match.
  const input = text.replace(/^\uFEFF/, "");
  const delimiter = input.includes("\t") && !input.includes(",") ? "\t" : ",";

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;

    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      quoted = true;
    } else if (character === delimiter) {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }

  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim() !== ""));
}

/* ── Value normalisation ────────────────────────────────────────────────── */

/** `Value Date`, `value_date`, `Value.Date` → `valuedate`. */
const normalise = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9]/g, "");

const HEADINGS = {
  date: ["date", "valuedate", "transactiondate", "postingdate", "txndate", "bookdate", "bookingdate"],
  description: [
    "description",
    "narration",
    "details",
    "particulars",
    "remarks",
    "narrative",
    "transactiondetails",
    "transactiondescription",
  ],
  reference: [
    "reference",
    "ref",
    "refno",
    "referenceno",
    "chequeno",
    "chequenumber",
    "instrumentno",
    "txnid",
    "transactionid",
    "docno",
    "documentno",
  ],
  amount: ["amount", "transactionamount", "amt", "netamount"],
  debit: ["debit", "debitamount", "withdrawal", "withdrawals", "withdrawalamount", "paidout", "moneyout"],
  credit: ["credit", "creditamount", "deposit", "deposits", "depositamount", "paidin", "moneyin"],
  balance: ["balance", "runningbalance", "closingbalance", "availablebalance", "bookbalance"],
} as const;

function findColumn(headers: readonly string[], names: readonly string[]): number {
  return headers.findIndex((heading) => names.includes(normalise(heading)));
}

/**
 * A real calendar date, from the shapes banks use.
 *
 * Year-first is unambiguous (`2026-09-14`). For slash or dash separated dates
 * with the year last, **day-first** is assumed — that is the convention in
 * Bangladesh and the UK, and it is this ledger's audience. It is a documented
 * assumption rather than a per-file guess, because a best-effort auto-detect is
 * the kind of cleverness that silently swaps January and February.
 */
export function parseStatementDate(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return null;

  const yearFirst = value.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (yearFirst) {
    return buildDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
  }

  const dayFirst = value.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dayFirst) {
    return buildDate(Number(dayFirst[3]), Number(dayFirst[2]), Number(dayFirst[1]));
  }

  return null;
}

function buildDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > (lengths[month - 1] as number)) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

interface Amount {
  value: string;
  /** Set when the cell itself carried a direction (`500.00 DR`), which decides
   *  the line's direction on its own. */
  explicit?: "IN" | "OUT";
}

/**
 * One amount cell, normalised to a canonical 2dp string.
 *
 * Handles the decorations that arrive with real exports: thousands separators,
 * currency words and symbols, a leading sign, parentheses for negative, and a
 * trailing `DR`/`CR`. `null` means "unreadable", never "zero" — a zero the parser
 * invented would be a statement line that reconciles to nothing.
 */
export function parseStatementAmount(raw: string): Amount | null {
  let value = raw.trim();
  if (value === "" || value === "-" || value === "—") return null;

  let explicit: "IN" | "OUT" | undefined;
  const trailing = value.match(/([A-Za-z]{2})$/);
  if (trailing) {
    const code = trailing[1]!.toUpperCase();
    if (code === "DR") {
      explicit = "OUT";
      value = value.slice(0, -2);
    } else if (code === "CR") {
      explicit = "IN";
      value = value.slice(0, -2);
    } else if (code === "TK" || code === "BD") {
      value = value.slice(0, -2);
    }
  }

  let negative = false;
  const parenthesised = value.match(/^\((.*)\)$/);
  if (parenthesised) {
    negative = true;
    value = parenthesised[1]!;
  }

  // Everything that is not a digit, sign or decimal point is decoration:
  // thousands separators, spaces, `৳`, `Tk`, `BDT`, non-breaking spaces.
  const cleaned = value.replace(/[^\d.+-]/g, "");
  if (cleaned === "" || !/\d/.test(cleaned)) return null;

  let sign = negative ? -1 : 1;
  if (cleaned.startsWith("-")) sign = -1;
  if (cleaned.startsWith("+")) sign = 1;

  const digits = cleaned.replace(/^[+-]/, "");
  if (!/^\d+(\.\d+)?$/.test(digits)) return null;

  try {
    const amount = money(digits).times(sign);
    return { value: fmt(amount.abs()), explicit: explicit ?? (amount.isNegative() ? "OUT" : undefined) };
  } catch {
    return null;
  }
}

/* ── The parser ─────────────────────────────────────────────────────────── */

export function parseStatementCsv(text: string): StatementCsvParseResult {
  const errors: string[] = [];
  const rows = splitRows(text);

  if (rows.length === 0) {
    return { lines: [], columns: { date: "", amount: "", balance: "" }, errors: ["The file is empty."] };
  }

  const headers = rows[0]!;
  const dateAt = findColumn(headers, HEADINGS.date);
  const descriptionAt = findColumn(headers, HEADINGS.description);
  const referenceAt = findColumn(headers, HEADINGS.reference);
  const amountAt = findColumn(headers, HEADINGS.amount);
  const debitAt = findColumn(headers, HEADINGS.debit);
  const creditAt = findColumn(headers, HEADINGS.credit);
  const balanceAt = findColumn(headers, HEADINGS.balance);

  if (dateAt === -1) {
    errors.push("No date column found. Expected a heading such as Date, Value Date or Transaction Date.");
  }
  if (amountAt === -1 && debitAt === -1 && creditAt === -1) {
    errors.push(
      "No amount column found. Expected Amount, or a Debit/Credit (Withdrawal/Deposit) pair.",
    );
  }
  if (errors.length > 0) {
    return { lines: [], columns: { date: "", amount: "", balance: "" }, errors };
  }

  // A Debit/Credit sheet is what the bank calls the two sides; `Amount` is the
  // signed shorthand. The pair wins when both exist, because it cannot be
  // misread by a missing minus sign.
  const usePair = debitAt !== -1 || creditAt !== -1;

  const lines: ParsedStatementLine[] = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const rowNumber = index + 1;
    const cell = (at: number): string => (at === -1 ? "" : (row[at] ?? "").trim());

    const date = parseStatementDate(cell(dateAt));
    if (!date) {
      errors.push(`Row ${rowNumber}: "${cell(dateAt)}" is not a date.`);
      continue;
    }

    let direction: "IN" | "OUT";
    let amount: string;

    if (usePair) {
      const debit = parseStatementAmount(cell(debitAt));
      const credit = parseStatementAmount(cell(creditAt));
      const debitValue = debit && debit.value !== "0.00" ? debit : null;
      const creditValue = credit && credit.value !== "0.00" ? credit : null;

      if (debitValue && creditValue) {
        errors.push(`Row ${rowNumber}: both a debit and a credit are filled in. A line is one or the other.`);
        continue;
      }
      if (!debitValue && !creditValue) {
        errors.push(`Row ${rowNumber}: the amount is blank or zero, so there is nothing to reconcile.`);
        continue;
      }
      direction = debitValue ? "OUT" : "IN";
      amount = (debitValue ?? creditValue)!.value;
    } else {
      const parsed = parseStatementAmount(cell(amountAt));
      if (!parsed) {
        errors.push(`Row ${rowNumber}: "${cell(amountAt)}" is not an amount.`);
        continue;
      }
      if (parsed.value === "0.00") {
        errors.push(`Row ${rowNumber}: the amount is zero, so there is nothing to reconcile.`);
        continue;
      }
      direction = parsed.explicit ?? "IN";
      amount = parsed.value;
    }

    let balance = "";
    if (balanceAt !== -1 && cell(balanceAt) !== "") {
      const parsed = parseStatementAmount(cell(balanceAt));
      if (!parsed) {
        errors.push(`Row ${rowNumber}: balance "${cell(balanceAt)}" is not an amount.`);
        continue;
      }
      const negative = /^\s*\(|^\s*-/.test(cell(balanceAt));
      balance = negative ? fmt(money(parsed.value).negated()) : parsed.value;
    }

    lines.push({
      seq: rowNumber,
      date,
      description: cell(descriptionAt),
      reference: cell(referenceAt),
      direction,
      amount_bdt: amount,
      balance_bdt: balance,
    });
  }

  if (lines.length === 0 && errors.length === 0) {
    errors.push("The file has a header but no data rows.");
  }

  return {
    lines,
    columns: {
      date: dateAt === -1 ? "" : (headers[dateAt] ?? ""),
      amount: usePair
        ? [headers[debitAt], headers[creditAt]].filter(Boolean).join(" / ")
        : (headers[amountAt] ?? ""),
      balance: balanceAt === -1 ? "" : (headers[balanceAt] ?? ""),
    },
    errors,
  };
}
