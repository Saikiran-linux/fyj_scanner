#!/usr/bin/env node
/**
 * scrape-github.mjs
 *
 * GitHub is a large, fresh corpus of ATS board URLs: job-scraper configs,
 * "companies that sponsor visas" lists, awesome-* job repos, personal
 * application trackers. This scraper harvests Greenhouse / Lever / Ashby /
 * SmartRecruiters tenant slugs from it and merges them into data/slugs-*.json.
 *
 * Two modes, run together:
 *
 *   1. Code search (needs GITHUB_TOKEN) — the high-yield path. Hits the GitHub
 *      code-search API for each ATS host string and extracts slugs from the
 *      returned match fragments. The REST code-search API requires auth and is
 *      rate-limited to ~10 req/min, so this is gated on a token being present.
 *      Create a classic/fine-grained PAT with public_repo (read) scope:
 *        GITHUB_TOKEN=ghp_xxx npm run scrape-github
 *
 *   2. Curated raw (no auth) — fetches a maintained list of raw GitHub files
 *      known to aggregate ATS links and extracts slugs. Lower yield, but always
 *      runs so the script does something useful without a token.
 *
 * Slugs are NOT verified here — that's the scanner's job (it auto-disables a
 * tenant after AUTO_DISABLE_THRESHOLD consecutive errors). build-seeds +
 * load-companies pick them up downstream.
 *
 * Env:
 *   GITHUB_TOKEN     enables code-search mode.
 *   GH_MAX_PAGES     code-search pages per host (×100 results). Default 10 (API max).
 */

import { HOST_EXTRACTORS, extractSlugs, mergeIntoSlugFile, sleep } from './lib.mjs';

const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
const GH_MAX_PAGES = Math.min(Number(process.env.GH_MAX_PAGES || 10), 10); // API caps at 1000 results
const ATS_LIST = Object.keys(HOST_EXTRACTORS);

// The literal host strings we search for, per ATS. Greenhouse has two hosts.
const SEARCH_TERMS = {
  greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
  lever: ['jobs.lever.co'],
  ashby: ['jobs.ashbyhq.com'],
  smartrecruiters: ['careers.smartrecruiters.com'],
};

// Auth-free fallback: raw files dense-ish in ATS links. Add more as found.
const CURATED_RAW = [
  'https://raw.githubusercontent.com/poteto/hiring-without-whiteboards/master/README.md',
  'https://raw.githubusercontent.com/j-delaney/easy-application/master/README.md',
];

// slug maps per ATS
const found = Object.fromEntries(ATS_LIST.map((a) => [a, new Map()]));
const thisYear = new Date().getUTCFullYear();

function record(ats, slug, year = thisYear) {
  const prev = found[ats].get(slug) || { hits: 0, latestYear: 0 };
  prev.hits += 1;
  prev.latestYear = Math.max(prev.latestYear, year);
  found[ats].set(slug, prev);
}

// ── mode 1: code search ────────────────────────────────────────────────
async function codeSearch(term) {
  const items = [];
  for (let page = 1; page <= GH_MAX_PAGES; page++) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(`"${term}"`)}&per_page=100&page=${page}`;
    let res;
    try {
      res = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github.text-match+json',
          Authorization: `Bearer ${TOKEN}`,
          'User-Agent': 'fyj-scanner-seed',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    } catch (e) {
      console.warn(`  code-search "${term}" p${page}: ${e.message}`);
      break;
    }
    if (res.status === 403 || res.status === 429) {
      // Secondary rate limit — respect Retry-After / reset, then stop this term.
      const wait = Number(res.headers.get('retry-after')) || 60;
      console.warn(`  code-search "${term}" rate-limited (HTTP ${res.status}); pausing ${wait}s`);
      await sleep(wait * 1000);
      break;
    }
    if (!res.ok) { console.warn(`  code-search "${term}" p${page}: HTTP ${res.status}`); break; }
    const json = await res.json();
    const batch = json.items || [];
    items.push(...batch);
    if (batch.length < 100) break;
    await sleep(6500); // ~10 req/min code-search budget
  }
  return items;
}

async function runCodeSearch() {
  for (const ats of ATS_LIST) {
    let before = found[ats].size;
    for (const term of SEARCH_TERMS[ats]) {
      const items = await codeSearch(term);
      for (const item of items) {
        // Prefer the returned match fragments (cheap); they contain the URL.
        const blobs = (item.text_matches || []).map((tm) => tm.fragment || '').join('\n');
        for (const slug of extractSlugs(ats, blobs)) record(ats, slug);
      }
    }
    console.log(`  ${ats}: code-search +${found[ats].size - before} slugs`);
  }
}

// ── mode 2: curated raw ─────────────────────────────────────────────────
async function runCuratedRaw() {
  for (const url of CURATED_RAW) {
    let text;
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'fyj-scanner-seed' } });
      if (!res.ok) { console.warn(`  curated ${url}: HTTP ${res.status}`); continue; }
      text = await res.text();
    } catch (e) {
      console.warn(`  curated ${url}: ${e.message}`);
      continue;
    }
    let n = 0;
    for (const ats of ATS_LIST) {
      for (const slug of extractSlugs(ats, text)) { record(ats, slug); n++; }
    }
    console.log(`  curated ${url.split('/').slice(3, 5).join('/')}: ${n} slug-refs`);
    await sleep(120);
  }
}

// ── main ─────────────────────────────────────────────────────────────────
console.log(`GitHub slug discovery. code-search=${TOKEN ? 'on' : 'OFF (no GITHUB_TOKEN)'} · curated-raw=on`);

if (TOKEN) await runCodeSearch();
else console.log('  (skipping code-search — set GITHUB_TOKEN to enable the high-yield path)');

await runCuratedRaw();

console.log('');
for (const ats of ATS_LIST) {
  if (found[ats].size === 0) { console.log(`  ${ats}: 0 discovered`); continue; }
  const { before, after, added, path } = mergeIntoSlugFile(ats, found[ats]);
  console.log(`  ${ats}: discovered ${found[ats].size} → merged ${before}→${after} (+${added}) in ${path}`);
}
