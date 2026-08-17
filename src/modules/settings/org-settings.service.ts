/**
 * Organisation profile settings — what a document prints about the business,
 * and how its numbers are prefixed.
 *
 * The profile straddles two rows on purpose: `name` and `base_currency` live on
 * the organisation itself (they are identity, read everywhere), while address,
 * logo, BIN/TIN, VAT mode and numbering prefixes live in `OrgSettings` and are
 * read only where they are needed. `GET/PUT /settings/org` presents them as one
 * form because that is how a person thinks of them — "my company's details" —
 * and the split between the rows is this module's problem, not the caller's.
 */
import { z } from "zod";
import type { Types } from "mongoose";

import {
  NUMBERING_KINDS,
  NUMBERING_PREFIX_PATTERN,
  OrgSettingsModel,
  type NumberingPrefixes,
} from "./org-settings.model.js";
import { OrganizationModel } from "../org/org.model.js";
import { writeAudit } from "../../core/audit.js";
import { notFoundError } from "../../shared/errors/app-error.js";

/** The prefix shape, in one place: the schema validates what is stored and
 *  this validates what a request sends, and they must not drift. */
const PrefixInput = z
  .string()
  .trim()
  .max(12, "Keep the prefix short.")
  .regex(NUMBERING_PREFIX_PATTERN, "Use letters, digits and dashes only.");

const NumberingPrefixesInput = z.object({
  journal: PrefixInput,
  invoice: PrefixInput,
  bill: PrefixInput,
  receipt: PrefixInput,
  credit_note: PrefixInput,
  payment: PrefixInput,
  debit_note: PrefixInput,
  transfer: PrefixInput,
  challan: PrefixInput,
  tax_certificate: PrefixInput,
});

const VatModeInput = z.enum(["NONE", "EXCLUSIVE", "INCLUSIVE"]);

export const UpdateOrgProfileSchema = z.object({
  name: z.string().trim().min(2, "Give the organisation a name.").max(120),
  address: z.string().trim().max(300).default(""),
  logo_url: z
    .string()
    .trim()
    .max(500)
    .refine((value) => value === "" || /^https?:\/\//.test(value), "A logo needs to be an http(s) URL.")
    .default(""),
  bin: z
    .string()
    .trim()
    .max(30)
    .regex(/^[A-Za-z0-9-]*$/, "A BIN/TIN is letters, digits and dashes.")
    .default(""),
  vat_mode: VatModeInput.default("NONE"),
  numbering_prefixes: NumberingPrefixesInput.partial().default({}),
});

export type UpdateOrgProfileInput = z.output<typeof UpdateOrgProfileSchema>;

export interface OrgProfileView {
  name: string;
  base_currency: string;
  address: string;
  logo_url: string;
  bin: string;
  vat_mode: "NONE" | "EXCLUSIVE" | "INCLUSIVE";
  numbering_prefixes: NumberingPrefixes;
}

/** Every prefix, with no holes — a missing kind means "no prefix", never
 *  `undefined`, so callers can concatenate without checking. */
function prefixesOf(raw: Partial<NumberingPrefixes> | undefined | null): NumberingPrefixes {
  const out = {} as NumberingPrefixes;
  for (const kind of NUMBERING_KINDS) out[kind] = raw?.[kind] ?? "";
  return out;
}

export async function getOrgProfile(orgId: string): Promise<OrgProfileView> {
  const [org, settings] = await Promise.all([
    OrganizationModel.findById(orgId).lean(),
    OrgSettingsModel.findOne({ org_id: orgId }).lean(),
  ]);
  if (!org) throw notFoundError("That organisation does not exist.");

  return {
    name: org.name,
    base_currency: org.base_currency,
    address: settings?.address ?? "",
    logo_url: settings?.logo_url ?? "",
    bin: settings?.bin ?? "",
    vat_mode: settings?.vat_mode ?? "NONE",
    numbering_prefixes: prefixesOf(settings?.numbering_prefixes),
  };
}

export async function updateOrgProfile(
  orgId: string,
  uid: string,
  input: UpdateOrgProfileInput,
  ip?: string,
): Promise<OrgProfileView> {
  const before = await getOrgProfile(orgId);

  // The name is the organisation's, so it is written there; everything else
  // upserts into the settings row. One audit row covers both — the user made
  // one change and the trail should read as one change.
  await OrganizationModel.updateOne({ _id: orgId }, { $set: { name: input.name } });

  const existing = await OrgSettingsModel.findOne({ org_id: orgId }).lean();
  const numbering_prefixes = { ...prefixesOf(existing?.numbering_prefixes), ...input.numbering_prefixes };

  await OrgSettingsModel.findOneAndUpdate(
    { org_id: orgId },
    {
      $set: {
        address: input.address,
        logo_url: input.logo_url,
        bin: input.bin,
        vat_mode: input.vat_mode,
        numbering_prefixes,
      },
    },
    { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
  ).lean();

  const after = await getOrgProfile(orgId);

  await writeAudit({
    orgId,
    uid,
    entity: "org.settings",
    entityId: orgId,
    action: "ORG_PROFILE_UPDATED",
    before,
    after,
    ...(ip ? { ip } : {}),
  });

  return after;
}

/**
 * How this organisation treats tax on a document line (plan §6 Phase 7).
 *
 * The profile's third mode, `NONE`, means "not registered for VAT", not "ignore
 * every tax code": a line that names a rate still gets that rate, because
 * dropping it would post a document whose printed tax the ledger does not carry.
 * So `NONE` and `EXCLUSIVE` behave identically on a line, and only `INCLUSIVE`
 * (the price already contains the tax) changes the arithmetic.
 *
 * Read once per document write by the line engine, which is why it returns the
 * two states the arithmetic actually distinguishes rather than echoing the
 * three the settings screen shows.
 */
export async function vatModeFor(orgId: string | Types.ObjectId): Promise<"EXCLUSIVE" | "INCLUSIVE"> {
  const row = await OrgSettingsModel.findOne({ org_id: orgId }).select({ vat_mode: 1 }).lean();
  return row?.vat_mode === "INCLUSIVE" ? "INCLUSIVE" : "EXCLUSIVE";
}

/**
 * The prefix a given document kind is currently issued with — "" when the org
 * has claimed none.
 *
 * Read by the sequence service on every allocation, which is why it takes only
 * the settings row it needs and nothing else. The document year and sequence
 * are unaffected by the prefix: it decorates the printed number, it does not
 * take part in the counter (the unique (org, kind, year) index does that).
 */
export async function numberingPrefix(orgId: string | Types.ObjectId, kind: string): Promise<string> {
  if (!(NUMBERING_KINDS as readonly string[]).includes(kind)) return "";
  const row = await OrgSettingsModel.findOne({ org_id: orgId })
    .select({ numbering_prefixes: 1 })
    .lean();
  const value = row?.numbering_prefixes?.[kind as keyof NumberingPrefixes];
  return typeof value === "string" ? value : "";
}
