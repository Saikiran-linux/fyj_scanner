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
 * Partial backfill (e.g. test on the latest 20k first):
 *   BACKFILL_LIMIT=20000 npm run backfill-summaries
 *
 * Rows are processed newest-first (first_seen_at desc). A later unlimited
 * run picks up everything that's still description_summary_at IS NULL, so
 * cap-then-full-run is safe and resumable.
 *
 * Cost: ~$10.50 and ~30 minutes for 46k jobs at the expanded 14-field
 * prompt (gpt-4o-mini, ~750 input + ~300 output tokens per call,
 * SUMMARIZE_CONCURRENCY=10 in flight). Linear in row count, so the
 * 20k smoke run is ~$4.50.
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

import { select } from '../src/supabase-client.mjs';
import {
  isEnabled as summariesEnabled,
  summarizeAndPersistJobs,
} from '../src/summarize.mjs';

if (!summariesEnabled()) {
  console.error('OPENAI_API_KEY is not set — aborting');
  process.exit(1);
}

// Optional cap for staged rollouts. Unset = pull every eligible row.
const BACKFILL_LIMIT = process.env.BACKFILL_LIMIT
  ? Number(process.env.BACKFILL_LIMIT)
  : null;
if (BACKFILL_LIMIT != null && (!Number.isFinite(BACKFILL_LIMIT) || BACKFILL_LIMIT <= 0)) {
  console.error(`BACKFILL_LIMIT must be a positive integer, got ${process.env.BACKFILL_LIMIT}`);
  process.exit(1);
}

console.log(
  BACKFILL_LIMIT
    ? `Loading up to ${BACKFILL_LIMIT.toLocaleString()} newest active jobs without summaries...`
    : 'Loading active jobs without summaries...',
);
const startedAt = Date.now();

// Hand-paginated so we can stop exactly at BACKFILL_LIMIT. selectAll
// would fetch the entire result set before letting us cap it — wasteful
// when prod has 46k candidates and we want a 20k smoke run. Ordered
// first_seen_at desc so the cap picks the *newest* postings (most
// relevant for matching real users right now). A later unlimited run
// covers the rest, since description_summary_at stays null for every
// untouched row.
const PAGE_SIZE = 1000;
const rows = [];
const baseQuery = {
  description_summary: 'is.null',
  description: 'not.is.null',
  closed_at: 'is.null',
  // Skip rows the prior run already tried and failed on — without this,
  // permanently-failing rows would keep burning API cost on every rerun.
  description_summary_at: 'is.null',
  select: 'id,description',
  order: 'first_seen_at.desc',
};

while (true) {
  const remaining = BACKFILL_LIMIT == null ? PAGE_SIZE : BACKFILL_LIMIT - rows.length;
  if (remaining <= 0) break;
  const pageSize = Math.min(PAGE_SIZE, remaining);
  const page = await select('jobs', {
    ...baseQuery,
    limit: String(pageSize),
    offset: String(rows.length),
  });
  if (!Array.isArray(page) || page.length === 0) break;
  rows.push(...page);
  if (page.length < pageSize) break;
}

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
