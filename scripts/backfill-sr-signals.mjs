#!/usr/bin/env node
/**
 * backfill-sr-signals.mjs — populate the SmartRecruiters structured columns
 * (sr_function / sr_industry / sr_experience_level) on existing jobs and
 * re-classify the still-unclassified SR rows with the guarded function prior
 * (f-121). One-time / occasional backfill; new jobs get these at scan ingest.
 *
 * Why a re-fetch: the listing blob carries the enums but we never stored them,
 * so we re-read each SR company's public listing (the same endpoint the scan
 * uses) and join back to our rows by external_id.
 *
 * Classification is intentionally CONSERVATIVE: it only writes is_target/family/
 * seniority for rows that are currently unclassified (classified_at is null) and
 * only when classifyJob() is high-confidence — it never clobbers an existing
 * rules/LLM verdict. The sr_* columns themselves are always refreshed.
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-sr-signals.mjs            # all enabled SR companies
 *   node --env-file=.env scripts/backfill-sr-signals.mjs --limit 50 # first N companies
 *   node --env-file=.env scripts/backfill-sr-signals.mjs --slug Expeditors,blablacar
 *   node --env-file=.env scripts/backfill-sr-signals.mjs --dry-run  # no writes, just report
 */

import { selectAll, update } from '../src/supabase-client.mjs';
import { fetchJobs } from '../src/providers.mjs';
import { classifyJob } from '../src/classify.mjs';
import { RateLimiter } from '../src/rate-limiter.mjs';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SLUGS = (() => {
  const i = args.indexOf('--slug');
  return i >= 0 ? new Set(args[i + 1].split(',').map((s) => s.trim())) : null;
})();
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();
const ID_CHUNK = 150;
const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 15_000);
const CONCURRENCY = Number(process.env.SR_BACKFILL_CONCURRENCY || 4);

const limiter = new RateLimiter();
const nowIso = new Date().toISOString();

async function main() {
  let companies = await selectAll('companies', {
    ats: 'eq.smartrecruiters',
    enabled: 'is.true',
    select: 'id,slug',
  });
  if (SLUGS) companies = companies.filter((c) => SLUGS.has(c.slug));
  if (Number.isFinite(LIMIT)) companies = companies.slice(0, LIMIT);
  console.log(`${companies.length} SmartRecruiters companies to backfill${DRY_RUN ? ' (DRY RUN)' : ''}`);

  const stats = { companies: 0, fetched: 0, srWritten: 0, reclassified: 0, fetchErrors: 0 };
  let cursor = 0;
  async function worker() {
    while (cursor < companies.length) {
      const c = companies[cursor++];
      try {
        await backfillCompany(c, stats);
      } catch (e) {
        stats.fetchErrors++;
        console.error(`  ${c.slug}: ${e.message}`);
      }
      if (stats.companies % 25 === 0) {
        console.log(`  …${stats.companies}/${companies.length} companies · sr_written=${stats.srWritten} reclassified=${stats.reclassified}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log('\nDone.');
  console.log(`  companies processed : ${stats.companies}`);
  console.log(`  listings fetched    : ${stats.fetched} (errors ${stats.fetchErrors})`);
  console.log(`  sr_* columns written: ${stats.srWritten}`);
  console.log(`  rows re-classified  : ${stats.reclassified}`);
  console.log(`  rate snapshot       : ${JSON.stringify(limiter.snapshot?.() ?? {})}`);
}

async function backfillCompany(company, stats) {
  // Pull our active rows for this company so we can map external_id → row and
  // know which are still unclassified.
  const rows = await selectAll('jobs', {
    company_id: `eq.${company.id}`,
    closed_at: 'is.null',
    select: 'id,external_id,classified_at',
  });
  stats.companies++;
  if (rows.length === 0) return;
  const byExt = new Map(rows.map((r) => [String(r.external_id), r]));

  const res = await fetchJobs('smartrecruiters', company.slug, { timeoutMs: TIMEOUT_MS, limiter });
  if (!res.ok || !Array.isArray(res.jobs)) { stats.fetchErrors++; return; }
  stats.fetched++;

  // sr_* updates grouped by identical signal triple; classification updates
  // grouped by identical verdict. Both keyed → one PATCH per distinct value.
  const srGroups = new Map();   // "fn|ind|exp" -> { sr_function, sr_industry, sr_experience_level, ids }
  const clsGroups = new Map();  // "fam|tgt|sen|by" -> { job_family, is_target, seniority, classified_by, ids }

  for (const j of res.jobs) {
    const row = byExt.get(String(j.external_id));
    if (!row) continue; // listed but not in our index (new/closed) — skip

    const fn = j.sr_function ?? null;
    const ind = j.sr_industry ?? null;
    const exp = j.sr_experience_level ?? null;
    const sk = `${fn ?? ''}|${ind ?? ''}|${exp ?? ''}`;
    let sg = srGroups.get(sk);
    if (!sg) { sg = { sr_function: fn, sr_industry: ind, sr_experience_level: exp, ids: [] }; srGroups.set(sk, sg); }
    sg.ids.push(row.id);

    // Only classify rows we haven't classified yet, and only a high-confidence
    // verdict (rules OR the guarded sr_function prior) — never clobber.
    if (row.classified_at == null) {
      const cls = classifyJob({ title: j.title, srFunction: fn, srExperienceLevel: exp });
      // classifyJob returns `family` (the DB column is `job_family`).
      if (cls.confidence === 'high' && cls.is_target != null && cls.family != null) {
        const ck = `${cls.family}|${cls.is_target}|${cls.seniority ?? ''}|${cls.classified_by}`;
        let cg = clsGroups.get(ck);
        if (!cg) { cg = { job_family: cls.family, is_target: cls.is_target, seniority: cls.seniority ?? null, classified_by: cls.classified_by, ids: [] }; clsGroups.set(ck, cg); }
        cg.ids.push(row.id);
      }
    }
  }

  if (DRY_RUN) {
    for (const g of srGroups.values()) stats.srWritten += g.ids.length;
    for (const g of clsGroups.values()) stats.reclassified += g.ids.length;
    return;
  }

  for (const g of srGroups.values()) {
    for (let i = 0; i < g.ids.length; i += ID_CHUNK) {
      const chunk = g.ids.slice(i, i + ID_CHUNK);
      await update('jobs', { id: `in.(${chunk.join(',')})` }, {
        sr_function: g.sr_function,
        sr_industry: g.sr_industry,
        sr_experience_level: g.sr_experience_level,
      }, { returning: 'minimal' });
      stats.srWritten += chunk.length;
    }
  }
  for (const g of clsGroups.values()) {
    for (let i = 0; i < g.ids.length; i += ID_CHUNK) {
      const chunk = g.ids.slice(i, i + ID_CHUNK);
      await update('jobs', { id: `in.(${chunk.join(',')})` }, {
        job_family: g.job_family,
        is_target: g.is_target,
        seniority: g.seniority,
        classified_at: nowIso,
        classified_by: g.classified_by,
      }, { returning: 'minimal' });
      stats.reclassified += chunk.length;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
