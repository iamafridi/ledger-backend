/**
 * Organisation resolution — the boundary every future accounting document hangs
 * off.
 *
 * Phase 0's model (plan §4, D1) is one organisation per user with no company
 * switcher, so resolving "which organisation is this request for" is a lookup of
 * the membership the signed-in uid holds, creating it on first contact. The
 * auto-create matters: every existing account predates this table, and making
 * them all fail on their next request would break the personal edition, which
 * the plan forbids.
 *
 * `orgId` is derived here, from the token's uid, and never read from the
 * request. A body parameter called `orgId` would be forgeable and would let any
 * signed-in caller post into somebody else's books.
 */
import { z } from "zod";
import type { Types } from "mongoose";

import {
  OrgMembershipModel,
  OrganizationModel,
  type OrgMembershipDocument,
  type OrganizationDocument,
} from "./org.model.js";
import { DEFAULT_ROLE, type Role } from "../../core/permissions.js";
import { writeAudit } from "../../core/audit.js";
import { notFoundError } from "../../shared/errors/app-error.js";
import { ensureChartOfAccounts } from "../coa/coa.service.js";
import { ensureMasterData } from "../masterdata/catalogs.service.js";
import { ensureDefaultBankAccounts } from "../banking/accounts.service.js";
import { openInitialFiscalYear } from "../periods/periods.service.js";

/** `MM-DD`, validated the same way the schema validates it. */
const FiscalYearStart = z
  .string()
  .trim()
  .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Fiscal year start must look like 07-01.");

export const UpdateOrgSchema = z
  .object({
    name: z.string().trim().min(2, "Give the organisation a name.").max(120),
    fiscal_year_start: FiscalYearStart,
  })
  .partial();

export type UpdateOrgInput = z.output<typeof UpdateOrgSchema>;

/**
 * `InferSchemaType` describes the fields the schema declares and nothing else,
 * so it has no `_id` — but `_id` is exactly what an org is resolved *by*.
 * Naming it here instead of casting at every call site keeps one honest type
 * rather than a trail of `as any`.
 */
type WithId<T> = T & { _id: Types.ObjectId };

export interface OrgView {
  id: string;
  name: string;
  owner_uid: string;
  fiscal_year_start: string;
  base_currency: string;
  status: string;
}

export interface MemberView {
  id: string;
  uid: string;
  email: string;
  role: Role;
  is_active: boolean;
  joined_at: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toOrgView(doc: any): OrgView {
  return {
    id: String(doc._id),
    name: doc.name,
    owner_uid: doc.owner_uid,
    fiscal_year_start: doc.fiscal_year_start,
    base_currency: doc.base_currency,
    status: doc.status,
  };
}

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === 11000
  );
}

/**
 * Give an organisation everything a new one needs: its chart, its first fiscal
 * year, its starting catalogs (tax rates, units, categories), and only then the
 * flag that says setup is done.
 *
 * The flag is written last on purpose. If any seeder throws — a dropped
 * connection, a duplicate from a concurrent first request — the organisation
 * stays marked incomplete and the next request runs this again. All the
 * seeders are idempotent, so re-running is safe; an organisation marked
 * complete while half-seeded would not be.
 */
async function completeSetup(orgId: string, uid: string): Promise<void> {
  await ensureChartOfAccounts(orgId, uid);
  // After the chart, because a treasury row is a view of one of its accounts:
  // 1000 and 1010 exist by the time this runs, so a new ledger has a working
  // banking screen rather than an empty one.
  await ensureDefaultBankAccounts(orgId, uid);
  await ensureMasterData(orgId, uid);
  await openInitialFiscalYear(orgId, uid);
  await OrganizationModel.updateOne({ _id: orgId }, { $set: { setup_complete: true } });
}

/**
 * Find the organisation this uid belongs to, or create it.
 *
 * The membership is sorted by creation so the result is deterministic if a user
 * somehow holds more than one; at Phase 0 they cannot (unique `owner_uid`), and
 * the sort keeps the function honest when invitations arrive later.
 */
export async function getOrCreateOrgForUser(
  uid: string,
  email: string | null,
): Promise<{ org: WithId<OrganizationDocument>; membership: OrgMembershipDocument }> {
  const existing = await OrgMembershipModel.findOne({ uid, is_active: true })
    .sort({ createdAt: 1 })
    .lean();

  if (existing) {
    const org = await OrganizationModel.findById(existing.org_id).lean();
    if (org) {
      // Repair a setup that never finished — see `setup_complete`. Cheap: this
      // document has already been read, and once the flag is set the branch is
      // a comparison against `false` and nothing more.
      if (org.setup_complete !== true) {
        await completeSetup(String(org._id), uid);
        return {
          org: (await OrganizationModel.findById(existing.org_id).lean()) as WithId<OrganizationDocument>,
          membership: existing as unknown as OrgMembershipDocument,
        };
      }

      return {
        org: org as WithId<OrganizationDocument>,
        membership: existing as unknown as OrgMembershipDocument,
      };
    }
    // A membership pointing at a deleted organisation is corruption, not a
    // normal state. Deactivate it rather than trusting it, then fall through to
    // create a fresh one so the user is not locked out of their own account.
    await OrgMembershipModel.updateOne({ _id: existing._id }, { $set: { is_active: false } });
  }

  try {
    const org = await OrganizationModel.create({
      name: "My Ledger",
      owner_uid: uid,
      fiscal_year_start: "07-01",
      base_currency: "BDT",
    });
    const membership = await OrgMembershipModel.create({
      org_id: org._id,
      uid,
      email: email ?? "",
      role: DEFAULT_ROLE,
      is_active: true,
    });

    // The organisation starts usable rather than empty: a chart nothing can
    // post to and a fiscal year with nowhere to put this month would make the
    // first screen a dead end.
    await completeSetup(String(org._id), uid);

    return { org: org.toObject() as WithId<OrganizationDocument>, membership: membership.toObject() };
  } catch (error) {
    // Two concurrent first requests (a page reload firing /auth/me twice) can
    // both reach the insert. The unique index on owner_uid picks one winner; the
    // loser reads the winner's row rather than creating a second organisation.
    if (isDuplicateKey(error)) {
      const membership = await OrgMembershipModel.findOne({ uid, is_active: true })
        .sort({ createdAt: 1 })
        .lean();
      if (membership) {
        const org = await OrganizationModel.findById(membership.org_id).lean();
        if (org) {
          return {
            org: org as WithId<OrganizationDocument>,
            membership: membership as unknown as OrgMembershipDocument,
          };
        }
      }
    }
    throw error;
  }
}

export async function getOrgView(orgId: string): Promise<OrgView> {
  const org = await OrganizationModel.findById(orgId).lean();
  if (!org) throw notFoundError("That organisation does not exist.");
  return toOrgView(org);
}

export async function listMembers(orgId: string): Promise<MemberView[]> {
  const rows = await OrgMembershipModel.find({ org_id: orgId })
    .sort({ createdAt: 1 })
    .lean();

  return rows.map((row) => ({
    id: String(row._id),
    uid: row.uid,
    email: row.email ?? "",
    role: row.role as Role,
    is_active: row.is_active !== false,
    joined_at: row.createdAt ? new Date(row.createdAt).toISOString() : "",
  }));
}

/**
 * PATCH semantics: only the fields supplied are changed, and `status`,
 * `owner_uid` and `base_currency` are not accepted at all — none of them are
 * something a rename form should be able to reach.
 */
export async function updateOrg(
  orgId: string,
  uid: string,
  input: UpdateOrgInput,
  ip?: string,
): Promise<OrgView> {
  const before = await getOrgView(orgId);

  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch["name"] = input.name;
  if (input.fiscal_year_start !== undefined) patch["fiscal_year_start"] = input.fiscal_year_start;

  // Nothing supplied is not an error and not a write: a PATCH that changes
  // nothing should not manufacture an audit row claiming something happened.
  if (Object.keys(patch).length === 0) return before;

  const updated = await OrganizationModel.findOneAndUpdate(
    { _id: orgId },
    { $set: patch },
    { new: true, runValidators: true },
  ).lean();

  if (!updated) throw notFoundError("That organisation does not exist.");

  const after = toOrgView(updated);
  await writeAudit({
    orgId,
    uid,
    entity: "organisation",
    entityId: after.id,
    action: "ORG_UPDATED",
    before,
    after,
    ...(ip ? { ip } : {}),
  });

  return after;
}
