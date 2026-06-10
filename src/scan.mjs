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
 *   5. Update consecutive_errors / last_success_at / auto-disable threshold
 *      (success path is batched into a single PATCH after all probes finish).
 *   6. Close the scans row with totals (status=ok or failed).
 *
 * Exits non-zero only on catastrophic errors (e.g. can't reach Supabase).
 * Per-company failures are normal and counted, not crashes.
 */

import { createHash } from 'node:crypto';
import { select, selectAll, insert, upsert, update, rpc } from './supabase-client.mjs';
import { fetchJobs, fetchJobDescription, fetchJobPosting, hasDescriptionFetcher, hasDetailFetcher, PROVIDER_NAMES } from './providers.mjs';
import { fingerprint } from './fingerprint.mjs';
import { RateLimiter } from './rate-limiter.mjs';
import { isEnabled as embeddingsEnabled, embedAndPersistJobs } from './embeddings.mjs';
import { isEnabled as summariesEnabled, summarizeAndPersistJobs } from './summarize.mjs';
import { isEnabled as r2Enabled, contentHash, putGzipJson } from './r2.mjs';

// md5 hex of the description text. Postgres' md5() emits the same encoding,
// so a hash computed here can be compared bit-for-bit against the value
// stored in `jobs.description_hash`. Returns null for null/empty input so
// rows that legitimately have no description don't churn a synthetic hash.
function describeHash(text) {
  if (text == null || text === '') return null;
  return createHash('md5').update(text).digest('hex');
}

// How many per-job description fetches the scanner is willing to do in one
// run. Caps the time spent on providers like SmartRecruiters whose listing
// doesn't include descriptions. The backlog drains over many scans; for the
// initial bulk catch-up use `npm run backfill-descriptions` instead.
//
// Default raised to 3,000 (from 500) now that the SmartRecruiters tenant pool
// grew ~30× (f-102) — at 500/run the per-job-fetch backlog would never drain.
// 3,000 SR fetches cost ~5min through the rate limiter, comfortably inside the
// workflow's 30-min budget alongside the ~3min probe pass. Set
// DESCRIPTION_FETCH_CAP=0 to remove the cap entirely (unbounded — only safe for
// manual/local runs, NOT the 30-min-capped cron). The pass paginates, so values
// above PostgREST's 1,000-row ceiling now actually take effect.
const DESCRIPTION_FETCH_CAP = (() => {
  const raw = Number(process.env.DESCRIPTION_FETCH_CAP ?? 3000);
  return raw === 0 ? Infinity : raw;
})();

// How many job descriptions the scanner will pass through gpt-4o-mini per
// run to produce embedding-friendly summaries. Each call is ~$0.0001, so
// 1000/scan ≈ $0.10 per scan, $0.40/day at the 6-hour cadence. Bump
// SCAN_SUMMARY_CAP if you want to drain a backlog faster; bulk catch-up
// is faster via `npm run backfill-summaries`.
const SCAN_SUMMARY_CAP = Number(process.env.SCAN_SUMMARY_CAP || 1000);

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
  // selectAll paginates past PostgREST's 1k max-rows cap — a bare select()
  // silently truncates to 1,000 even though the table has more rows.
  // last_raw_hash is the content hash of the most recently archived raw
  // response for this company — lets archiveRawResponse() skip re-uploading an
  // unchanged board (the dedupe-on-change rule) with no extra per-company query.
  companies = await selectAll('companies', { enabled: 'eq.true', select: 'id,ats,slug,probe_url,consecutive_errors,last_raw_hash' });
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

// Pre-fetch every currently-open job once. Per-company probes used to issue
// their own SELECT for the close-sweep — at SCAN_WORKER_POOL=10 across 3k
// companies that's 3k small queries hammering the pooler, which is what
// pushed scans into 504/statement-timeout territory. One paginated read up
// front (a few seconds) replaces all of them, and the same map lets us
// skip re-sending unchanged descriptions in the upsert.
//
// Snapshot semantics: rows inserted/closed between this read and a probe
// are handled by the upsert's unique-constraint resolution and the close
// sweep's "external_id not in current listing" check, respectively. We
// don't need a consistent snapshot — we just need a recent one.
console.log('Pre-fetching active job snapshot...');
const snapshotStart = Date.now();
const activeRows = await selectAll('jobs', {
  closed_at: 'is.null',
  select: 'company_id,external_id,description_hash',
});
/** @type {Map<string, Map<string, {description_hash: string|null}>>} */
const activeByCompany = new Map();
for (const row of activeRows) {
  let m = activeByCompany.get(row.company_id);
  if (!m) {
    m = new Map();
    activeByCompany.set(row.company_id, m);
  }
  m.set(row.external_id, { description_hash: row.description_hash });
}
console.log(
  `  loaded ${activeRows.length} active jobs across ${activeByCompany.size} companies ` +
  `in ${((Date.now() - snapshotStart) / 1000).toFixed(1)}s`,
);

// totals (mutated by worker pool)
const totals = {
  companies_probed: 0,
  companies_ok: 0,
  companies_error: 0,
  new_jobs: 0,
  closed_jobs: 0,
};

const probeResultBuffer = [];

// IDs of companies whose probe succeeded this scan. After the worker pool
// drains we issue a single batched PATCH to reset their error counters and
// refresh last_success_at — replacing one PATCH per successful company
// (previously ~3,000 round trips per scan, a major contributor to the pooler
// 504/statement-timeout cascade we hit at the ~5min mark).
const successfulCompanyIds = [];

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

// Stable, canonical JSON: object keys sorted recursively so the serialization
// is deterministic run-to-run. Used to hash the *parsed* job content for the
// archive dedupe decision.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// The content hash that drives archive dedupe. We hash the PARSED jobs, not the
// raw response bytes: HTML-scraping providers (e.g. workatastartup) embed a
// fresh per-request CSRF token in every response, so the raw bytes change on
// every fetch even when the listing is identical — hashing them would defeat
// dedupe and re-upload a near-duplicate every scan. The parsed jobs are stable,
// so they're the right signal for "did the board actually change?". If parsing
// failed (jobs null), fall back to the raw bytes so we still archive something.
function archiveContentHash(result) {
  return result.jobs != null ? contentHash(canonicalJson(result.jobs)) : contentHash(result.raw_text);
}

// Archive a company's raw ATS response to R2 for replay / audit / analytics.
// Deduped on the parsed-content hash (see archiveContentHash): an unchanged
// board (matched against companies.last_raw_hash) is a no-op, and only a
// CHANGED listing triggers an upload + row. The object key and raw_archive
// primary key are that content hash, so a board flapping back to a previously
// archived version merges instead of duplicating. We still store the exact raw
// response bytes as the object body for full-fidelity replay. Gated on R2 being
// configured; fully NON-FATAL — any failure logs and the scan proceeds.
async function archiveRawResponse(company, result, jobCount, nowIso) {
  if (!r2Enabled() || !result.raw_text) return;
  const hash = archiveContentHash(result);
  if (hash === company.last_raw_hash) return; // unchanged since last archive
  const key = `raw/ats=${company.ats}/company=${company.slug}/${hash}.json.gz`;
  try {
    const { bytes } = await putGzipJson(key, result.raw_text);
    // merge-duplicates handles a board flapping back to a previously-archived
    // version: the (company_id, content_hash) row already exists, so we just
    // bump last_seen_at / last_scan_id. created_at (not sent) is preserved as
    // the first-archived timestamp.
    await upsert(
      'raw_archive',
      [{
        company_id: company.id,
        ats: company.ats,
        content_hash: hash,
        r2_key: key,
        bytes,
        job_count: jobCount,
        last_scan_id: SCAN_ID,
        last_seen_at: nowIso,
      }],
      'company_id,content_hash',
      { returning: 'minimal' },
    );
    await update('companies', { id: `eq.${company.id}` }, { last_raw_hash: hash }, { returning: 'minimal' });
  } catch (e) {
    console.error(`raw archive failed for ${company.ats}/${company.slug}: ${e.message}`);
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
  const nowIso = new Date().toISOString();
  // Snapshot of currently-open rows for this company (taken once at
  // scan-start). Used for both the description-hash skip and the close-sweep.
  // Missing entry means "no open jobs for this company yet" — treat as empty.
  const existing = activeByCompany.get(company.id) || new Map();
  const jobRows = result.jobs.map((j) => {
    seenExternalIds.add(j.external_id);
    const row = {
      company_id: company.id,
      external_id: j.external_id,
      title: j.title,
      location: j.location,
      url: j.url,
      department: j.department,
      employment_type: j.employment_type,
      fingerprint: fingerprint(j.title, j.location),
      last_seen_at: nowIso,
      // first_seen_at uses default on insert; on conflict we don't touch it.
      // closed_at: null'd if this row was previously closed but reappeared.
      closed_at: null,
      // Optional comp/remote/source-timestamp fields. Each provider's
      // parse() always sets these (to null when missing) so we don't need
      // a ?? null guard here — but spelling them out explicitly makes the
      // upsert payload self-documenting and survives a future provider
      // that forgets to populate one.
      comp_min: j.comp_min ?? null,
      comp_max: j.comp_max ?? null,
      comp_currency: j.comp_currency ?? null,
      comp_interval: j.comp_interval ?? null,
      comp_text: j.comp_text ?? null,
      remote: j.remote ?? null,
      source_updated_at: j.source_updated_at ?? null,
      source_published_at: j.source_published_at ?? null,
    };
    // Description handling: provider may return text or null. We only send
    // description over the wire when it has *changed*; comparing md5 hashes
    // against the snapshot lets us cut out the dominant write-volume cost
    // (a Greenhouse description can be 5–10 KB and 95% of rows are
    // unchanged between consecutive scans). Cases:
    //   - provider returned null → don't touch description (preserves rows
    //     populated by a separate per-job fetch, e.g. SmartRecruiters).
    //   - row is new to us (not in `existing`) → always write.
    //   - hash matches stored hash → skip (no-op write avoided).
    //   - hash differs → write description + description_hash + fetched_at;
    //     the invalidate-embedding trigger nulls the embedding so the
    //     embedding pass picks it up.
    if (j.description != null) {
      const newHash = describeHash(j.description);
      const prevHash = existing.get(j.external_id)?.description_hash ?? null;
      if (newHash !== prevHash) {
        row.description = j.description;
        row.description_hash = newHash;
        row.description_fetched_at = nowIso;
      }
    }
    return row;
  });

  if (jobRows.length) {
    try {
      // Use return=minimal — we don't need the rows back. Returning
      // representation was costing us a full row payload per upsert, which
      // added up across 3k companies. We re-derive "new vs reopened" from
      // the snapshot we already have.
      await upsert('jobs', jobRows, 'company_id,external_id', { returning: 'minimal' });
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

  // "New" = appeared in the listing but not in the pre-scan active snapshot.
  // (A reopened row — previously closed, now back — also counts as new here,
  // matching the prior heuristic of "first_seen_at == last_seen_at" within
  // a tolerance window.)
  let newCount = 0;
  for (const ext of seenExternalIds) {
    if (!existing.has(ext)) newCount++;
  }
  totals.new_jobs += newCount;

  // Close jobs previously active for this company but absent from this scan.
  // Derived from the snapshot — no extra round-trip. We only do this on a
  // successful scan — never on a partial/error response. Race note: a row
  // inserted between snapshot and probe won't appear in `existing`, so it
  // won't get incorrectly closed.
  let closedThisCompany = 0;
  const toCloseExtIds = [];
  for (const ext of existing.keys()) {
    if (!seenExternalIds.has(ext)) toCloseExtIds.push(ext);
  }
  if (toCloseExtIds.length) {
    try {
      // Filter by (company_id, external_id) so we don't need to have
      // fetched primary-key ids in the snapshot.
      const extList = toCloseExtIds.map((e) => `"${e.replace(/"/g, '""')}"`).join(',');
      await update(
        'jobs',
        { company_id: `eq.${company.id}`, external_id: `in.(${extList})`, closed_at: 'is.null' },
        { closed_at: new Date().toISOString() },
        { returning: 'minimal' },
      );
      closedThisCompany = toCloseExtIds.length;
      totals.closed_jobs += closedThisCompany;
    } catch (e) {
      console.error(`close-job sweep failed for ${company.ats}/${company.slug}: ${e.message}`);
    }
  }

  // Archive the raw provider response to R2 (replay / audit / analytics).
  // Non-fatal and deduped — see archiveRawResponse.
  await archiveRawResponse(company, result, jobRows.length, nowIso);

  await recordProbe(company, {
    http_status: result.http_status,
    latency_ms: result.latency_ms,
    schema_ok: true,
    job_count: jobRows.length,
  });

  // Defer the "reset error counters" PATCH to a single batched call after
  // the worker pool drains — see flushSuccessfulCompanies().
  successfulCompanyIds.push(company.id);
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
await flushSuccessfulCompanies();

// Single batched PATCH to reset error counters on every company whose probe
// succeeded this run. PostgREST applies the same body to all rows matching
// the `id=in.(...)` filter, so this is one round trip regardless of N.
// Chunked to keep the URL under PostgREST's request-line ceiling (~16 KB);
// a UUID is 36 chars + comma, so 300 IDs ≈ 11 KB with headroom.
async function flushSuccessfulCompanies() {
  if (successfulCompanyIds.length === 0) return;
  const nowIso = new Date().toISOString();
  const CHUNK = 300;
  for (let i = 0; i < successfulCompanyIds.length; i += CHUNK) {
    const chunk = successfulCompanyIds.slice(i, i + CHUNK);
    const idList = chunk.join(',');
    try {
      await update(
        'companies',
        { id: `in.(${idList})` },
        {
          consecutive_errors: 0,
          last_success_at: nowIso,
          last_error: null,
        },
        { returning: 'minimal' },
      );
    } catch (e) {
      console.error(`batch companies-reset failed (${chunk.length} ids): ${e.message}`);
    }
  }
}

// ── description fetch pass ─────────────────────────────────────────
// For providers whose listing doesn't carry descriptions (SmartRecruiters),
// pull descriptions per-job for up to DESCRIPTION_FETCH_CAP rows per run.
// The cap keeps the scan within its time budget; the backlog drains over
// successive scans. For the initial bulk catch-up across the whole table,
// run `npm run backfill-descriptions` once.
//
// Non-fatal: a row whose description fetch fails is just left null and will
// be retried on the next scan.
let descStats = { attempted: 0, ok: 0, failed: 0 };
try {
  // Only consider providers that have a per-job fetcher; the others get
  // their descriptions filled in by the listing parser on the next scan,
  // so candidates from them would just waste slots in this pass.
  const fetchableAts = PROVIDER_NAMES.filter(hasDescriptionFetcher);
  if (fetchableAts.length === 0) {
    console.log('No providers need per-job description fetches');
  } else {
    // Pull up to DESCRIPTION_FETCH_CAP candidates. A single PostgREST request
    // tops out at 1,000 rows, so we use selectAll (paginates) with maxRows set
    // to the cap — otherwise raising the cap above 1,000 would silently do
    // nothing. maxRows=Infinity (cap removed) drains the whole backlog.
    const candidates = await selectAll('jobs', {
      description: 'is.null',
      // Skip rows we've already attempted (description_fetched_at set) — some
      // postings legitimately have no description text, and re-fetching them
      // every scan would burn the cap on the same persistent-null rows.
      description_fetched_at: 'is.null',
      closed_at: 'is.null',
      select: 'id,external_id,companies!inner(id,ats,slug)',
      'companies.ats': `in.(${fetchableAts.join(',')})`,
    }, { maxRows: DESCRIPTION_FETCH_CAP });
    if (candidates.length) {
      console.log(`Fetching descriptions for up to ${candidates.length} jobs (cap=${Number.isFinite(DESCRIPTION_FETCH_CAP) ? DESCRIPTION_FETCH_CAP : 'none'})`);
      // Shuffle so we spread across providers, same reasoning as the probe shuffle.
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
      }
      // Sequential per-job: the rate limiter is the throughput governor, not
      // worker count. Going wider here would just stack waiters on the same
      // per-provider semaphore.
      for (const row of candidates) {
        const ats = row.companies?.ats;
        const slug = row.companies?.slug;
        if (!ats || !slug) continue;
        descStats.attempted++;
        try {
          // Use the richer per-job fetch where available (SmartRecruiters): the
          // same detail request that yields the description also carries comp /
          // remote / department / employment_type, which the listing omits.
          // Other providers fall back to the description-only path.
          const res = hasDetailFetcher(ats)
            ? await fetchJobPosting(ats, slug, row.external_id, { timeoutMs: TIMEOUT_MS, limiter })
            : await fetchJobDescription(ats, slug, row.external_id, { timeoutMs: TIMEOUT_MS, limiter });
          if (!res.ok) {
            descStats.failed++;
            continue;
          }
          // null description from a provider that "succeeded" still counts
          // as an attempt — write description_fetched_at so we don't keep
          // retrying forever. Actual text remains null. We also write
          // description_hash so the next scan's hash-compare sees a match
          // and doesn't re-PATCH the same row. Structured detail fields (when
          // present) are written alongside, but only when non-null so we never
          // clobber good data with a null.
          const patch = {
            description: res.description ?? null,
            description_hash: describeHash(res.description ?? null),
            description_fetched_at: new Date().toISOString(),
          };
          for (const [k, v] of Object.entries(res.fields || {})) {
            if (v != null) patch[k] = v;
          }
          await update(
            'jobs',
            { id: `eq.${row.id}` },
            patch,
            { returning: 'minimal' },
          );
          descStats.ok++;
        } catch (e) {
          descStats.failed++;
          console.error(`description fetch failed for ${ats}/${slug}/${row.external_id}: ${e.message}`);
        }
      }
      console.log(`  description pass: ${descStats.ok} ok, ${descStats.failed} failed (of ${descStats.attempted})`);
    } else {
      console.log('No jobs needing per-job description fetch');
    }
  }
} catch (e) {
  console.error(`description pass failed (non-fatal): ${e.message}`);
}

// ── summarisation pass ─────────────────────────────────────────────
// After descriptions are filled in, run any rows that have a description
// but no summary through gpt-4o-mini. The summary becomes the input to
// the embedder (buildJobText prefers description_summary over the raw
// description), so this pass MUST run before the embedding pass — otherwise
// the embedder uses stale or absent summaries.
//
// Capped per run by SCAN_SUMMARY_CAP. Skipped if OPENAI_API_KEY isn't set,
// or if SKIP_LLM_PASSES is truthy (workflow opt-out for cost reasons —
// we already have ~10k summarised + embedded for the matching experiments,
// so the scheduled cron only needs to track new/closed jobs; the LLM
// catch-up can be run manually via the backfill scripts when needed).
let summaryStats = null;
if (process.env.SKIP_LLM_PASSES) {
  console.log('Skipping summarisation pass (SKIP_LLM_PASSES set)');
} else if (summariesEnabled()) {
  try {
    const candidates = await select('jobs', {
      description_summary: 'is.null',
      description: 'not.is.null',
      closed_at: 'is.null',
      limit: String(SCAN_SUMMARY_CAP),
      select: 'id,description',
    });
    if (candidates.length) {
      console.log(`Summarising ${candidates.length} descriptions (cap=${SCAN_SUMMARY_CAP})`);
      summaryStats = await summarizeAndPersistJobs(candidates);
      console.log(
        `  summary pass: ${summaryStats.ok} ok, ${summaryStats.failed} failed ` +
        `(~$${summaryStats.costEstimateUsd.toFixed(4)})`,
      );
    } else {
      console.log('No descriptions need summarisation');
    }
  } catch (e) {
    console.error(`summarisation pass failed (non-fatal): ${e.message}`);
  }
} else {
  console.log('Skipping summarisation pass (OPENAI_API_KEY not set)');
}

// ── embedding pass ─────────────────────────────────────────────────
// After all probes complete, embed any active jobs that don't yet have an
// embedding vector. Skipped silently if OPENAI_API_KEY isn't set so existing
// deployments keep working until the key is added.
//
// Non-fatal: failures here don't affect scan status. Next scan will pick up
// whatever was missed.
let embedStats = null;
if (process.env.SKIP_LLM_PASSES) {
  console.log('Skipping embedding pass (SKIP_LLM_PASSES set)');
} else if (embeddingsEnabled()) {
  try {
    const missing = await selectAll('jobs', {
      embedding: 'is.null',
      closed_at: 'is.null',
      // Keep in sync with buildJobText() in src/embeddings.mjs — any new
      // signal the embedder reads has to be in this select list or it'll
      // silently get embedded as null.
      select: 'id,title,department,location,description,description_summary,'
        + 'comp_min,comp_max,comp_currency,comp_interval,comp_text,'
        + 'remote,employment_type',
    });
    if (missing.length) {
      console.log(`Embedding ${missing.length} active jobs lacking vectors`);
      embedStats = await embedAndPersistJobs(missing);
      console.log(
        `  embedded=${embedStats.embedded} failed=${embedStats.failed} ` +
        `(~$${embedStats.costEstimateUsd.toFixed(4)})`,
      );
    } else {
      console.log('No jobs to embed');
    }
  } catch (e) {
    console.error(`embedding pass failed (non-fatal): ${e.message}`);
  }
} else {
  console.log('Skipping embedding pass (OPENAI_API_KEY not set)');
}

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

const descNote = descStats.attempted
  ? ` || desc: ${descStats.ok}/${descStats.attempted} ok`
  : '';
const summaryNote = summaryStats
  ? ` || summary: ${summaryStats.ok} ok, ${summaryStats.failed} failed (~$${summaryStats.costEstimateUsd.toFixed(4)})`
  : '';
const embedNote = embedStats
  ? ` || embed: ${embedStats.embedded} ok, ${embedStats.failed} failed (~$${embedStats.costEstimateUsd.toFixed(4)})`
  : '';

await closeScan(SCAN_ID, 'ok', {
  ...totals,
  active_jobs_after,
  notes: sourceNotes + descNote + summaryNote + embedNote,
});
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Scan ${SCAN_ID} done in ${elapsed}s: ok=${totals.companies_ok} err=${totals.companies_error} new=${totals.new_jobs} closed=${totals.closed_jobs} active_total=${active_jobs_after}`);
console.log(`Per-source: ${sourceNotes}`);

// Refresh the per-source totals MV that backs the dashboard. The live
// aggregate over jobs is too slow for the authenticator's 8s timeout on a
// cold cache, so we pre-compute. Totals only change when a scan finishes,
// so this is the right cadence. Best-effort: a refresh failure here just
// means the dashboard shows last scan's totals — not worth failing the run.
try {
  await rpc('f_refresh_totals_by_source');
} catch (e) {
  console.warn(`Totals refresh failed (non-fatal): ${e.message}`);
}

// ── helpers ────────────────────────────────────────────────────────

async function openScan() {
  const [row] = await insert('scans', [{ status: 'running' }]);
  return row.id;
}

async function closeScan(id, status, fields) {
  // Best-effort: the scan work is already done by the time we reach here.
  // If Supabase is mid-outage (we've seen sustained Cloudflare 521s), the
  // request layer already retried 4x — crashing the workflow over the final
  // status write just turns a transient infra blip into a red run for work
  // that actually completed. Worst case if this write is lost: the row stays
  // at status='running' until a manual cleanup or until the next scan, which
  // is far less bad than failing the run.
  try {
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
  } catch (e) {
    console.warn(`closeScan failed (non-fatal): ${e.message}`);
  }
}
