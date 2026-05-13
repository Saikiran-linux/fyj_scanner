#!/usr/bin/env node
/**
 * probe-and-emit.mjs
 *
 * Walks the Wayback candidate pool for each ATS and probes against the live
 * ATS API until N candidates return 200 + parseable JSON + >=1 active job,
 * where N matches the disabled-row count for that ATS. Writes one INSERT per
 * verified slug to replacements.sql.
 */

import { readFileSync, writeFileSync } from 'fs';
import { fetchJobs, PROVIDERS } from '../src/providers.mjs';
import { RateLimiter } from '../src/rate-limiter.mjs';

const TARGETS = { ashby: 23, greenhouse: 502, lever: 38 };
// Probe budget per ATS — Wayback yields ~30-60% for fresh captures, so we
// budget at least 2-3x the target to absorb 404s/decoms.
const PROBE_BUDGET = { ashby: 200, greenhouse: 2145, lever: 500 };

function loadInUse() {
  const csv = readFileSync('C:/Users/saiar/Desktop/fyj_scanner/res.csv', 'utf8').trim().split(/\r?\n/).slice(1);
  const inUse = { ashby: new Set(), greenhouse: new Set(), lever: new Set(), smartrecruiters: new Set() };
  for (const line of csv) {
    const [ats, slug] = line.split(',');
    if (inUse[ats]) inUse[ats].add(slug);
  }
  return inUse;
}

function candidatesFor(ats, inUse) {
  const pool = JSON.parse(readFileSync(`data/wayback-${ats}.json`, 'utf8'));
  return pool
    .filter((p) => !inUse[ats].has(p.slug))
    .sort((a, b) => b.latestYear - a.latestYear || b.hits - a.hits);
}

async function probeAts(ats, target, candidates, limiter) {
  const verified = [];
  const failed = [];
  let cursor = 0;
  let lastLogged = 0;
  const workerCount = limiter.buckets[ats].concurrency * 2;

  async function worker() {
    while (true) {
      if (verified.length >= target) return;
      if (cursor >= candidates.length) return;
      const c = candidates[cursor++];
      let r;
      try {
        r = await fetchJobs(ats, c.slug, { timeoutMs: 12000, limiter });
      } catch (e) {
        failed.push({ slug: c.slug, err: e.message });
        continue;
      }
      const ok = r.ok && r.schema_ok && Array.isArray(r.jobs) && r.jobs.length > 0;
      if (ok) {
        if (verified.length < target) {
          verified.push({ ...c, jobs: r.jobs.length });
          if (verified.length - lastLogged >= 25 || verified.length === target) {
            lastLogged = verified.length;
            console.log(`  ${ats}: ${verified.length}/${target} verified (probed ${cursor}, fails ${failed.length})`);
          }
        }
      } else {
        failed.push({ slug: c.slug, status: r.http_status, err: r.error });
      }
    }
  }

  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return { verified, failed, probed: cursor };
}

function emitSql(allVerified) {
  const lines = [
    '-- Replacement slugs for disabled companies.',
    '-- Sourced from Wayback Machine CDX (2023+), each probed live and confirmed',
    '-- to return >=1 active job at the time of generation.',
    '',
  ];
  for (const ats of Object.keys(allVerified)) {
    const rows = allVerified[ats];
    if (!rows.length) continue;
    lines.push(`-- ${ats}: ${rows.length} new slugs`);
    lines.push('insert into companies (ats, slug, careers_url, probe_url) values');
    const values = rows.map((r) => {
      const slug = r.slug.replace(/'/g, "''");
      return `  ('${ats}', '${slug}', '${PROVIDERS[ats].careersUrl(r.slug)}', '${PROVIDERS[ats].probeUrl(r.slug)}')`;
    });
    lines.push(values.join(',\n') + ';');
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const inUse = loadInUse();
  const limiter = new RateLimiter();
  const all = {};
  for (const [ats, target] of Object.entries(TARGETS)) {
    if (target === 0) { all[ats] = []; continue; }
    const candidates = candidatesFor(ats, inUse).slice(0, PROBE_BUDGET[ats]);
    console.log(`\n=== ${ats} === target=${target}, budget=${candidates.length}`);
    const { verified, failed, probed } = await probeAts(ats, target, candidates, limiter);
    console.log(`  done: ${verified.length} verified, ${failed.length} failed, ${probed} probed`);
    all[ats] = verified;
  }
  const sql = emitSql(all);
  writeFileSync('replacements.sql', sql);
  console.log('\nWrote replacements.sql');
  for (const [ats, rows] of Object.entries(all)) {
    console.log(`  ${ats}: ${rows.length} INSERTs`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
