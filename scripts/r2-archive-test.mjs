#!/usr/bin/env node
/**
 * r2-archive-test.mjs — scoped, end-to-end test of the raw-archive path on a
 * handful of real companies, WITHOUT running a full scan. Mirrors scan.mjs's
 * archiveRawResponse() exactly (same key scheme, dedupe, raw_archive upsert,
 * companies.last_raw_hash update) so we validate the wiring against live
 * Supabase + R2 before enabling it on the scheduled scan.
 *
 * Usage:  node --env-file=.env scripts/r2-archive-test.mjs [limit]
 */

import { randomUUID } from 'node:crypto';
import { selectAll, upsert, update } from '../src/supabase-client.mjs';
import { fetchJobs } from '../src/providers.mjs';
import { isEnabled as r2Enabled, putGzipJson, contentHash } from '../src/r2.mjs';

const LIMIT = Number(process.argv[2] || 3);
const SCAN_ID = randomUUID(); // raw_archive.last_scan_id is uuid

if (!r2Enabled()) { console.error('R2 not configured.'); process.exit(1); }

// Mirror of scan.mjs canonicalJson + archiveContentHash + archiveRawResponse.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
function archiveContentHash(result) {
  return result.jobs != null ? contentHash(canonicalJson(result.jobs)) : contentHash(result.raw_text);
}

async function archiveRawResponse(company, result, jobCount, nowIso) {
  if (!result.raw_text) return { status: 'no-raw' };
  const hash = archiveContentHash(result);
  if (hash === company.last_raw_hash) return { status: 'unchanged', hash };
  const key = `raw/ats=${company.ats}/company=${company.slug}/${hash}.json.gz`;
  const { bytes } = await putGzipJson(key, result.raw_text);
  await upsert('raw_archive', [{
    company_id: company.id, ats: company.ats, content_hash: hash, r2_key: key,
    bytes, job_count: jobCount, last_scan_id: SCAN_ID, last_seen_at: nowIso,
  }], 'company_id,content_hash', { returning: 'minimal' });
  await update('companies', { id: `eq.${company.id}` }, { last_raw_hash: hash }, { returning: 'minimal' });
  return { status: 'archived', hash, key, bytes };
}

async function runPass(label, companies) {
  console.log(`\n=== ${label} ===`);
  for (const c of companies) {
    const nowIso = new Date().toISOString();
    let result;
    try {
      result = await fetchJobs(c.ats, c.slug, { timeoutMs: 15_000 });
    } catch (e) {
      console.log(`  ${c.ats}/${c.slug}: fetch failed (${e.message}) — skipping`);
      continue;
    }
    if (!result.ok) { console.log(`  ${c.ats}/${c.slug}: http ${result.http_status} — skipping`); continue; }
    const jobCount = result.jobs?.length ?? 0;
    const r = await archiveRawResponse(c, result, jobCount, nowIso);
    // keep our in-memory copy in sync so pass 2 sees the new hash → dedupe
    if (r.hash) c.last_raw_hash = r.hash;
    console.log(`  ${c.ats}/${c.slug}: ${jobCount} jobs → ${r.status}` +
      (r.bytes ? ` (${r.bytes}b, ${r.key})` : '') + (r.hash ? ` [${r.hash.slice(0, 12)}…]` : ''));
  }
}

const companies = await selectAll('companies',
  { enabled: 'eq.true', select: 'id,ats,slug,last_raw_hash' }, { maxRows: LIMIT });
console.log(`Testing ${companies.length} companies (limit ${LIMIT}).`);

await runPass('PASS 1 (expect: archived)', companies);
await runPass('PASS 2 (expect: unchanged — dedupe no-op)', companies);
console.log('\nDone. Check raw_archive rows + companies.last_raw_hash in Supabase.');
