/**
 * Gapless numbering — the service half of the MongoDB re-derivation of ADR 0002.
 *
 * ALLOCATION IS ONE ATOMIC OPERATION
 * `findOneAndUpdate` with `$inc` on the (org, kind, year) counter both reads and
 * increments in a single document operation, so two concurrent issuers cannot
 * observe the same value. There is no lock to order, no deadlock to avoid and no
 * snapshot to go stale — all of which the SQL original had to reason about
 * because `SELECT ... FOR UPDATE` and a separate `UPDATE` are two operations.
 *
 * THE UNIQUE INDEX IS THE FINAL ARBITER
 * The counter is an optimisation over a guarantee. If it were ever wrong, the
 * unique index on (org_id, kind, year, last_seq-equivalent) and on the emitted
 * number itself reject the write rather than letting a duplicate reach a
 * document a customer might pay against.
 *
 * NUMBERS ARE NEVER REUSED
 * The counter only ever increases, and the `MAX` fallback exists for imported
 * data: a workbook loaded with documents numbered past the counter must not be
 * re-issued over the top of. Cancellations do not roll the counter back — a gap
 * from a cancelled document is expected and far cheaper than a duplicate.
 */
import type { Types } from "mongoose";

import { SequenceCounterModel } from "./sequence.model.js";
import { numberingPrefix } from "../settings/org-settings.service.js";
import { AppError } from "../../shared/errors/app-error.js";

/** The document year comes from the business date, never the server clock —
 *  a December-dated entry issued in January belongs to December's sequence. */
function yearOf(date: string): number {
  return Number(date.slice(0, 4));
}

/**
 * `2026-7` → `2026-07`, growing naturally past two digits (`2026-100` valid),
 * with the organisation's prefix for this kind in front when it has claimed one
 * (`INV-2026-07`). The prefix is decoration on the printed number only: the
 * counter and its unique (org, kind, year) index never see it, so changing a
 * prefix mid-year continues the same sequence rather than restarting it.
 */
function format(prefix: string, year: number, seq: number): string {
  return `${prefix}${year}-${String(seq).padStart(2, "0")}`;
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000
  );
}

const collision = (kind: string, year: number): AppError =>
  new AppError(
    409,
    "NUMBERING_COLLISION",
    `Another ${kind} was numbered for ${year} at the same moment. Reload and try again.`,
  );

/**
 * Claim the next number for this organisation, kind and year.
 *
 * Call this **inside** the transaction or the request that creates the
 * document, and only at issue: a draft holds no number (ADR 0002 §1), so a
 * user who abandons ten drafts leaves no holes.
 */
export async function allocateNumber(
  orgId: string | Types.ObjectId,
  kind: string,
  date: string,
): Promise<{ number: string; year: number; seq: number }> {
  const year = yearOf(date);
  const prefix = await numberingPrefix(orgId, kind);

  let seq: number;
  try {
    const row = await SequenceCounterModel.findOneAndUpdate(
      { org_id: orgId, kind, year },
      { $inc: { last_seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    seq = row!.last_seq;
  } catch (error) {
    // Two upserts racing on a year with no counter row yet: one inserts, the
    // other loses on the unique index. The row now certainly exists, so the
    // retry needs no upsert — plain $inc continues the winner's sequence.
    if (!isDuplicateKey(error)) throw error;
    const row = await SequenceCounterModel.findOneAndUpdate(
      { org_id: orgId, kind, year },
      { $inc: { last_seq: 1 } },
      { new: true },
    ).lean();
    if (!row) throw collision(kind, year);
    seq = row.last_seq;
  }

  return { number: format(prefix, year, seq), year, seq };
}

/**
 * What the next number *would* be, without claiming it.
 *
 * A hint for a form's "next number" indicator, and nothing more: under
 * concurrency it can be stale, which is exactly why it must never be used to
 * allocate. The `MAX` fallback covers imported documents whose counter row has
 * not caught up.
 */
export async function peekNumber(
  orgId: string | Types.ObjectId,
  kind: string,
  date: string,
): Promise<string> {
  const year = yearOf(date);
  const prefix = await numberingPrefix(orgId, kind);

  const counter = await SequenceCounterModel.findOne({ org_id: orgId, kind, year }).lean();
  if (counter) return format(prefix, year, counter.last_seq + 1);

  // No counter yet: fall back to anything already issued for this year, so an
  // imported book does not restart at 01 on top of existing documents.
  const issued = await CollectionWithNumber(orgId, kind);
  const highest = await issued.maxForYear(year);
  return format(prefix, year, highest + 1);
}

/**
 * Highest sequence already recorded for a year, per document kind.
 *
 * Kept behind a tiny indirection so `peekNumber` does not need to know which
 * collection a kind lives in — the kinds are added as phases land (journal now,
 * invoice and bill in P3/P4) and this is the only place that changes.
 */
function CollectionWithNumber(orgId: string | Types.ObjectId, kind: string) {
  return {
    async maxForYear(year: number): Promise<number> {
      if (kind === "journal") {
        const { JournalEntryModel } = await import("../journals/journal.model.js");
        const rows = await JournalEntryModel.aggregate<{ m: number | null }>([
          { $match: { org_id: orgId, entry_year: year, entry_no: { $ne: null } } },
          { $group: { _id: null, m: { $max: "$entry_seq" } } },
        ]);
        return rows[0]?.m ?? 0;
      }
      // The sales documents all keep `doc_year`/`doc_seq`, so the "highest issued
      // this year" fallback is written once per collection rather than per kind.
      // It matters for the same reason as the journal's: an imported book whose
      // counter row has not caught up must not be re-issued over the top.
      if (kind === "invoice" || kind === "receipt" || kind === "credit_note") {
        const { CreditNoteModel, InvoiceModel, ReceiptModel } = await import("../sales/sales.model.js");
        const pipeline = (org: string | Types.ObjectId, y: number) => [
          { $match: { org_id: org, doc_year: y, doc_no: { $ne: null } } },
          { $group: { _id: null, m: { $max: "$doc_seq" } } },
        ];

        if (kind === "invoice") {
          const rows = await InvoiceModel.aggregate<{ m: number | null }>(pipeline(orgId, year));
          return rows[0]?.m ?? 0;
        }
        if (kind === "receipt") {
          const rows = await ReceiptModel.aggregate<{ m: number | null }>(pipeline(orgId, year));
          return rows[0]?.m ?? 0;
        }
        const rows = await CreditNoteModel.aggregate<{ m: number | null }>(pipeline(orgId, year));
        return rows[0]?.m ?? 0;
      }
      // The payables documents keep the same `doc_year`/`doc_seq` pair, so the
      // fallback is the same query against a different collection (P4).
      if (kind === "bill" || kind === "payment" || kind === "debit_note") {
        const { BillModel, DebitNoteModel, PaymentModel } = await import("../purchases/purchases.model.js");
        const pipeline = (org: string | Types.ObjectId, y: number) => [
          { $match: { org_id: org, doc_year: y, doc_no: { $ne: null } } },
          { $group: { _id: null, m: { $max: "$doc_seq" } } },
        ];

        if (kind === "bill") {
          const rows = await BillModel.aggregate<{ m: number | null }>(pipeline(orgId, year));
          return rows[0]?.m ?? 0;
        }
        if (kind === "payment") {
          const rows = await PaymentModel.aggregate<{ m: number | null }>(pipeline(orgId, year));
          return rows[0]?.m ?? 0;
        }
        const rows = await DebitNoteModel.aggregate<{ m: number | null }>(pipeline(orgId, year));
        return rows[0]?.m ?? 0;
      }
      // The tax documents (P7) keep the same `doc_year`/`doc_seq` pair, so the
      // fallback is again the same query against a different collection.
      if (kind === "challan" || kind === "tax_certificate") {
        const { TaxCertificateModel, TaxChallanModel } = await import("../tax/tax.model.js");
        const pipeline = (org: string | Types.ObjectId, y: number) => [
          { $match: { org_id: org, doc_year: y, doc_no: { $ne: null } } },
          { $group: { _id: null, m: { $max: "$doc_seq" } } },
        ];

        const rows =
          kind === "challan"
            ? await TaxChallanModel.aggregate<{ m: number | null }>(pipeline(orgId, year))
            : await TaxCertificateModel.aggregate<{ m: number | null }>(pipeline(orgId, year));
        return rows[0]?.m ?? 0;
      }
      // Transfers number their own document (P6), so the peeking fallback reads
      // that collection the same way as every other document kind.
      if (kind === "transfer") {
        const { TransferModel } = await import("../banking/banking.model.js");
        const rows = await TransferModel.aggregate<{ m: number | null }>([
          { $match: { org_id: orgId, doc_year: year, doc_no: { $ne: null } } },
          { $group: { _id: null, m: { $max: "$doc_seq" } } },
        ]);
        return rows[0]?.m ?? 0;
      }
      return 0;
    },
  };
}
