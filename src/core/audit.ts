import mongoose, { Schema, type ClientSession, type InferSchemaType, type Model } from "mongoose";

/**
 * The audit trail — who changed what, when, from where, and what it was before.
 *
 * APPEND-ONLY IS ENFORCED, NOT POLICIED.
 * There is no legitimate reason to edit or remove an audit row: its whole value
 * is that it describes a past that can no longer be argued with. A bug or a
 * stray query that "tidied up" the log would silently destroy that, so every
 * mutating hook on this schema throws rather than relying on nobody writing the
 * wrong call. The only supported operation is `create`.
 *
 * MongoDB has no equivalent of a SQL `BEFORE UPDATE` trigger, so the hooks below
 * are the closest available mechanism. They are a guard against accidents, not
 * against a hostile process with the connection string — nothing at the
 * application layer can defend against that.
 *
 * TWO WAYS OF CALLING THIS, AND WHICH IS WHICH
 *
 * Pass a `session` when the action being recorded is itself transactional —
 * that is what `core/posting.ts` does, so a journal entry, its lines and its
 * audit row commit together or not at all. An audit row that survived a failed
 * posting would describe an entry that does not exist.
 *
 * Omit the session for Phase 0's single-document mutations (expense, salary,
 * settings, organisation), which are one write each and have no transaction to
 * join. There the row is written immediately after the mutation, and a failure
 * here surfaces to the caller rather than passing silently — the cost of the
 * gap, stated plainly, is that such a mutation and its audit row are not atomic.
 */
const auditLogSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    /** The acting user, from the verified token — never from the request body. */
    uid: { type: String, required: true, trim: true, index: true },
    /** Dotted entity name, e.g. "expense", "settings", "org.membership". */
    entity: { type: String, required: true, trim: true, maxlength: 80 },
    entity_id: { type: String, default: "", maxlength: 64 },
    action: { type: String, required: true, trim: true, maxlength: 64 },
    before: { type: Schema.Types.Mixed },
    after: { type: Schema.Types.Mixed },
    ip: { type: String, default: "", maxlength: 64 },
  },
  { timestamps: true, versionKey: false },
);

auditLogSchema.index({ org_id: 1, entity: 1, createdAt: -1 });
auditLogSchema.index({ org_id: 1, uid: 1, createdAt: -1 });

const APPEND_ONLY_MESSAGE =
  "audit_log is append-only: audit rows can be created but never updated or deleted.";

const BLOCKED_OPERATIONS = [
  "updateOne",
  "updateMany",
  "replaceOne",
  "findOneAndUpdate",
  "findOneAndReplace",
  "deleteOne",
  "deleteMany",
  "findOneAndDelete",
] as const;

for (const operation of BLOCKED_OPERATIONS) {
  // `{ document: true, query: true }` so both `Model.updateOne(...)` and
  // `AuditLog.updateOne(...)` on a found document are blocked.
  auditLogSchema.pre(operation, { document: true, query: true }, function () {
    throw new Error(APPEND_ONLY_MESSAGE);
  });
}

export type AuditLogDocument = InferSchemaType<typeof auditLogSchema>;

export const AuditLogModel =
  (mongoose.models["AuditLog"] as Model<AuditLogDocument> | undefined) ??
  mongoose.model<AuditLogDocument>("AuditLog", auditLogSchema);

export interface AuditInput {
  orgId: string;
  uid: string;
  entity: string;
  entityId?: string;
  action: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
}

/**
 * Record one audited action.
 *
 * Call this immediately after the mutation it describes, with `before`/`after`
 * as plain serialisable snapshots. Amounts must already be canonical 2dp
 * strings — the audit row stores what was written, not a re-derived value.
 *
 * @param session Join an outer transaction. Required for anything posted
 *                 through `core/posting.ts`; omit for single-document writes.
 */
export async function writeAudit(input: AuditInput, session?: ClientSession | null): Promise<void> {
  await AuditLogModel.create(
    [
      {
        org_id: input.orgId,
        uid: input.uid,
        entity: input.entity,
        entity_id: input.entityId ?? "",
        action: input.action,
        before: input.before,
        after: input.after,
        ip: input.ip ?? "",
      },
    ],
    session ? { session } : undefined,
  );
}
