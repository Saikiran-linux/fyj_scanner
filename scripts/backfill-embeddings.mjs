#!/usr/bin/env node
/**
 * backfill-embeddings.mjs — one-shot script to embed every active job row
 * that doesn't have an embedding yet.
 *
 * Idempotent: running it twice is safe (the second run finds zero rows).
 * The scanner also does this on every run, so this script is really only
 * needed once after Phase 1's schema lands, to backfill rows that were
 * inserted before embeddings existed.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENAI_API_KEY=... \
 *     node scripts/backfill-embeddings.mjs
 *
 * Or via npm:  npm run embed-backfill
 *
 * Limit to rows that have an LLM summary (skip "never-embedded raw-only"
 * jobs — useful for testing the summary-based embedding pipeline on a
 * subset before committing to the full backfill):
 *
 *   EMBED_SUMMARIZED_ONLY=1 npm run embed-backfill
 *
 * Costs ~$0.50 and takes ~10 minutes for ~30k jobs.
 */

import { selectAll } from '../src/supabase-client.mjs';
import {
  isEnabled as embeddingsEnabled,
  embedAndPersistJobs,
} from '../src/embeddings.mjs';

if (!embeddingsEnabled()) {
  console.error('OPENAI_API_KEY is not set — aborting');
  process.exit(1);
}

const SUMMARIZED_ONLY = /^(1|true|yes)$/i.test(process.env.EMBED_SUMMARIZED_ONLY || '');

console.log(
  SUMMARIZED_ONLY
    ? 'Loading active jobs with a summary but no embedding...'
    : 'Loading active jobs without embeddings...',
);
const startedAt = Date.now();

// selectAll paginates past PostgREST's 1k limit. We only need the columns
// the embedder reads — kept in sync with buildJobText() in src/embeddings.mjs.
const query = {
  embedding: 'is.null',
  closed_at: 'is.null',
  select: 'id,title,department,location,description,description_summary,'
    + 'comp_min,comp_max,comp_currency,comp_interval,comp_text,'
    + 'remote,employment_type',
};
if (SUMMARIZED_ONLY) {
  // Excludes the ~60k rows that have never been touched by the summary
  // pass yet — they'd otherwise be embedded with the raw-description
  // fallback, which is fine but pollutes the eval comparison.
  query.description_summary = 'not.is.null';
}
const rows = await selectAll('v_jobs_enriched', query);

console.log(`Found ${rows.length} jobs to embed`);
if (rows.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

let lastLog = 0;
const stats = await embedAndPersistJobs(rows, {
  onProgress: ({ embedded, failed, total }) => {
    // Log at most once every 5s so we don't spam the console for big runs.
    const now = Date.now();
    if (now - lastLog < 5_000 && embedded + failed < total) return;
    lastLog = now;
    const pct = (((embedded + failed) / total) * 100).toFixed(1);
    const elapsed = ((now - startedAt) / 1000).toFixed(0);
    console.log(`  ${embedded + failed}/${total} (${pct}%) — ${embedded} ok, ${failed} failed, ${elapsed}s`);
  },
});

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log('');
console.log(`Done in ${elapsed}s`);
console.log(`  Embedded: ${stats.embedded}`);
console.log(`  Failed:   ${stats.failed}`);
console.log(`  Est cost: $${stats.costEstimateUsd.toFixed(4)}`);

if (stats.failed > 0) {
  console.log('');
  console.log('Some rows failed — rerun the script to retry them.');
  process.exit(2);
}
