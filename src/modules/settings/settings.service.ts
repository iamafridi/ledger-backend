/**
 * Per-user settings. Currently just the DPS rate the app quotes returns at.
 */
import { z } from "zod";

import { DEFAULT_DPS_RATE, SettingsModel } from "./settings.model.js";
import { RateInput } from "../../shared/validation/schemas.js";
import { writeAudit } from "../../core/audit.js";

export const UpdateSettingsSchema = z.object({
  dps_annual_rate_percent: RateInput,
});

export interface SettingsView {
  dps_annual_rate_percent: string;
  currency: string;
  /** Present only when a published case has been loaded. */
  as_of_date?: string;
}

export async function getSettings(uid: string): Promise<SettingsView> {
  const found = await SettingsModel.findOne({ uid }).lean();
  return {
    dps_annual_rate_percent: found?.dps_annual_rate_percent ?? DEFAULT_DPS_RATE,
    currency: found?.currency ?? "BDT",
    ...(found?.as_of_date ? { as_of_date: found.as_of_date } : {}),
  };
}

export async function updateSettings(
  uid: string,
  input: z.output<typeof UpdateSettingsSchema>,
  orgId: string,
  ip?: string,
): Promise<SettingsView> {
  const before = await getSettings(uid);

  const saved = await SettingsModel.findOneAndUpdate(
    { uid },
    { $set: input },
    { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();

  const view: SettingsView = {
    dps_annual_rate_percent: saved!.dps_annual_rate_percent,
    currency: saved!.currency ?? "BDT",
  };

  // The DPS rate is quoted back to the user on every pocket projection, so
  // changing it is a change to figures the user has already read. It belongs in
  // the trail like any other financial setting.
  await writeAudit({
    orgId,
    uid,
    entity: "settings",
    entityId: uid,
    action: "SETTINGS_UPDATED",
    before,
    after: view,
    ...(ip ? { ip } : {}),
  });

  return view;
}
