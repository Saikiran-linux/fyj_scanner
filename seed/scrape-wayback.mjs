#!/usr/bin/env node
/**
 * scrape-wayback.mjs
 *
 * Mines slugs from the Internet Archive (Wayback Machine) CDX API. HN is
 * already saturated for this project; Wayback indexes every ATS career page
 * that has ever been crawled, which surfaces the long tail HN never mentioned.
 *
 * Output: data/wayback-<ats>.json — same shape as data/slugs-<ats>.json so it
 * plugs into the existing pool diff. Kept under a different filename so we
 * don't clobber the HN-sourced pool.
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

const FROM_YEAR = '20230101'; // bias toward recently-archived → likelier live
const SOURCES = [
  {
    ats: 'greenhouse',
    patterns: ['boards.greenhouse.io/*', 'job-boards.greenhouse.io/*'],
    extract: /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9_-]{1,60})(?:[\/?#]|$)/i,
  },
  {
    ats: 'lever',
    patterns: ['jobs.lever.co/*'],
    extract: /^https?:\/\/jobs\.lever\.co\/([a-z0-9][a-z0-9_-]{1,60})(?:[\/?#]|$)/i,
  },
  {
    ats: 'ashby',
    patterns: ['jobs.ashbyhq.com/*'],
    extract: /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9_-]{1,60})(?:[\/?#]|$)/i,
  },
  {
    ats: 'smartrecruiters',
    patterns: ['careers.smartrecruiters.com/*'],
    extract: /^https?:\/\/careers\.smartrecruiters\.com\/([a-z0-9][a-z0-9_-]{1,60})(?:[\/?#]|$)/i,
  },
];

const RESERVED = new Set([
  'embed', 'departments', 'jobs', 'search', 'job', 'j', 'i',
  'careers', 'about', 'company', 'apply', 'static', 'assets',
  'api', 'login', 'p', 'index.html', 'robots.txt',
]);

async function fetchCdx(pattern) {
  // CDX API: list archived URLs matching the pattern. `fl=original,timestamp`
  // returns just the URL + capture time; `collapse=urlkey` dedupes captures
  // of the same URL. `from=20230101` filters to recent crawls.
  const params = new URLSearchParams({
    url: pattern,
    output: 'json',
    fl: 'original,timestamp',
    collapse: 'urlkey',
    from: FROM_YEAR,
    limit: '100000',
  });
  const url = `https://web.archive.org/cdx/search/cdx?${params}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'fyj-scanner-seed/0.1' } });
  if (!res.ok) throw new Error(`CDX ${pattern} HTTP ${res.status}`);
  const txt = await res.text();
  if (!txt.trim()) return [];
  // First row is the header ["original","timestamp"].
  const rows = JSON.parse(txt);
  return rows.slice(1);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function scrapeOne(source) {
  const slugMap = new Map(); // slug -> { hits, latestYear }
  for (const pattern of source.patterns) {
    console.log(`  CDX ${pattern} …`);
    let rows;
    try {
      rows = await fetchCdx(pattern);
    } catch (e) {
      console.error(`    ${pattern}: ${e.message}`);
      continue;
    }
    let newSlugs = 0;
    for (const [origUrl, ts] of rows) {
      const m = origUrl.match(source.extract);
      if (!m) continue;
      const slug = m[1].toLowerCase();
      if (slug.length < 2 || RESERVED.has(slug)) continue;
      const year = parseInt(String(ts).slice(0, 4), 10) || 0;
      const prev = slugMap.get(slug);
      if (!prev) {
        newSlugs++;
        slugMap.set(slug, { hits: 1, latestYear: year });
      } else {
        prev.hits += 1;
        if (year > prev.latestYear) prev.latestYear = year;
      }
    }
    console.log(`    ${rows.length} captures → +${newSlugs} new (${slugMap.size} total)`);
    await sleep(500); // be polite to Wayback
  }
  return [...slugMap.entries()].map(([slug, m]) => ({ slug, hits: m.hits, latestYear: m.latestYear }));
}

async function main() {
  for (const source of SOURCES) {
    console.log(`\n=== ${source.ats} ===`);
    const slugs = await scrapeOne(source);
    slugs.sort((a, b) => b.latestYear - a.latestYear || b.hits - a.hits);
    const outPath = join(DATA_DIR, `wayback-${source.ats}.json`);
    writeFileSync(outPath, JSON.stringify(slugs, null, 2));
    console.log(`  wrote ${slugs.length} unique slugs → ${outPath}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
