/**
 * Roles and permissions — the Phase 0 authorization matrix.
 *
 * Firebase proves *who* the caller is; it says nothing about *what they may do*.
 * Firebase custom claims are the wrong tool for that: claims are baked into the
 * ID token, so demoting somebody would not take effect until their token
 * refreshed — up to an hour later, during which they keep the old powers. Roles
 * therefore live in this database and are re-read on every request, so a role
 * change is immediate and auditable.
 *
 * Four seeded roles, shaped like a small business rather than an enterprise:
 *
 *   OWNER       owns the data and the organisation
 *   ADMIN       runs the organisation alongside the owner
 *   ACCOUNTANT  does the books; cannot change the org or org-wide settings
 *   VIEWER      reads, changes nothing
 *
 * The matrix reads as "who may do X", least privilege first: every code names
 * the roles that hold it, and anything not listed is held by nobody.
 *
 * Later phases add codes as their modules land (`journals.create` in P1,
 * `reports.export` in P5, `periods.close` in P1... ). A permission no route
 * checks yet is dead weight, so this file only ever names codes that some
 * route actually enforces today.
 */

export const ROLES = ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"] as const;

export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "dashboard.view",
  "insights.view",
  "expenses.read",
  "expenses.write",
  "salary.read",
  "salary.write",
  "receipts.scan",
  "pockets.read",
  "pockets.write",
  "settings.read",
  "settings.manage",
  "org.read",
  "org.manage",
  "members.read",
  "members.manage",
  "audit.read",
  "demo.manage",
  "coa.read",
  "coa.write",
  "masterdata.read",
  "masterdata.write",
  "journals.read",
  "journals.write",
  "periods.read",
  "periods.close",
  "reports.view",
  "reports.export",
  "sales.read",
  "sales.write",
  "purchases.read",
  "purchases.write",
  "banking.read",
  "banking.write",
  "tax.read",
  "tax.write",
  "tax.export",
  "inventory.read",
  "inventory.write",
  "inventory.adjust",
  "assets.read",
  "assets.write",
  "advances.read",
  "advances.write",
  "staff.read",
  "staff.write",
  "recurring.read",
  "recurring.write",
  "budgets.read",
  "budgets.write",
  "segments.read",
  "segments.write",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** OWNER and ADMIN are identical at Phase 0. They diverge when ownership
 *  transfer and destructive organisation actions arrive, which is deliberately
 *  not built yet. */
const OWNER_ADMIN_ACCOUNTANT: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT"];
const OWNER_ADMIN: readonly Role[] = ["OWNER", "ADMIN"];
const EVERYONE: readonly Role[] = ["OWNER", "ADMIN", "ACCOUNTANT", "VIEWER"];

const MATRIX: Readonly<Record<Permission, readonly Role[]>> = {
  "dashboard.view": EVERYONE,
  "insights.view": EVERYONE,
  "expenses.read": EVERYONE,
  "salary.read": EVERYONE,
  "pockets.read": EVERYONE,
  "settings.read": EVERYONE,
  "org.read": EVERYONE,
  "coa.read": EVERYONE,
  "masterdata.read": EVERYONE,
  "journals.read": EVERYONE,
  "periods.read": EVERYONE,
  "reports.view": EVERYONE,
  // Reading a receivable is reading the books, which every role may do — a
  // VIEWER who cannot see who owes money cannot answer the only question the
  // sales screen exists to answer. Issuing, correcting and voiding is the
  // accountant's work, the same line the chart of accounts draws.
  "sales.read": EVERYONE,
  // The payables mirror, on the same reasoning: what we owe is part of the
  // books, and a person who cannot see it cannot answer "can we pay this?".
  "purchases.read": EVERYONE,
  // What the bank holds is, again, just the books: the cash position is the
  // balance of an asset account. Reconciliation is reading too — the decisions
  // it records are the write, below.
  "banking.read": EVERYONE,
  // What tax a month came to is, like every other figure here, just the books:
  // a person who cannot see the VAT position cannot answer for it. Depositing
  // it and certifying it are the accountant's acts, below.
  "tax.read": EVERYONE,
  // What is on the shelf is, again, just the books — the balance of an asset
  // account read at the quantity level. A person who cannot see it cannot answer
  // "have we got any left?".
  "inventory.read": EVERYONE,

  "expenses.write": OWNER_ADMIN_ACCOUNTANT,
  "salary.write": OWNER_ADMIN_ACCOUNTANT,
  "pockets.write": OWNER_ADMIN_ACCOUNTANT,
  "receipts.scan": OWNER_ADMIN_ACCOUNTANT,
  "demo.manage": OWNER_ADMIN_ACCOUNTANT,
  "members.read": OWNER_ADMIN_ACCOUNTANT,
  "coa.write": OWNER_ADMIN_ACCOUNTANT,
  "masterdata.write": OWNER_ADMIN_ACCOUNTANT,
  "journals.write": OWNER_ADMIN_ACCOUNTANT,
  "sales.write": OWNER_ADMIN_ACCOUNTANT,
  // Walking out with the whole ledger as a file is one step past reading it on
  // screen: a CSV leaves the building and can be forwarded anywhere. The same
  // line the chart of accounts draws — the accountant's work, not the viewer's.
  "reports.export": OWNER_ADMIN_ACCOUNTANT,
  "purchases.write": OWNER_ADMIN_ACCOUNTANT,
  // Moving money between accounts, importing a statement and posting the
  // correction a statement line proves is missing all write to the ledger, and
  // they are the accountant's work like every other posting.
  "banking.write": OWNER_ADMIN_ACCOUNTANT,
  // Recording a challan moves money to the government, and issuing a
  // certificate hands a supplier a numbered document they will file. Both are
  // postings or documents, so both sit on the accountant's side of the line.
  "tax.write": OWNER_ADMIN_ACCOUNTANT,
  // A return that leaves the building as a file is one step past reading it on
  // screen — the same reasoning as `reports.export`.
  "tax.export": OWNER_ADMIN_ACCOUNTANT,
  // Moving goods between your own warehouses changes where they are and not what
  // they are worth, so it is ordinary work like any other document write.
  "inventory.write": OWNER_ADMIN_ACCOUNTANT,
  // The fixed-asset register reads the same way: what the organisation owns and
  // how much of it is left is the balance of an asset account, and a person who
  // cannot see it cannot answer for the balance sheet.
  "assets.read": EVERYONE,
  // Registering, depreciating, reversing a run and disposing are all postings or
  // documents, so they sit on the accountant's side of the line. Disposal is on
  // this code rather than a narrower one on purpose: unlike a stock adjustment it
  // carries a reason, a date and proceeds — the machinery of a trade, not value
  // moving with nothing to explain it.
  "assets.write": OWNER_ADMIN_ACCOUNTANT,
  // The exception, and deliberately narrower: an adjustment and a posted
  // stocktake variance move the value of the balance sheet with no document to
  // explain them. That is the owner's signature, the same line `periods.close`
  // draws — an accountant keeps the books, the person who answers for them signs
  // off on the value moving without a trade.
  "inventory.adjust": OWNER_ADMIN,
  // What we are holding for a party is, like a fixed-asset register, just the
  // books — the credit side of an account — and a person who cannot see it
  // cannot answer "how much of their money is with us?". Recording a manual
  // advance, claiming one against a document or reversing a claim all write to
  // the sub-ledger and sit on the accountant's side of the line.
  "advances.read": EVERYONE,
  "advances.write": OWNER_ADMIN_ACCOUNTANT,
  // Payroll (P11) reads like everything else that is just the books: who is on
  // the payroll, what they were paid and what they still owe the organisation
  // is a set of balances, and a person who cannot see them cannot answer for
  // them. Running payroll, paying it, reversing it and recording a loan are all
  // postings, so they sit on the accountant's side of the line — the same line
  // `periods.close` draws above for the acts that move value without a trade.
  "staff.read": EVERYONE,
  "staff.write": OWNER_ADMIN_ACCOUNTANT,

  // Recurring entries, Segments & Budgets (P12)
  "recurring.read": EVERYONE,
  "recurring.write": OWNER_ADMIN_ACCOUNTANT,
  "segments.read": EVERYONE,
  "segments.write": OWNER_ADMIN_ACCOUNTANT,
  "budgets.read": EVERYONE,
  "budgets.write": OWNER_ADMIN_ACCOUNTANT,

  "settings.manage": OWNER_ADMIN,
  "org.manage": OWNER_ADMIN,
  "members.manage": OWNER_ADMIN,
  "audit.read": OWNER_ADMIN,
  // Closing a period locks the books, so it is an owner/admin act rather than
  // an accountant one: the person who answers for the books signs off on them.
  "periods.close": OWNER_ADMIN,
};

/** Every permission a role holds, in declaration order. */
export function permissionsFor(role: Role): Permission[] {
  return PERMISSIONS.filter((permission) => MATRIX[permission].includes(role));
}

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[permission].includes(role);
}

/** Narrow an untrusted string (a request body, a database row) to a Role. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/**
 * The default role for the organisation a user creates for themselves.
 * They are the OWNER: nothing else would let them administer the account they
 * just signed up for.
 */
export const DEFAULT_ROLE: Role = "OWNER";
