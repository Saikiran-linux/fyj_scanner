#!/usr/bin/env node
/**
 * scrape-smartrecruiters.mjs
 *
 * SmartRecruiters is badly under-seeded (the HN/Wayback corpus barely mentions
 * it — we had 15 slugs). But SmartRecruiters exposes a *public, unauthenticated
 * job-search API* that the rest of the ATSes don't:
 *
 *   https://jobs.smartrecruiters.com/sr-jobs/search?keyword=<kw>&limit=100&offset=<n>
 *
 * Every result carries `company.identifier`, which is exactly the tenant slug
 * our providers.smartrecruiters adapter probes (`/v1/companies/{id}/postings`).
 * So instead of scraping URLs out of text, we read SmartRecruiters' own index
 * directly. A bonus over HN/Wayback: every slug it returns has at least one
 * *live* posting right now, so the pool is self-verifying — no stale slugs.
 *
 * We can't pull "all companies" in one shot (search is keyword-driven and the
 * deep-offset window is bounded), so we fan across a broad keyword set covering
 * common roles + industries and union the identifiers. Marginal yield tails off
 * as keywords overlap; that's expected.
 *
 * Output: merges into data/slugs-smartrecruiters.json (non-destructive — see
 * seed/lib.mjs mergeIntoSlugFile). `hits` = how many postings surfaced the
 * slug (a rough size signal); `latestYear` = newest releasedDate seen.
 *
 * With --load it then upserts the discovered companies straight into Supabase
 * (additive, SR-only, preserving existing `enabled` flags). We deliberately do
 * NOT route SmartRecruiters through build-seeds/load-companies: that pipeline
 * re-INSERTs every greenhouse/lever/ashby slug from the slug files, which would
 * resurrect the dead Greenhouse rows that recover-greenhouse-slugs (f-101)
 * rewrote to another ATS. Loading SR in isolation sidesteps that entirely.
 *
 * Env:
 *   SR_MAX_PAGES   pages (×100 results) per keyword. Default 15.
 *   SR_KEYWORDS    comma-separated override for the keyword set.
 *   --load         upsert discovered SR companies into Supabase (needs
 *                  SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
 */

import { mergeIntoSlugFile, sleep } from './lib.mjs';
import { PROVIDERS } from '../src/providers.mjs';

const LOAD = process.argv.includes('--load');

const MAX_PAGES = Number(process.env.SR_MAX_PAGES || 15);
const PAGE = 100; // server caps limit at 100 regardless of what we ask

// Broad fan-out: job functions + industries + a few generic terms. The goal is
// breadth of *companies*, not of postings — overlapping keywords just re-hit
// known slugs (deduped) while pulling in tenants the narrower terms miss.
const KEYWORDS = (process.env.SR_KEYWORDS
  ? process.env.SR_KEYWORDS.split(',').map((s) => s.trim()).filter(Boolean)
  : [
      'engineer', 'software', 'developer', 'data', 'scientist', 'analyst',
      'manager', 'director', 'sales', 'marketing', 'product', 'designer',
      'finance', 'accountant', 'legal', 'operations', 'support', 'customer',
      'hr', 'recruiter', 'nurse', 'medical', 'pharmacist', 'technician',
      'driver', 'warehouse', 'logistics', 'retail', 'cashier', 'chef',
      'teacher', 'consultant', 'security', 'mechanic', 'electrician',
      'project', 'administrator', 'specialist', 'coordinator', 'intern',
      'architect', 'researcher', 'banking', 'insurance', 'construction',
      'energy', 'manufacturing', 'hospitality', 'logistik', 'ingenieur',
    ]);

async function fetchPage(keyword, offset) {
  const params = new URLSearchParams({ keyword, limit: String(PAGE), offset: String(offset) });
  const url = `https://jobs.smartrecruiters.com/sr-jobs/search?${params}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; fyj-scanner/0.2; +https://github.com/Saikiran-linux/fyj_scanner)',
        },
      });
      if (res.status === 429) { await sleep(2000 * attempt); continue; }
      if (!res.ok) return { error: `HTTP ${res.status}` };
      return { json: await res.json() };
    } catch (e) {
      if (attempt === 3) return { error: e.message };
      await sleep(1000 * attempt);
    }
  }
  return { error: 'retries exhausted' };
}

// slug -> { hits, latestYear }
const slugMap = new Map();

function record(identifier, releasedDate) {
  if (!identifier) return false;
  const year = releasedDate ? new Date(releasedDate).getUTCFullYear() : 0;
  const isNew = !slugMap.has(identifier);
  const prev = slugMap.get(identifier) || { hits: 0, latestYear: 0 };
  prev.hits += 1;
  if (Number.isFinite(year)) prev.latestYear = Math.max(prev.latestYear, year);
  slugMap.set(identifier, prev);
  return isNew;
}

console.log(`SmartRecruiters discovery: ${KEYWORDS.length} keywords × up to ${MAX_PAGES} pages.`);
const startedAt = Date.now();

for (let ki = 0; ki < KEYWORDS.length; ki++) {
  const kw = KEYWORDS[ki];
  let added = 0;
  let total = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { json, error } = await fetchPage(kw, page * PAGE);
    if (error) { console.warn(`  "${kw}" p${page}: ${error}`); break; }
    if (total === null) total = json.totalFound ?? null;
    const content = json.content || [];
    if (content.length === 0) break;
    for (const p of content) if (record(p.company?.identifier, p.releasedDate)) added++;
    if (content.length < PAGE) break;
    await sleep(120); // polite gap
  }
  console.log(`  [${ki + 1}/${KEYWORDS.length}] "${kw}": +${added} new (${slugMap.size} total, ${total ?? '?'} postings indexed)`);
  await sleep(120);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
const { before, after, added, path } = mergeIntoSlugFile('smartrecruiters', slugMap);
console.log('');
console.log(`Discovered ${slugMap.size} unique SmartRecruiters slugs in ${elapsed}s.`);
console.log(`Merged into ${path}: ${before} → ${after} (+${added} new).`);

if (LOAD) {
  // Lazy-import so a plain discovery run needs no Supabase creds.
  const { readFileSync } = await import('node:fs');
  const { upsert, selectAll } = await import('../src/supabase-client.mjs');
  const sr = PROVIDERS.smartrecruiters;

  // Load the full merged SR slug set (this run + everything previously known),
  // not just this run's discoveries.
  const allSlugs = JSON.parse(readFileSync(path, 'utf8')).map((r) => r.slug);

  // Preserve enabled on rows we already have (mirrors seed-companies.mjs).
  const existing = await selectAll('companies', { ats: 'eq.smartrecruiters', select: 'slug,enabled' });
  const enabledBySlug = new Map(existing.map((c) => [c.slug, c.enabled]));

  const rows = allSlugs.map((slug) => ({
    ats: 'smartrecruiters',
    slug,
    careers_url: sr.careersUrl(slug),
    probe_url: sr.probeUrl(slug),
    enabled: enabledBySlug.has(slug) ? enabledBySlug.get(slug) : true,
  }));

  console.log(`\nLoading ${rows.length} SmartRecruiters companies (${rows.length - existing.length} new)…`);
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await upsert('companies', rows.slice(i, i + CHUNK), 'ats,slug', { returning: 'minimal' });
    console.log(`  upserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
  }
  console.log('Done loading. New SR tenants will be probed on the next scan.');
}
