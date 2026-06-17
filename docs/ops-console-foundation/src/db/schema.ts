import { sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  smallint,
  doublePrecision,
  timestamp,
  jsonb,
  vector,
  unique,
  index,
} from "drizzle-orm/pg-core";

/**
 * Ops-console tenancy schema (f-131) — the ops-console's OWN database on Neon.
 *
 * This is NOT the fyj job index. The job index lives on Supabase Postgres and is
 * read-only to this app (via search_jobs/get_job over HTTPS). There are therefore
 * NO foreign keys to the index: `jobId` + `companyId` are plain columns that point
 * at index rows; job detail is hydrated through the index API and cached in KV.
 *
 * Tenant isolation is enforced by Postgres RLS (see db/policies.sql), keyed off
 * per-request GUCs (`app.org_id`, `app.role`, …) that the Worker sets with
 * `SET LOCAL` inside each transaction. The Drizzle repository layer is the first
 * line; RLS is the backstop. The Worker connects as a non-BYPASSRLS role.
 *
 * `userId`/`*_operator_id`/`auth_user_id`/`created_by` are `text` to match Better
 * Auth's `user.id`. The FK to Better Auth's `user` table is added in the RLS
 * migration once those tables exist.
 */

// ── enums ────────────────────────────────────────────────────────────
export const memberRole = pgEnum("member_role", ["admin", "operator", "viewer"]);
export const memberStatus = pgEnum("member_status", ["active", "invited", "disabled"]);
export const clientStatus = pgEnum("client_status", ["active", "paused", "placed", "archived"]);
export const campaignStatus = pgEnum("campaign_status", ["draft", "active", "paused", "completed"]);
export const matchAction = pgEnum("match_action", [
  "new",
  "saved",
  "shortlisted",
  "dismissed",
  "evaluated",
  "applied",
]);
export const placementStatus = pgEnum("placement_status", [
  "lead",
  "applied",
  "screening",
  "interview",
  "offer",
  "placed",
  "rejected",
  "withdrawn",
]);
export const feedbackSignal = pgEnum("feedback_signal", [
  "interested",
  "not_interested",
  "already_applied",
  "wrong_location",
  "comp_too_low",
  "seniority_off",
  "not_my_field",
  "other",
]);

// ── organizations (tenant root) ───────────────────────────────────────
export const organizations = pgTable("organizations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug").unique(),
  plan: text("plan").notNull().default("free"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── memberships (org staff: admin | operator | viewer) ─────────────────
export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: memberRole("role").notNull(),
    status: memberStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("memberships_org_user_uq").on(t.orgId, t.userId),
    index("memberships_user_idx").on(t.userId),
    index("memberships_org_idx").on(t.orgId),
  ],
);

// ── clients (represented job-seekers; assigned to an operator) ─────────
export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    assignedOperatorId: text("assigned_operator_id"),
    authUserId: text("auth_user_id"), // set when the client is invited to the portal
    fullName: text("full_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    status: clientStatus("status").notNull().default("active"),
    portalEnabled: boolean("portal_enabled").notNull().default(false),
    portalPermissions: jsonb("portal_permissions").notNull().default(sql`'{}'::jsonb`),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("clients_org_idx").on(t.orgId),
    index("clients_operator_idx").on(t.assignedOperatorId),
    index("clients_auth_user_idx").on(t.authUserId),
  ],
);

// ── client_profiles (targeting personas: resume + criteria + embedding) ─
export const clientProfiles = pgTable(
  "client_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    resumeStoragePath: text("resume_storage_path"), // R2 key
    resumeText: text("resume_text"),
    parsedProfile: jsonb("parsed_profile"),
    // pgvector — used to query the index's HNSW; no local ANN index needed.
    embedding: vector("embedding", { dimensions: 1536 }),
    embeddingModel: text("embedding_model"),
    embeddedAt: timestamp("embedded_at", { withTimezone: true }),
    targetFilters: jsonb("target_filters").notNull().default(sql`'{}'::jsonb`),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("client_profiles_client_idx").on(t.clientId),
    index("client_profiles_org_idx").on(t.orgId),
  ],
);

// ── campaigns (1:1 with profile; the continuous matching lifecycle) ────
export const campaigns = pgTable(
  "campaigns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    profileId: uuid("profile_id")
      .notNull()
      .unique() // 1:1 profile -> campaign
      .references(() => clientProfiles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: campaignStatus("status").notNull().default("draft"),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("campaigns_client_idx").on(t.clientId),
    index("campaigns_org_idx").on(t.orgId),
    index("campaigns_active_idx").on(t.status).where(sql`status = 'active'`),
  ],
);

// ── campaign_matches (jobs surfaced for a campaign; no FK to the index) ─
export const campaignMatches = pgTable(
  "campaign_matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    jobId: uuid("job_id").notNull(), // -> fyj index jobs.id (no cross-DB FK)
    companyId: uuid("company_id").notNull(), // -> fyj index jobs.company_id
    score: doublePrecision("score"),
    rank: integer("rank"),
    surfacedAt: timestamp("surfaced_at", { withTimezone: true }).notNull().defaultNow(),
    action: matchAction("action").notNull().default("new"),
    actionBy: text("action_by"),
    actionAt: timestamp("action_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("campaign_matches_campaign_job_uq").on(t.campaignId, t.jobId),
    index("campaign_matches_campaign_idx").on(t.campaignId),
    index("campaign_matches_org_idx").on(t.orgId),
    index("campaign_matches_job_idx").on(t.jobId, t.companyId),
  ],
);

// ── reports (on-demand deep eval A–G + tailored CV) — staff-only ───────
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    campaignMatchId: uuid("campaign_match_id")
      .notNull()
      .references(() => campaignMatches.id, { onDelete: "cascade" }),
    model: text("model"),
    scores: jsonb("scores"),
    fullMarkdown: text("full_markdown"),
    cvPdfUrl: text("cv_pdf_url"),
    generatedBy: text("generated_by"),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("reports_match_idx").on(t.campaignMatchId), index("reports_org_idx").on(t.orgId)],
);

// ── placements (application tracker / kanban) ──────────────────────────
export const placements = pgTable(
  "placements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    jobId: uuid("job_id"),
    companyId: uuid("company_id"),
    status: placementStatus("status").notNull().default("lead"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    followUps: jsonb("follow_ups").notNull().default(sql`'[]'::jsonb`),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("placements_client_idx").on(t.clientId), index("placements_org_idx").on(t.orgId)],
);

// ── feedback (client's per-application signal — client-writable only) ──
export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    jobId: uuid("job_id"),
    companyId: uuid("company_id"),
    placementId: uuid("placement_id").references(() => placements.id, { onDelete: "set null" }),
    signal: feedbackSignal("signal").notNull(),
    rating: smallint("rating"),
    note: text("note"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("feedback_client_idx").on(t.clientId),
    index("feedback_campaign_idx").on(t.campaignId),
    index("feedback_org_idx").on(t.orgId),
  ],
);

// ── audit_log (admin-readable; written server-side) ────────────────────
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id"),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: uuid("entity_id"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_org_idx").on(t.orgId, t.createdAt)],
);
