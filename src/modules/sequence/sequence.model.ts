import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

/**
 * Gapless document numbers — the MongoDB re-derivation of ADR 0002.
 *
 * The SQL original serialises allocators with `SELECT ... FOR UPDATE` over a
 * per-year row, and its reasoning (gap locks, deadlock ordering, consistent-read
 * snapshots) does not transfer to MongoDB at all. Here the whole allocation is
 * one atomic `findOneAndUpdate` with `$inc`, which has no equivalent failure
 * mode: there is no lock to deadlock on and no snapshot to go stale, because
 * the read and the increment are a single operation against a single document.
 *
 * The unique index on (org_id, kind, year) is the backstop the ADR asks for —
 * if the counter were ever wrong, the insert is rejected rather than quietly
 * issuing a duplicate number.
 *
 * One counter row per (organisation, document kind, year). Numbers restart at 01
 * each year, are monotonic within it, and are never reused: a cancelled
 * document keeps its number, which is why the counter is never decremented.
 */
const sequenceCounterSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true },
    /** "journal", "invoice", "bill", ... — one counter family per kind. */
    kind: { type: String, required: true, trim: true, maxlength: 32 },
    year: { type: Number, required: true, min: 1970 },
    last_seq: { type: Number, required: true, default: 0, min: 0 },
  },
  { timestamps: true, versionKey: false },
);

sequenceCounterSchema.index({ org_id: 1, kind: 1, year: 1 }, { unique: true });

export type SequenceCounterDocument = InferSchemaType<typeof sequenceCounterSchema>;

export const SequenceCounterModel =
  (mongoose.models["SequenceCounter"] as Model<SequenceCounterDocument> | undefined) ??
  mongoose.model<SequenceCounterDocument>("SequenceCounter", sequenceCounterSchema);
