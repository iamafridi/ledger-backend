/**
 * Transfers between the organisation's own accounts (plan §6, Phase 6).
 *
 * ONE ENTRY, NOT TWO
 * Moving 10,000 from Bank A to Bank B is a single event, so it posts a single
 * balanced journal entry: debit Bank B, credit Bank A. Writing two entries —
 * money out, money in — is how a half-failed transfer invents 10,000, and no
 * amount of later reconciliation makes that look like anything else.
 *
 * A FEE IS PART OF THE SAME ENTRY
 * A wire usually costs something. The fee debits an expense account (5500 by
 * default) inside the *same* entry that moves the money, so the source account's
 * credit is the full amount that left it: 10,000 transferred with a 50 fee
 * credits 10,050. Posting the fee separately would leave the bank account
 * overstated by 50 until somebody remembered, which is exactly the kind of gap a
 * reconciliation is supposed to be spent on real items, not our own.
 *
 * A TRANSFER IS NEVER DELETED
 * It is voided, which reverses the entry (ADR 0002 / rule 8) and keeps both rows
 * visible. A transfer that never happened must still be explainable a year later.
 */
import { z } from "zod";

import { BankAccountModel, TransferModel } from "./banking.model.js";
import { requireAccountByCode } from "../coa/coa.service.js";
import { inTransaction, postJournal, voidEntry } from "../../core/posting.js";
import { writeAudit } from "../../core/audit.js";
import { add, fmt, money, ZERO } from "../../core/money.js";
import { allocateNumber } from "../sequence/sequence.service.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";
import { DateInput, MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";
import { assertObjectId } from "../../shared/validation/validation.js";

/** The expense account a transfer fee lands in when none is named. */
const DEFAULT_FEE_ACCOUNT = "5500";

export const CreateTransferSchema = z.object({
  from_account_id: ObjectIdInput,
  to_account_id: ObjectIdInput,
  date: DateInput,
  amount_bdt: MoneyInput,
  fee_bdt: MoneyInput.default("0.00"),
  /** Blank picks 5500 (Bank Charges). Only read when a fee is charged. */
  fee_account_code: z.string().trim().max(24).default(""),
  memo: z.string().trim().max(300).default(""),
});

export const ListTransferQuery = z.object({
  bank_account_id: ObjectIdInput.optional(),
  from: DateInput.optional(),
  to: DateInput.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

export const VoidTransferSchema = z.object({
  reason: z.string().trim().min(3, "Give a short reason for voiding this transfer.").max(300),
});

export type CreateTransferInput = z.output<typeof CreateTransferSchema>;

export interface TransferView {
  id: string;
  doc_no: string;
  date: string;
  from_account_id: string;
  from_account_code: string;
  from_name: string;
  to_account_id: string;
  to_account_code: string;
  to_name: string;
  amount_bdt: string;
  fee_bdt: string;
  fee_account_code: string;
  memo: string;
  status: "POSTED" | "VOID";
  journal_entry_id: string | null;
  void_reason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function toView(orgId: string, doc: any): Promise<TransferView> {
  const [from, to] = await Promise.all([
    BankAccountModel.findOne({ _id: doc.from_account_id, org_id: orgId }).lean(),
    BankAccountModel.findOne({ _id: doc.to_account_id, org_id: orgId }).lean(),
  ]);

  return {
    id: String(doc._id),
    doc_no: doc.doc_no,
    date: doc.date,
    from_account_id: String(doc.from_account_id),
    from_account_code: doc.from_account_code,
    from_name: from?.name ?? "",
    to_account_id: String(doc.to_account_id),
    to_account_code: doc.to_account_code,
    to_name: to?.name ?? "",
    amount_bdt: doc.amount_bdt,
    fee_bdt: doc.fee_bdt ?? "0.00",
    fee_account_code: doc.fee_account_code ?? "",
    memo: doc.memo ?? "",
    status: doc.status,
    journal_entry_id: doc.journal_entry_id ? String(doc.journal_entry_id) : null,
    void_reason: doc.void_reason ?? "",
  };
}

/**
 * Record and post a transfer.
 *
 * Validation happens before the transaction opens so a rejected transfer leaves
 * nothing behind — including no claimed number, which is the reason the number
 * is allocated inside it rather than on the way in.
 */
export async function createTransfer(
  orgId: string,
  uid: string,
  input: CreateTransferInput,
  ip?: string,
): Promise<TransferView> {
  if (input.from_account_id === input.to_account_id) {
    throw new AppError(
      422,
      "SAME_ACCOUNT",
      "A transfer needs two different accounts — moving money to where it already is does nothing.",
    );
  }

  const [from, to] = await Promise.all([
    BankAccountModel.findOne({ _id: input.from_account_id, org_id: orgId }).lean(),
    BankAccountModel.findOne({ _id: input.to_account_id, org_id: orgId }).lean(),
  ]);
  if (!from) throw notFoundError("The account the money leaves does not exist.");
  if (!to) throw notFoundError("The account the money arrives in does not exist.");
  for (const account of [from, to]) {
    if (account.is_active === false) {
      throw new AppError(422, "ACCOUNT_INACTIVE", `${account.name} is inactive, so it cannot take part in a transfer.`);
    }
  }

  const amount = money(input.amount_bdt);
  // `greaterThan(ZERO)`, not `isPositive()`: decimal.js stores the sign of
  // "0.00" as positive, so `isPositive()` is true for zero and would let a
  // zero-amount transfer through to fail later inside the posting engine.
  if (!amount.greaterThan(ZERO)) {
    throw new AppError(422, "INVALID_AMOUNT", "A transfer needs an amount greater than zero.");
  }
  const fee = money(input.fee_bdt);
  if (fee.isNegative()) {
    throw new AppError(422, "INVALID_AMOUNT", "A transfer fee cannot be negative.");
  }

  // Only resolved when it will actually be used: a fee account that has since
  // been deactivated must not block a fee-free transfer.
  let feeAccountCode = "";
  if (fee.greaterThan(ZERO)) {
    const feeAccount = await requireAccountByCode(orgId, input.fee_account_code || DEFAULT_FEE_ACCOUNT);
    if (feeAccount.type !== "EXPENSE") {
      throw new AppError(
        422,
        "ACCOUNT_NOT_EXPENSE",
        `${feeAccount.code} (${feeAccount.name}) is a ${feeAccount.type.toLowerCase()} account. A transfer fee is a cost, so it lands in an expense account.`,
      );
    }
    feeAccountCode = feeAccount.code;
  }

  return inTransaction(async (session) => {
    const allocation = await allocateNumber(orgId, "transfer", input.date);
    const description = `Transfer ${allocation.number} — ${from.name} to ${to.name}`;

    const created = await TransferModel.create(
      [
        {
          org_id: orgId,
          doc_no: allocation.number,
          doc_year: allocation.year,
          doc_seq: allocation.seq,
          from_account_id: from._id,
          to_account_id: to._id,
          from_account_code: from.account_code,
          to_account_code: to.account_code,
          date: input.date,
          amount_bdt: fmt(amount),
          fee_bdt: fmt(fee),
          fee_account_code: feeAccountCode,
          memo: input.memo,
          status: "POSTED",
          journal_entry_id: null,
          created_by: uid,
        },
      ],
      { session },
    ).then((rows) => rows[0]!);

    const lines = [
      { account_code: to.account_code, debit_bdt: fmt(amount), memo: description },
      ...(fee.greaterThan(ZERO)
        ? [{ account_code: feeAccountCode, debit_bdt: fmt(fee), memo: `${description} — fee` }]
        : []),
      // The credit is amount + fee: everything that actually left the source.
      { account_code: from.account_code, credit_bdt: fmt(add(amount, fee)), memo: description },
    ];

    const entry = await postJournal(
      {
        orgId,
        uid,
        date: input.date,
        description,
        source: "TRANSFER",
        source_id: String(created._id),
        lines,
        ...(ip ? { ip } : {}),
      },
      session,
    );

    const updated = await TransferModel.findOneAndUpdate(
      { _id: created._id, org_id: orgId },
      { $set: { journal_entry_id: entry.id } },
      { new: true, session },
    ).lean();
    if (!updated) throw notFoundError("That transfer does not exist.");

    const view = await toView(orgId, updated);
    await writeAudit(
      {
        orgId,
        uid,
        entity: "banking.transfer",
        entityId: view.id,
        action: "TRANSFER_POSTED",
        after: {
          doc_no: view.doc_no,
          from: view.from_account_code,
          to: view.to_account_code,
          amount_bdt: view.amount_bdt,
          fee_bdt: view.fee_bdt,
        },
        ...(ip ? { ip } : {}),
      },
      session,
    );

    return view;
  });
}

export async function voidTransfer(
  orgId: string,
  uid: string,
  id: string,
  reason: string,
  ip?: string,
): Promise<TransferView> {
  assertObjectId(id, "That transfer does not exist.");

  return inTransaction(async (session) => {
    const transfer = await TransferModel.findOne({ _id: id, org_id: orgId }).session(session).lean();
    if (!transfer) throw notFoundError("That transfer does not exist.");
    if (transfer.status === "VOID") {
      throw new AppError(409, "ALREADY_VOID", "That transfer has already been voided.");
    }

    if (transfer.journal_entry_id) {
      await voidEntry(orgId, uid, String(transfer.journal_entry_id), reason, ip, session);
    }

    const updated = await TransferModel.findOneAndUpdate(
      { _id: id, org_id: orgId, status: { $ne: "VOID" } },
      { $set: { status: "VOID", void_reason: reason.trim(), voided_by: uid, voided_at: new Date() } },
      { new: true, session },
    ).lean();
    if (!updated) {
      throw new AppError(409, "ALREADY_VOID", "That transfer was voided by another request a moment ago.");
    }

    const view = await toView(orgId, updated);
    await writeAudit(
      {
        orgId,
        uid,
        entity: "banking.transfer",
        entityId: view.id,
        action: "TRANSFER_VOIDED",
        before: { status: "POSTED", doc_no: transfer.doc_no },
        after: { status: "VOID", reason: reason.trim() },
        ...(ip ? { ip } : {}),
      },
      session,
    );
    return view;
  });
}

export async function getTransfer(orgId: string, id: string): Promise<TransferView> {
  assertObjectId(id, "That transfer does not exist.");
  const doc = await TransferModel.findOne({ _id: id, org_id: orgId }).lean();
  if (!doc) throw notFoundError("That transfer does not exist.");
  return toView(orgId, doc);
}

export async function listTransfers(
  orgId: string,
  query: z.output<typeof ListTransferQuery>,
): Promise<TransferView[]> {
  const filter: Record<string, unknown> = { org_id: orgId };
  if (query.bank_account_id) {
    filter["$or"] = [
      { from_account_id: query.bank_account_id },
      { to_account_id: query.bank_account_id },
    ];
  }
  if (query.from || query.to) {
    const range: Record<string, string> = {};
    if (query.from) range["$gte"] = query.from;
    if (query.to) range["$lte"] = query.to;
    filter["date"] = range;
  }

  const rows = await TransferModel.find(filter).sort({ date: -1, doc_seq: -1 }).limit(query.limit).lean();
  return Promise.all(rows.map((row) => toView(orgId, row)));
}
