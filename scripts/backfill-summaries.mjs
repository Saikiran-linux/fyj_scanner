#!/usr/bin/env node
/**
 * backfill-summaries.mjs — one-shot script to generate description_summary
 * for every active job that has a description but no summary yet.
 *
 * Idempotent and resumable: rerun if it dies partway. Each row gets
 * description_summary_at set on every attempt (success or failure) so
 * subsequent runs only pick up untried rows.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... \
 *     node scripts/backfill-summaries.mjs
 *
 * Or via npm:  npm run backfill-summaries
 *
 * Cost: ~$6.50 and ~30 minutes for 46k jobs (gpt-4o-mini, ~600 input
 * tokens per call, SUMMARIZE_CONCURRENCY=10 in flight at a time).
 *
 * After this completes you'll want to also re-run embeddings since the
 * embedding input (buildJobText) now reads description_summary in
 * preference to the raw description:
 *
 *   UPDATE public.jobs SET embedding = null
 *     WHERE description_summary IS NOT NULL AND closed_at IS NULL;
 *   npm run embed-backfill
 *
 * That step is optional — rows whose summary lands after their embedding
 * will migrate to the summary-based embedding on their next description
 * change. The explicit reset just makes the upgrade happen immediately.
 */

import { selectAll } from '../src/supabase-client.mjs';
import {
  isEnabled as summariesEnabled,
  summarizeAndPersistJobs,
} from '../src/summarize.mjs';

if (!summariesEnabled()) {
  console.error('OPENAI_API_KEY is not set — aborting');
  process.exit(1);
}

console.log('Loading active jobs without summaries...');
const startedAt = Date.now();

// selectAll paginates past PostgREST's 1k limit. We only need id +
// description; the writer fills in the rest.
const rows = await selectAll('jobs', {
  description_summary: 'is.null',
  description: 'not.is.null',
  closed_at: 'is.null',
  // Avoid re-attempting rows we already tried in a prior run that
  // failed (the model returned nothing usable). Without this guard,
  // each rerun would burn cost on the same permanently-failing rows.
  description_summary_at: 'is.null',
  select: 'id,description',
});

console.log(`Found ${rows.length} jobs to summarise`);
if (rows.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

let lastLog = 0;
const stats = await summarizeAndPersistJobs(rows, {
  onProgress: ({ ok, failed, total }) => {
    const now = Date.now();
    if (now - lastLog < 5_000 && ok + failed < total) return;
    lastLog = now;
    const pct = (((ok + failed) / total) * 100).toFixed(1);
    const elapsed = ((now - startedAt) / 1000).toFixed(0);
    console.log(`  ${ok + failed}/${total} (${pct}%) — ${ok} ok, ${failed} failed, ${elapsed}s`);
  },
});

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log('');
console.log(`Done in ${elapsed}s`);
console.log(`  Summarised: ${stats.ok}`);
console.log(`  Failed:     ${stats.failed}`);
console.log(`  Est cost:   $${stats.costEstimateUsd.toFixed(4)}`);

if (stats.failed > 0) {
  console.log('');
  console.log('Some rows failed — rerun the script to retry them.');
  process.exit(2);
}
