#!/usr/bin/env node
/**
 * backfill-descriptions.mjs — pull descriptions for every active job that
 * doesn't yet have one. Run once after deploying the Phase-2 description
 * support; afterwards the scanner keeps things current on its own (capped
 * at DESCRIPTION_FETCH_CAP per run).
 *
 * For providers that include descriptions in their listing (Greenhouse,
 * Ashby, Lever, workatastartup) the scanner has likely already populated
 * descriptions on the next run after deploy — those rows won't appear here.
 *
 * For SmartRecruiters (per-job fetch), this script does the heavy lifting:
 * ~10k fetches at the rate limiter's pace, typically 1-2 hours.
 *
 * Idempotent and resumable: rerun if it dies partway.
 *
 * Usage:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/backfill-descriptions.mjs
 *
 * Or via npm:  npm run backfill-descriptions
 */

import { createHash } from 'node:crypto';
import { select, update } from '../src/supabase-client.mjs';
import {
  fetchJobDescription,
  hasDescriptionFetcher,
  PROVIDER_NAMES,
} from '../src/providers.mjs';
import { RateLimiter } from '../src/rate-limiter.mjs';

function describeHash(text) {
  if (text == null || text === '') return null;
  return createHash('md5').update(text).digest('hex');
}

const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 15_000);
const PAGE_SIZE = 500;

const limiter = new RateLimiter();

// Providers that don't have a per-job fetcher (everything except SR today)
// can't be backfilled here — for them, the listing-side parser populates
// descriptions on the next scan automatically.
const fetchableAts = PROVIDER_NAMES.filter(hasDescriptionFetcher);
console.log(`Providers with per-job description fetchers: ${fetchableAts.join(', ') || '(none)'}`);
if (fetchableAts.length === 0) {
  console.log('Nothing to do — all providers already populate descriptions from listings.');
  process.exit(0);
}

let totalAttempted = 0;
let totalOk = 0;
let totalFailed = 0;
const startedAt = Date.now();
let lastLog = 0;

while (true) {
  // Pull a page of candidates that belong to a fetchable provider. PostgREST's
  // `companies.ats=in.(...)` filters through the embedded resource.
  const inClause = `(${fetchableAts.join(',')})`;
  const page = await select('jobs', {
    description: 'is.null',
    closed_at: 'is.null',
    limit: String(PAGE_SIZE),
    select: 'id,external_id,companies!inner(id,ats,slug)',
    'companies.ats': `in.${inClause}`,
  });

  if (!Array.isArray(page) || page.length === 0) break;

  for (const row of page) {
    const ats = row.companies?.ats;
    const slug = row.companies?.slug;
    if (!ats || !slug) continue;
    totalAttempted++;
    try {
      const res = await fetchJobDescription(ats, slug, row.external_id, { timeoutMs: TIMEOUT_MS, limiter });
      if (!res.ok) {
        totalFailed++;
        continue;
      }
      await update(
        'jobs',
        { id: `eq.${row.id}` },
        {
          description: res.description ?? null,
          description_hash: describeHash(res.description ?? null),
          description_fetched_at: new Date().toISOString(),
        },
        { returning: 'minimal' },
      );
      totalOk++;
    } catch (e) {
      totalFailed++;
      console.error(`fetch failed ${ats}/${slug}/${row.external_id}: ${e.message}`);
    }

    const now = Date.now();
    if (now - lastLog >= 10_000) {
      lastLog = now;
      const elapsed = ((now - startedAt) / 1000).toFixed(0);
      console.log(`  ${totalAttempted} attempted (${totalOk} ok, ${totalFailed} failed), ${elapsed}s elapsed`);
    }
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log('');
console.log(`Done in ${elapsed}s`);
console.log(`  Attempted: ${totalAttempted}`);
console.log(`  Ok:        ${totalOk}`);
console.log(`  Failed:    ${totalFailed}`);

const snap = limiter.snapshot();
console.log('Per-source: ' + Object.entries(snap)
  .map(([ats, s]) => `${ats}: ${s.block_rate_pct}% blocked`)
  .join(' | '));

if (totalFailed > 0) {
  console.log('');
  console.log('Some rows failed — rerun to retry. Persistent failures usually mean');
  console.log('the job 404s upstream (posting was deleted between scan and fetch).');
  process.exit(2);
}
