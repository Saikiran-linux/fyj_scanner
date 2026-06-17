import { Hono } from "hono";
import { createDb } from "./db/client";
import { listActiveCampaignIds, runCampaignMatch } from "./matcher";

/**
 * Ops Console Worker — three entrypoints:
 *  • fetch     — the API (Hono). Better Auth + tenant-scoped routes (TODO f-133).
 *  • scheduled — hourly cron: enqueue every active campaign for matching (f-135).
 *  • queue     — consume match jobs: pull new index jobs and surface them.
 *
 * Bindings come from the generated `Env` (worker-configuration.d.ts). The DB is
 * reached via Hyperdrive; never store request state in module globals.
 */

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true, service: "fyj-ops-console" }));

// TODO (f-133): mount Better Auth handler + tenant-scoped API routes here.
// Every data route resolves the Principal, then goes through the repository
// layer (src/db/repo.ts) -> withTenant(), so RLS is always in force.

export default {
  fetch: app.fetch,

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const { db, close } = createDb(env.HYPERDRIVE.connectionString);
    ctx.waitUntil(
      (async () => {
        try {
          const campaigns = await listActiveCampaignIds(db);
          if (campaigns.length > 0) {
            await env.MATCH_QUEUE.sendBatch(
              campaigns.map((c) => ({ body: { campaignId: c.id, orgId: c.orgId } })),
            );
          }
        } finally {
          await close();
        }
      })(),
    );
  },

  async queue(batch: MessageBatch<MatchJob>, env: Env): Promise<void> {
    const { db, close } = createDb(env.HYPERDRIVE.connectionString);
    try {
      for (const msg of batch.messages) {
        try {
          await runCampaignMatch(db, env, msg.body);
          msg.ack();
        } catch (err) {
          console.error(JSON.stringify({ at: "queue", campaign: msg.body.campaignId, err: String(err) }));
          msg.retry();
        }
      }
    } finally {
      await close();
    }
  },
} satisfies ExportedHandler<Env, MatchJob>;
