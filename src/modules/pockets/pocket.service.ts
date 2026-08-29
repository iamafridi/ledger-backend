/**
 * Savings pockets — required item 4's storage half. The projection half (the
 * completion date and the DPS return) is computed by the engine and served from
 * the dashboard module, because both need the forecast.
 */
import { z } from "zod";

import { PocketModel } from "./pocket.model.js";
import { notFoundError } from "../../shared/errors/app-error.js";
import { MoneyInput, ObjectIdInput } from "../../shared/validation/schemas.js";

export const CreatePocketSchema = z.object({
  name: z.string().trim().min(1, "Give the pocket a name.").max(80),
  item: z.string().trim().min(1, "What are you saving for?").max(300),
  target_bdt: MoneyInput,
  monthly_contribution_bdt: MoneyInput,
  saved_bdt: MoneyInput.optional(),
});

export const UpdatePocketSchema = CreatePocketSchema.partial();

export interface PocketView {
  id: string;
  name: string;
  item: string;
  target_bdt: string;
  monthly_contribution_bdt: string;
  saved_bdt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toView(doc: any): PocketView {
  return {
    id: String(doc._id),
    name: doc.name,
    item: doc.item,
    target_bdt: doc.target_bdt,
    monthly_contribution_bdt: doc.monthly_contribution_bdt,
    saved_bdt: doc.saved_bdt ?? "0.00",
  };
}

export async function listPockets(uid: string): Promise<PocketView[]> {
  const docs = await PocketModel.find({ uid }).sort({ createdAt: 1 }).lean();
  return docs.map(toView);
}

export async function createPocket(
  uid: string,
  input: z.output<typeof CreatePocketSchema>,
): Promise<PocketView> {
  const created = await PocketModel.create({
    ...input,
    saved_bdt: input.saved_bdt ?? "0.00",
    uid,
  });
  return toView(created.toObject());
}

export async function updatePocket(
  uid: string,
  id: string,
  input: z.output<typeof UpdatePocketSchema>,
): Promise<PocketView> {
  ObjectIdInput.parse(id);
  const updated = await PocketModel.findOneAndUpdate({ _id: id, uid }, input, {
    new: true,
    runValidators: true,
  }).lean();

  if (!updated) throw notFoundError("That savings pocket does not exist.");
  return toView(updated);
}

export async function deletePocket(uid: string, id: string): Promise<void> {
  ObjectIdInput.parse(id);
  const result = await PocketModel.deleteOne({ _id: id, uid });
  if (result.deletedCount === 0) throw notFoundError("That savings pocket does not exist.");
}
