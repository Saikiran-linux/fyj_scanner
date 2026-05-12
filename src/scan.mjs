#!/usr/bin/env node
/**
 * scan.mjs — production scanner.
 *
 * Flow per run:
 *   1. Open a scans row (status=running).
 *   2. Pull enabled companies from Supabase.
 *   3. Probe each (bounded parallelism), upsert jobs, record probe_results.
 *   4. After all probes complete: close jobs that were previously active but
 *      didn't appear in this run's response *for a company whose scan succeeded*.
 *   5. Update consecutive_errors / last_success_at / auto-disable threshold.
 *   6. Close the scans row with totals (status=ok or failed).
 *
 * Exits non-zero only on catastrophic errors (e.g. can't reach Supabase).
 * Per-company failures are normal and counted, not crashes.
 */

import { select, insert, upsert, update } from './supabase-client.mjs';
import { fetchJobs, PROVIDER_NAMES } from './providers.mjs';
import { fingerprint } from './fingerprint.mjs';
import { RateLimiter } from './rate-limiter.mjs';

// Outer-loop concurrency is a ceiling — actual per-provider concurrency comes
// from the rate limiter, which throttles down on 403/429 bursts. Setting this
// higher than the sum of per-provider concurrency just wastes worker slots.
const WORKER_POOL = Number(process.env.SCAN_WORKER_POOL || 25);
const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 15_000);
const AUTO_DISABLE_THRESHOLD = Number(process.env.AUTO_DISABLE_THRESHOLD || 5);
const PROBE_RESULT_BATCH = 200;

const limiter = new RateLimiter();

const SCAN_ID = await openScan();
console.log(`Scan ${SCAN_ID} started`);

let companies;
try {
  companies = await select('companies', { enabled: 'eq.true', select: 'id,ats,slug,probe_url,consecutive_errors' });
} catch (e) {
  await closeScan(SCAN_ID, 'failed', { notes: `failed to load companies: ${e.message}` });
  console.error(e);
  process.exit(1);
}

// Shuffle so workers don't pull all-Greenhouse-then-all-Ashby in order.
// Interleaving providers spreads the rate-limit pressure: while one bucket
// cools down, others are still draining.
for (let i = companies.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [companies[i], companies[j]] = [companies[j], companies[i]];
}

console.log(`Loaded ${companies.length} enabled companies`);
if (companies.length === 0) {
  await closeScan(SCAN_ID, 'ok', { notes: 'no companies enabled' });
  process.exit(0);
}

// totals (mutated by worker pool)
const totals = {
  companies_probed: 0,
  companies_ok: 0,
  companies_error: 0,
  new_jobs: 0,
  closed_jobs: 0,
};

const probeResultBuffer = [];

async function flushProbeResults(force = false) {
  if (probeResultBuffer.length === 0) return;
  if (!force && probeResultBuffer.length < PROBE_RESULT_BATCH) return;
  const batch = probeResultBuffer.splice(0, probeResultBuffer.length);
  try {
    await insert('probe_results', batch, { returning: 'minimal' });
  } catch (e) {
    console.error(`probe_results insert failed (${batch.length} rows): ${e.message}`);
  }
}

async function probeOne(company) {
  totals.companies_probed++;
  if (!PROVIDER_NAMES.includes(company.ats)) {
    return recordProbe(company, { schema_ok: false, error: `unsupported ats: ${company.ats}` });
  }

  const result = await fetchJobs(company.ats, company.slug, { timeoutMs: TIMEOUT_MS, limiter });

  if (!result.schema_ok) {
    totals.companies_error++;
    await recordProbe(company, {
      http_status: result.http_status,
      latency_ms: result.latency_ms,
      error: result.error || 'unknown',
      schema_ok: false,
      job_count: null,
    });
    await update(
      'companies',
      { id: `eq.${company.id}` },
      {
        consecutive_errors: company.consecutive_errors + 1,
        last_error_at: new Date().toISOString(),
        last_error: result.error || `HTTP ${result.http_status}`,
        ...(company.consecutive_errors + 1 >= AUTO_DISABLE_THRESHOLD ? { enabled: false } : {}),
      },
      { returning: 'minimal' },
    );
    return;
  }

  // Success path: upsert each job, then compute closed jobs.
  totals.companies_ok++;
  const seenExternalIds = new Set();
  const jobRows = result.jobs.map((j) => {
    seenExternalIds.add(j.external_id);
    return {
      company_id: company.id,
      external_id: j.external_id,
      title: j.title,
      location: j.location,
      url: j.url,
      department: j.department,
      employment_type: j.employment_type,
      fingerprint: fingerprint(j.title, j.location),
      last_seen_at: new Date().toISOString(),
      // first_seen_at uses default on insert; on conflict we don't touch it.
      // closed_at: null'd if this row was previously closed but reappeared.
      closed_at: null,
    };
  });

  let upserted = [];
  if (jobRows.length) {
    try {
      // Returning representation lets us count how many were truly new.
      upserted = await upsert('jobs', jobRows, 'company_id,external_id');
    } catch (e) {
      // Record as success of probe but failure of write — surface in notes.
      await recordProbe(company, {
        http_status: result.http_status,
        latency_ms: result.latency_ms,
        error: `db_write: ${e.message.slice(0, 200)}`,
        schema_ok: true,
        job_count: jobRows.length,
      });
      return;
    }
  }

  // first_seen_at == last_seen_at (within ~5s) on this run means it's new.
  const nowMs = Date.now();
  const newCount = upserted.filter((row) => {
    const first = new Date(row.first_seen_at).getTime();
    return Math.abs(first - nowMs) < 5_000;
  }).length;
  totals.new_jobs += newCount;

  // Close jobs previously active for this company but absent from this scan.
  // We only do this on a successful scan — never on a partial/error response.
  let closedThisCompany = 0;
  try {
    const stale = await select('jobs', {
      company_id: `eq.${company.id}`,
      closed_at: 'is.null',
      select: 'id,external_id',
    });
    const toClose = stale.filter((row) => !seenExternalIds.has(row.external_id));
    if (toClose.length) {
      const idsCsv = toClose.map((r) => r.id).join(',');
      await update('jobs', { id: `in.(${idsCsv})` }, { closed_at: new Date().toISOString() }, { returning: 'minimal' });
      closedThisCompany = toClose.length;
      totals.closed_jobs += closedThisCompany;
    }
  } catch (e) {
    console.error(`close-job sweep failed for ${company.ats}/${company.slug}: ${e.message}`);
  }

  await recordProbe(company, {
    http_status: result.http_status,
    latency_ms: result.latency_ms,
    schema_ok: true,
    job_count: jobRows.length,
  });

  // Reset error counters on success.
  await update(
    'companies',
    { id: `eq.${company.id}` },
    {
      consecutive_errors: 0,
      last_success_at: new Date().toISOString(),
      last_error: null,
    },
    { returning: 'minimal' },
  );
}

async function recordProbe(company, fields) {
  probeResultBuffer.push({
    scan_id: SCAN_ID,
    company_id: company.id,
    http_status: fields.http_status ?? null,
    schema_ok: fields.schema_ok ?? false,
    error: fields.error ?? null,
    latency_ms: fields.latency_ms ?? null,
    job_count: fields.job_count ?? null,
  });
  await flushProbeResults();
}

// Bounded-parallel worker pool.
let cursor = 0;
const startedAt = Date.now();

async function worker() {
  while (cursor < companies.length) {
    const idx = cursor++;
    try {
      await probeOne(companies[idx]);
    } catch (e) {
      console.error(`worker error on ${companies[idx]?.ats}/${companies[idx]?.slug}: ${e.message}`);
    }
    if (totals.companies_probed % 25 === 0) {
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      console.log(`  ${totals.companies_probed}/${companies.length} probed (ok=${totals.companies_ok} err=${totals.companies_error} new=${totals.new_jobs} closed=${totals.closed_jobs}, ${elapsed}s)`);
    }
  }
}

await Promise.all(Array.from({ length: WORKER_POOL }, () => worker()));
await flushProbeResults(true);

// Compute the post-scan active-jobs count for the dashboard's anomaly detector.
let active_jobs_after = null;
try {
  const r = await select('jobs', { closed_at: 'is.null', select: 'id', limit: '1' }); // throwaway; we use count instead
  // PostgREST exposes count via Prefer + Content-Range headers; simpler: just COUNT(*) via head
  const countRes = await fetch(
    `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/jobs?select=id&closed_at=is.null`,
    {
      method: 'HEAD',
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    },
  );
  const cr = countRes.headers.get('content-range'); // "0-0/12345"
  if (cr && cr.includes('/')) {
    active_jobs_after = Number(cr.split('/')[1]);
  }
} catch (e) {
  console.error(`active-jobs count failed: ${e.message}`);
}

const rateSnapshot = limiter.snapshot();
const sourceNotes = Object.entries(rateSnapshot)
  .map(([ats, s]) => `${ats}: ${s.ok}/${s.ok + s.block + s.error} ok, ${s.block_rate_pct}% blocked, conc=${s.concurrency}`)
  .join(' | ');

await closeScan(SCAN_ID, 'ok', {
  ...totals,
  active_jobs_after,
  notes: sourceNotes,
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Scan ${SCAN_ID} done in ${elapsed}s: ok=${totals.companies_ok} err=${totals.companies_error} new=${totals.new_jobs} closed=${totals.closed_jobs} active_total=${active_jobs_after}`);
console.log(`Per-source: ${sourceNotes}`);

// ── helpers ────────────────────────────────────────────────────────

async function openScan() {
  const [row] = await insert('scans', [{ status: 'running' }]);
  return row.id;
}

async function closeScan(id, status, fields) {
  await update(
    'scans',
    { id: `eq.${id}` },
    {
      status,
      ended_at: new Date().toISOString(),
      ...fields,
    },
    { returning: 'minimal' },
  );
}
