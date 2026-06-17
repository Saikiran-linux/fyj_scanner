// Placeholder bindings type. REGENERATE with `npm run cf-typegen` (wrangler types)
// after changing wrangler.jsonc — this file is overwritten by that command and is
// the single source of truth for the Worker's Env. Do not hand-edit long-term.
interface Env {
  HYPERDRIVE: Hyperdrive;
  RESUMES: R2Bucket;
  JOB_CACHE: KVNamespace;
  MATCH_QUEUE: Queue<MatchJob>;
  BETTER_AUTH_SECRET: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
  FYJ_INDEX_URL: string;
  FYJ_INDEX_KEY: string;
}

// Queue message: one continuous-match run for a campaign.
interface MatchJob {
  campaignId: string;
  orgId: string;
}
