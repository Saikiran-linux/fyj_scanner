#!/usr/bin/env node
/**
 * backfill-enrichment.mjs — fill structured columns (compensation, remote,
 * department, employment_type, location) that the initial scan couldn't.
 *
 * Two strategies, chosen by --ats:
 *
 *   smartrecruiters (default) — DETAIL strategy. The SR listing carries none of
 *     compensation/remote/department, but the per-job detail endpoint does. We
 *     fetch detail for every active SR job missing enrichment and write the
 *     structured fields. ~35k fetches at the limiter's pace (worker pool), so
 *     budget ~1-2h. The scan's own description pass can't cover these rows —
 *     it skips anything already description-fetched.
 *
 *   ashby | lever — LISTING strategy. These DO carry comp in the listing we
 *     already pull each scan; this just re-parses the live listing and patches
 *     existing rows now instead of waiting for the next scheduled scan (e.g.
 *     after the Ashby comp-extraction fix). Fast (one request per company).
 *
 * Only ever PATCHes existing rows, and only writes fields the source actually
 * provides (never nulls-out good data). Idempotent + resumable: candidates are
 * selected by `remote is null` (SR) — every enriched row gets a remote value
 * (onsite at minimum), so re-runs shrink the worklist and always terminate.
 *
 * Usage:
 *   node scripts/backfill-enrichment.mjs [--ats=smartrecruiters|ashby|lever]
 *   npm run backfill-enrichment -- --ats=ashby
 */

import { select, selectAll, update } from '../src/supabase-client.mjs';
import {
  fetchJobs,
  fetchJobPosting,
  hasDetailFetcher,
} from '../src/providers.mjs';
import { RateLimiter } from '../src/rate-limiter.mjs';

const ATS = (process.argv.find((a) => a.startsWith('--ats='))?.slice(6)) || 'smartrecruiters';
const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 15_000);
const WORKER_POOL = Number(process.env.BACKFILL_WORKER_POOL || 8);

const limiter = new RateLimiter();
const nowIso = () => new Date().toISOString();

let attempted = 0, updated = 0, failed = 0, noData = 0;
const startedAt = Date.now();
let lastLog = 0;

function maybeLog(total) {
  const now = Date.now();
  if (now - lastLog < 10_000) return;
  lastLog = now;
  const elapsed = ((now - startedAt) / 1000).toFixed(0);
  const rate = attempted > 0 ? (attempted / ((now - startedAt) / 1000)).toFixed(1) : '0';
  console.log(`  ${attempted}/${total} attempted (${updated} updated, ${noData} no-data, ${failed} failed), ${elapsed}s, ${rate}/s`);
}

// Keep only the fields the source actually populated, so we never overwrite an
// existing value with null. `remote` is always written when present (the detail
// value is authoritative over the listing's location heuristic).
function patchFrom(fields) {
  const patch = {};
  for (const k of ['comp_min', 'comp_max', 'comp_currency', 'comp_interval', 'comp_text', 'remote', 'department', 'employment_type', 'location', 'source_published_at']) {
    if (fields[k] != null) patch[k] = fields[k];
  }
  return patch;
}

// ── DETAIL strategy (SmartRecruiters) ────────────────────────────────────
async function runDetail() {
  if (!hasDetailFetcher(ATS)) {
    console.error(`${ATS} has no detail fetcher — nothing to do.`);
    process.exit(1);
  }
  // Fixed snapshot of rows needing enrichment (no re-query loop → can't spin
  // forever on rows the detail call returns no location for).
  const candidates = await selectAll('jobs', {
    closed_at: 'is.null',
    remote: 'is.null',
    select: 'id,external_id,companies!inner(ats,slug)',
    'companies.ats': `eq.${ATS}`,
  });
  console.log(`${ATS} detail enrichment: ${candidates.length} active jobs missing enrichment.`);
  if (!candidates.length) return;

  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const row = candidates[cursor++];
      const slug = row.companies?.slug;
      if (!slug) continue;
      attempted++;
      try {
        const res = await fetchJobPosting(ATS, slug, row.external_id, { timeoutMs: TIMEOUT_MS, limiter });
        if (!res.ok) { failed++; maybeLog(candidates.length); continue; }
        const patch = patchFrom(res.fields || {});
        if (Object.keys(patch).length === 0) { noData++; maybeLog(candidates.length); continue; }
        await update('jobs', { id: `eq.${row.id}` }, patch, { returning: 'minimal' });
        updated++;
      } catch (e) {
        failed++;
        console.error(`detail failed ${slug}/${row.external_id}: ${e.message}`);
      }
      maybeLog(candidates.length);
    }
  };
  await Promise.all(Array.from({ length: WORKER_POOL }, worker));
}

// ── LISTING strategy (Ashby / Lever) ─────────────────────────────────────
async function runListing() {
  const companies = await selectAll('companies', {
    ats: `eq.${ATS}`, enabled: 'eq.true', select: 'id,slug',
  });
  console.log(`${ATS} listing enrichment: ${companies.length} enabled companies.`);

  let ci = 0;
  const worker = async () => {
    while (ci < companies.length) {
      const company = companies[ci++];
      let res;
      try {
        res = await fetchJobs(ATS, company.slug, { timeoutMs: TIMEOUT_MS, limiter });
      } catch { failed++; continue; }
      if (!res.ok || !res.schema_ok || !Array.isArray(res.jobs)) continue;
      for (const j of res.jobs) {
        const patch = patchFrom(j);
        if (Object.keys(patch).length === 0) continue;
        attempted++;
        try {
          await update(
            'jobs',
            { company_id: `eq.${company.id}`, external_id: `eq.${j.external_id}` },
            patch,
            { returning: 'minimal' },
          );
          updated++;
        } catch (e) {
          failed++;
          console.error(`listing patch failed ${company.slug}/${j.external_id}: ${e.message}`);
        }
      }
      maybeLog(companies.length);
    }
  };
  await Promise.all(Array.from({ length: WORKER_POOL }, worker));
}

if (ATS === 'smartrecruiters') {
  await runDetail();
} else if (ATS === 'ashby' || ATS === 'lever') {
  await runListing();
} else {
  console.error(`Unsupported --ats=${ATS} (use smartrecruiters | ashby | lever).`);
  process.exit(1);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
console.log('');
console.log(`Done in ${elapsed}s. attempted=${attempted} updated=${updated} no-data=${noData} failed=${failed}`);
const snap = limiter.snapshot();
console.log('Per-source block-rate: ' + Object.entries(snap)
  .filter(([, s]) => s.ok + s.block + s.error > 0)
  .map(([a, s]) => `${a}: ${s.block_rate_pct}%`)
  .join(' | '));
