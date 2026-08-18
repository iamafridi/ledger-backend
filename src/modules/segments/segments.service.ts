import { z } from "zod";
import mongoose from "mongoose";

import { SegmentModel, SEGMENT_TYPES, type SegmentDocument } from "./segments.model.js";
import { writeAudit } from "../../core/audit.js";
import { AppError, notFoundError } from "../../shared/errors/app-error.js";

export const CreateSegmentSchema = z.object({
  code: z
    .string()
    .trim()
    .min(1, "A segment needs a code.")
    .max(32)
    .regex(/^[A-Za-z0-9-_]+$/, "Codes are letters, digits, underscores, and dashes.")
    .transform((val) => val.toUpperCase()),
  name: z.string().trim().min(2, "Give the segment a name.").max(120),
  type: z.enum(SEGMENT_TYPES).default("BRANCH"),
  description: z.string().trim().max(300).default(""),
});

export const UpdateSegmentSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  type: z.enum(SEGMENT_TYPES).optional(),
  description: z.string().trim().max(300).optional(),
  is_active: z.boolean().optional(),
});

export type CreateSegmentInput = z.output<typeof CreateSegmentSchema>;
export type UpdateSegmentInput = z.output<typeof UpdateSegmentSchema>;

export interface SegmentView {
  id: string;
  code: string;
  name: string;
  type: string;
  description: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

function toView(doc: any): SegmentView {
  return {
    id: String(doc._id),
    code: doc.code,
    name: doc.name,
    type: doc.type,
    description: doc.description ?? "",
    is_active: Boolean(doc.is_active),
    created_at: doc.createdAt?.toISOString?.() ?? new Date().toISOString(),
    updated_at: doc.updatedAt?.toISOString?.() ?? new Date().toISOString(),
  };
}

export async function listSegments(
  orgId: string,
  options?: { type?: string; activeOnly?: boolean },
): Promise<SegmentView[]> {
  const query: Record<string, unknown> = {
    org_id: new mongoose.Types.ObjectId(orgId),
  };
  if (options?.type) {
    query["type"] = options.type;
  }
  if (options?.activeOnly) {
    query["is_active"] = true;
  }

  const docs = await SegmentModel.find(query).sort({ type: 1, code: 1 }).lean();
  return docs.map((d) => toView(d as unknown as SegmentDocument));
}

export async function getSegmentById(orgId: string, id: string): Promise<SegmentView> {
  const doc = await SegmentModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    org_id: new mongoose.Types.ObjectId(orgId),
  });
  if (!doc) {
    throw notFoundError("Segment not found.");
  }
  return toView(doc);
}

export async function createSegment(
  orgId: string,
  input: CreateSegmentInput,
  actor: { uid: string; ip: string },
): Promise<SegmentView> {
  const existing = await SegmentModel.findOne({
    org_id: new mongoose.Types.ObjectId(orgId),
    code: input.code,
  });
  if (existing) {
    throw new AppError(409, "SEGMENT_CODE_EXISTS", `Segment code ${input.code} is already in use.`);
  }

  const created = await SegmentModel.create({
    org_id: new mongoose.Types.ObjectId(orgId),
    code: input.code,
    name: input.name,
    type: input.type,
    description: input.description,
    is_active: true,
  });

  await writeAudit({
    orgId,
    entity: "segment",
    entityId: String(created._id),
    action: "create",
    before: null,
    after: created.toObject(),
    uid: actor.uid,
    ip: actor.ip,
  });

  return toView(created);
}

export async function updateSegment(
  orgId: string,
  id: string,
  input: UpdateSegmentInput,
  actor: { uid: string; ip: string },
): Promise<SegmentView> {
  const existing = await SegmentModel.findOne({
    _id: new mongoose.Types.ObjectId(id),
    org_id: new mongoose.Types.ObjectId(orgId),
  });
  if (!existing) {
    throw notFoundError("Segment not found.");
  }

  const before = existing.toObject();

  if (input.name !== undefined) existing.name = input.name;
  if (input.type !== undefined) existing.type = input.type;
  if (input.description !== undefined) existing.description = input.description;
  if (input.is_active !== undefined) existing.is_active = input.is_active;

  await existing.save();

  await writeAudit({
    orgId,
    entity: "segment",
    entityId: String(existing._id),
    action: "update",
    before,
    after: existing.toObject(),
    uid: actor.uid,
    ip: actor.ip,
  });

  return toView(existing);
}
