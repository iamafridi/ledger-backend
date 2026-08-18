import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

export const SEGMENT_TYPES = ["BRANCH", "DEPARTMENT", "PROJECT", "COST_CENTER"] as const;
export type SegmentType = (typeof SEGMENT_TYPES)[number];

const segmentSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    code: { type: String, required: true, trim: true, uppercase: true, maxlength: 32 },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, required: true, enum: SEGMENT_TYPES, default: "BRANCH" },
    description: { type: String, trim: true, maxlength: 300, default: "" },
    is_active: { type: Boolean, required: true, default: true },
  },
  { timestamps: true, versionKey: false },
);

segmentSchema.index({ org_id: 1, code: 1 }, { unique: true });
segmentSchema.index({ org_id: 1, type: 1, is_active: 1 });

export type SegmentDocument = InferSchemaType<typeof segmentSchema>;

export const SegmentModel =
  (mongoose.models["Segment"] as Model<SegmentDocument> | undefined) ??
  mongoose.model<SegmentDocument>("Segment", segmentSchema);
