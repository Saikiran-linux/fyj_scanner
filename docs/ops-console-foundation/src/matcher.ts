import { and, eq, isNotNull } from "drizzle-orm";
import type { DB } from "./db/client";
import { campaigns, clientProfiles, campaignMatches } from "./db/schema";
import { searchJobs, type JobFilters } from "./index-client";

/**
 * Continuous matcher (f-135). Runs in the cron + queue handlers, NOT on the
 * request path.
 *
 * SECURITY NOTE: this is a trusted cross-tenant background job — listing active
 * campaigns spans all orgs, which RLS would block for the request role `ops_app`.
 * The cron/queue Worker therefore connects via a SEPARATE BYPASSRLS system role
 * (`ops_system`, see db/policies.sql) over its own Hyperdrive binding. It is
 * never exposed to user requests. Each run still operates on exactly one
 * campaign's data, so tenant boundaries are respected by construction.
 */

export async function listActiveCampaignIds(db: DB): Promise<Array<{ id: string; orgId: string }>> {
  const rows = await db
    .select({ id: campaigns.id, orgId: campaigns.orgId })
    .from(campaigns)
    .where(eq(campaigns.status, "active"));
  return rows;
}

export async function runCampaignMatch(
  db: DB,
  env: Env,
  job: MatchJob,
): Promise<{ surfaced: number }> {
  // 1. Load the campaign + its 1:1 profile (embedding + filters + watermark).
  const [row] = await db
    .select({
      campaignId: campaigns.id,
      orgId: campaigns.orgId,
      clientId: campaigns.clientId,
      lastRunAt: campaigns.lastRunAt,
      embedding: clientProfiles.embedding,
      targetFilters: clientProfiles.targetFilters,
    })
    .from(campaigns)
    .innerJoin(clientProfiles, eq(clientProfiles.id, campaigns.profileId))
    .where(and(eq(campaigns.id, job.campaignId), isNotNull(clientProfiles.embedding)))
    .limit(1);

  if (!row || !row.embedding) return { surfaced: 0 };

  // 2. Incremental search against the index — only jobs newer than last run.
  const filters: JobFilters = {
    ...(row.targetFilters as JobFilters),
    since: row.lastRunAt?.toISOString(),
    targetOnly: (row.targetFilters as JobFilters).targetOnly ?? true,
  };
  const matches = await searchJobs(env, row.embedding as number[], filters);

  // 3. Surface new matches (dedup on (campaign_id, job_id)); bump the watermark.
  if (matches.length > 0) {
    await db
      .insert(campaignMatches)
      .values(
        matches.map((m, i) => ({
          orgId: row.orgId,
          clientId: row.clientId,
          campaignId: row.campaignId,
          jobId: m.jobId,
          companyId: m.companyId,
          score: m.score,
          rank: i + 1,
        })),
      )
      .onConflictDoNothing({ target: [campaignMatches.campaignId, campaignMatches.jobId] });
  }

  await db.update(campaigns).set({ lastRunAt: new Date() }).where(eq(campaigns.id, row.campaignId));
  return { surfaced: matches.length };
}
