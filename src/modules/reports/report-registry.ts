/**
 * The report registry — one definition per report, one pipeline to render it.
 *
 * A report declares its columns and a query; the HTTP layer, the CSV exporter
 * and (from Phase 5) the PDF renderer all read the same definition. That is the
 * contract `docs/accounting-platform/reporting.md` states — "every report on
 * screen must also exist as PDF, Excel, CSV and a print layout" — and it is the
 * only way that stays true as the catalog grows past a handful of screens.
 *
 * Definitions register themselves at import time (see `queries/ledger.ts`), so
 * adding a report is one file: no route table, no switch statement, no place to
 * forget one of the four outputs.
 */
import { AppError } from "../../shared/errors/app-error.js";

/** Querystring filters, already strings by the time Express hands them over. */
export type ReportParams = Record<string, unknown>;

/** Heterogeneous row values. Money arrives as a canonical 2dp string. */
export type ReportRow = Record<string, string | number | boolean | null>;

export interface ReportColumn {
  key: string;
  label: string;
  type: "text" | "money" | "date" | "number" | "code";
}

export interface ReportDefinition {
  code: string;
  name: string;
  group: string;
  description: string;
  columns: ReportColumn[];
  /**
   * The parameters this report accepts, declared rather than guessed.
   *
   * Phase 1 made the *client* own this table, which meant adding a report on
   * the server still meant a line on the client — the drift the registry was
   * built to prevent. Declaring it here is what lets the runner render its
   * parameter bar from the same definition that supplies the columns, so a new
   * report works everywhere with no client change at all.
   */
  params?: ReportParam[];
  /**
   * Which money columns may be totalled on screen.
   *
   * A running balance must never be summed — adding up a general ledger's
   * Balance column produces a number with no meaning — so the definition names
   * the columns whose footer total is a real figure rather than the client
   * applying a rule to every money column.
   */
  additive?: string[];
  /** Read-only. A report must never mutate the books it is reporting on. */
  query: (orgId: string, params: ReportParams) => Promise<ReportRow[]>;
}

/* ── Parameters, declared ────────────────────────────────────────────────── */

export type ReportParamKind = "date" | "account" | "party" | "choice" | "month";

export interface ReportParam {
  key: string;
  label: string;
  kind: ReportParamKind;
  required?: boolean;
  /** For `choice` parameters — the values the report understands. */
  options?: { value: string; label: string }[];
  /** The value used when the parameter is omitted, shown so an omission is a
   *  visible choice rather than a silent default. */
  placeholder?: string;
}

/** The date-window pair most reports accept. One object, reused, so the two
 *  keys and their labels cannot drift between reports. */
export const DATE_WINDOW_PARAMS: ReportParam[] = [
  { key: "from", label: "From", kind: "date" },
  { key: "to", label: "To", kind: "date" },
];

/** The compare control every financial statement carries (plan §6 Phase 5). */
export const COMPARE_PARAM: ReportParam = {
  key: "compare",
  label: "Compare with",
  kind: "choice",
  options: [
    { value: "none", label: "Nothing — this period only" },
    { value: "previous-period", label: "The previous period" },
    { value: "previous-year", label: "The same period, last year" },
  ],
  placeholder: "none",
};

const REGISTRY = new Map<string, ReportDefinition>();

export function registerReport(definition: ReportDefinition): void {
  if (REGISTRY.has(definition.code)) {
    throw new Error(`Report ${definition.code} is registered twice — two files are claiming one code.`);
  }
  REGISTRY.set(definition.code, definition);
}

export function getReport(code: string): ReportDefinition | undefined {
  return REGISTRY.get(code);
}

/** The catalog the report center renders — definitions without their rows. */
export function getCatalog(): Array<Omit<ReportDefinition, "query">> {
  return [...REGISTRY.values()]
    .map(({ code, name, group, description, columns, params, additive }) => ({
      code,
      name,
      group,
      description,
      columns,
      params: params ?? [],
      additive: additive ?? [],
    }))
    .sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name));
}

/**
 * Parse one report's declared parameters.
 *
 * The declaration is the contract, so the parse is derived from it: dates and
 * months are shape-checked here (a bad date is the client's problem, and a 422
 * beats a Mongo cast error three layers down), unknown keys are refused so a
 * typo cannot silently mean "all data", and the output is the clean record the
 * query functions read.
 */
export function parseParams(definition: ReportDefinition, input: ReportParams): ReportParams {
  const declared = definition.params ?? [];
  const out: Record<string, string> = {};

  for (const param of declared) {
    const raw = input[param.key];
    const value = typeof raw === "string" && raw.length > 0 ? raw : undefined;
    if (value === undefined) {
      if (param.required) {
        throw new AppError(
          422,
          "PARAM_REQUIRED",
          `${param.label} is required for ${definition.name}.`,
        );
      }
      continue;
    }
    if (param.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new AppError(422, "PARAM_INVALID", `${param.label} must look like 2026-04-17.`);
    }
    if (param.kind === "month" && !/^\d{4}-\d{2}$/.test(value)) {
      throw new AppError(422, "PARAM_INVALID", `${param.label} must look like 2026-04.`);
    }
    if (param.kind === "choice" && param.options && !param.options.some((option) => option.value === value)) {
      throw new AppError(422, "PARAM_INVALID", `${param.label} must be one of the offered choices.`);
    }
    if (param.kind === "account" && !/^\d{1,8}$/.test(value)) {
      throw new AppError(422, "PARAM_INVALID", `${param.label} must be an account code.`);
    }
    out[param.key] = value;
  }

  const known = new Set(declared.map((param) => param.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) {
      throw new AppError(422, "PARAM_UNKNOWN", `${definition.name} does not take a ${key} parameter.`);
    }
  }
  return out;
}

/** Small helper for the many reports that accept an optional date range. */
export function dateRange(params: ReportParams): { from?: string; to?: string } {
  const from = typeof params["from"] === "string" ? params["from"] : undefined;
  const to = typeof params["to"] === "string" ? params["to"] : undefined;
  return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
}

/**
 * Read a string parameter with a default.
 *
 * Reports receive the parsed parameter record, and every one of them would
 * otherwise repeat the same `typeof x === "string"` dance — with an off-by-one
 * chance of someone accepting an array as a date.
 */
export function paramString(params: ReportParams, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A parameter the report cannot run without.
 *
 * Thrown as a 422 rather than a plain `Error`, because "you did not choose an
 * account" is a problem with the request, not a fault in the server — and a
 * plain error would reach the client as "Something went wrong. Please try
 * again.", which tells whoever is looking at the screen nothing at all about
 * what to do next.
 */
export function requireParam(params: ReportParams, key: string, message: string): string {
  const value = paramString(params, key);
  if (value === undefined) {
    throw new AppError(422, "PARAM_REQUIRED", message);
  }
  return value;
}

/**
 * The from/to window a report reads its data through.
 *
 * Alias for `dateRange` under the name the query functions mean by it — a
 * window is a *parameter shape*, and naming it once here keeps the queries
 * reading uniformly.
 */
export const windowOf = dateRange;
