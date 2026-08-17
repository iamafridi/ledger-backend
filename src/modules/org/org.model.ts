import mongoose, { Schema, type InferSchemaType, type Model } from "mongoose";

import { ROLES } from "../../core/permissions.js";

/**
 * An organisation is the boundary every future accounting document will be
 * scoped by: journals, invoices and reports all hang off `org_id`, never off a
 * Firebase uid, because a uid is an identity provider's opaque string and not
 * something an accountant can reason about.
 *
 * `owner_uid` is UNIQUE. Phase 0's decision (plan §4, D1) is one organisation
 * per user with no company switcher, and a unique index is how that decision is
 * enforced by the database rather than merely hoped for in application code. It
 * also makes concurrent first-request creation safe: the loser of the race gets
 * a duplicate-key error and reads the winner's row instead of creating a second
 * organisation.
 */
const organizationSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120, default: "My Ledger" },
    owner_uid: { type: String, required: true, trim: true, unique: true, index: true },

    /**
     * `MM-DD`. Month-day rather than a full date because the year of a fiscal
     * year is chosen when it is opened, not when the organisation signs up.
     * Stored as text so it can never be silently coerced into a Date and
     * shifted across a timezone boundary.
     */
    fiscal_year_start: {
      type: String,
      required: true,
      match: [/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Fiscal year start must look like 07-01."],
      default: "07-01",
    },

    base_currency: { type: String, required: true, default: "BDT" },
    status: { type: String, enum: ["ACTIVE", "SUSPENDED"], default: "ACTIVE" },

    /**
     * True once the chart of accounts and the first fiscal year exist.
     *
     * Without this, an organisation whose creation was interrupted between the
     * membership insert and the seeding would stay empty forever: every later
     * request finds a valid membership and skips setup, and the first screen
     * reports that no accounts exist. Recording completion as a flag means the
     * repair runs on the next request, costs nothing to check (the organisation
     * document is already being read), and never runs again afterwards.
     */
    setup_complete: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
);

export type OrganizationDocument = InferSchemaType<typeof organizationSchema>;

/**
 * Who is in which organisation, and with what power. `is_active` rather than a
 * delete: removing somebody from the books must not erase the fact that they
 * once had access to them.
 *
 * The unique `(org_id, uid)` pair means one row per person per organisation, so
 * a role change is an update to a single document and cannot race itself into
 * two conflicting memberships.
 */
const orgMembershipSchema = new Schema(
  {
    org_id: { type: Schema.Types.ObjectId, ref: "Organization", required: true, index: true },
    uid: { type: String, required: true, trim: true, index: true },
    /** Denormalised from the token so the member list survives the email on the
     *  Firebase account being changed later. */
    email: { type: String, trim: true, lowercase: true, default: "" },
    role: { type: String, required: true, enum: ROLES },
    is_active: { type: Boolean, default: true, index: true },
    invited_by: { type: String, default: "" },
  },
  { timestamps: true, versionKey: false },
);

orgMembershipSchema.index({ org_id: 1, uid: 1 }, { unique: true });

export type OrgMembershipDocument = InferSchemaType<typeof orgMembershipSchema>;

/**
 * `mongoose.models` is consulted first so a dev-server hot reload reuses the
 * compiled model instead of throwing OverwriteModelError on re-registration.
 * The cast restores the document type, which the lookup erases.
 */
export const OrganizationModel =
  (mongoose.models["Organization"] as Model<OrganizationDocument> | undefined) ??
  mongoose.model<OrganizationDocument>("Organization", organizationSchema);

export const OrgMembershipModel =
  (mongoose.models["OrgMembership"] as Model<OrgMembershipDocument> | undefined) ??
  mongoose.model<OrgMembershipDocument>("OrgMembership", orgMembershipSchema);
