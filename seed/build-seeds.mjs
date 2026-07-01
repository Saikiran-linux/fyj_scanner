#!/usr/bin/env node
/**
 * build-seeds.mjs
 *
 * Reads data/slugs-<ats>.json (output of seed/scrape-hn.mjs) and writes
 * data/seeds.json with TARGET_SIZE rows allocated proportionally across the 4
 * GET-based providers. Workday (f-104) is appended separately from a curated
 * data/slugs-workday.json (composite "tenant:dc:site" slugs, precomputed URLs)
 * — no proportional allocation, since those are hand-verified tenants, not
 * wayback-discovered slugs. Workable is still excluded (its public JSON API
 * returns no postings — see f-902; re-verified 2026-06-30).
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');

// Default raised to 3,000 to clear the 50k-unique-active-jobs SLA.
// At ~69% active-tenant rate × ~26 jobs / active tenant from the viability
// run, 3,000 seeds yields ~54k active jobs in steady state.
const TARGET_SIZE = Number(process.env.TARGET_SIZE || 3000);
const ATS_LIST = ['greenhouse', 'ashby', 'lever', 'smartrecruiters'];

const PROBE = {
  greenhouse: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
  ashby: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`,
  lever: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
  smartrecruiters: (s) => `https://api.smartrecruiters.com/v1/companies/${s}/postings`,
};
const CAREERS = {
  greenhouse: (s) => `https://job-boards.greenhouse.io/${s}`,
  ashby: (s) => `https://jobs.ashbyhq.com/${s}`,
  lever: (s) => `https://jobs.lever.co/${s}`,
  smartrecruiters: (s) => `https://careers.smartrecruiters.com/${s}`,
};

const perAts = {};
for (const ats of ATS_LIST) {
  perAts[ats] = JSON.parse(readFileSync(join(DATA, `slugs-${ats}.json`), 'utf-8'));
}

const totals = Object.fromEntries(ATS_LIST.map((a) => [a, perAts[a].length]));
const totalAll = Object.values(totals).reduce((s, n) => s + n, 0);
console.log('Per-ATS slug counts:', totals, '(sum', totalAll, ')');

const target = {};
let remaining = TARGET_SIZE;
for (const ats of ATS_LIST) {
  const share = Math.floor((perAts[ats].length / Math.max(totalAll, 1)) * TARGET_SIZE);
  target[ats] = Math.min(share, perAts[ats].length);
  remaining -= target[ats];
}
while (remaining > 0) {
  const eligible = ATS_LIST.filter((a) => target[a] < perAts[a].length);
  if (!eligible.length) break;
  for (const ats of eligible) {
    if (remaining === 0) break;
    target[ats]++;
    remaining--;
  }
}
console.log('Allocated slots:', target);

const seeds = [];
for (const ats of ATS_LIST) {
  for (const row of perAts[ats].slice(0, target[ats])) {
    seeds.push({
      ats,
      slug: row.slug,
      latest_year: row.latestYear,
      wayback_hits: row.hits,
      careers_url: CAREERS[ats](row.slug),
      probe_url: PROBE[ats](row.slug),
    });
  }
}

// Workday (f-104): curated composite slugs, included wholesale (no allocation).
// The file carries precomputed careers_url/probe_url (built from the workday
// slug via PROVIDERS.workday.{careersUrl,probeUrl}). Absent file → skip cleanly.
try {
  const wd = JSON.parse(readFileSync(join(DATA, 'slugs-workday.json'), 'utf-8'));
  for (const row of wd) {
    seeds.push({ ats: 'workday', slug: row.slug, careers_url: row.careers_url, probe_url: row.probe_url });
  }
  console.log(`Added ${wd.length} workday seeds (curated)`);
} catch {
  console.log('No data/slugs-workday.json — skipping workday seeds');
}

console.log(`Final seed size: ${seeds.length}`);
writeFileSync(join(DATA, 'seeds.json'), JSON.stringify(seeds, null, 2));
console.log(`Wrote ${join(DATA, 'seeds.json')}`);
