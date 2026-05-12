#!/usr/bin/env node
/**
 * scrape-hn.mjs
 *
 * Pulls ATS-hosted URLs out of Hacker News comments via the Algolia public
 * search API. HN "Who's Hiring" threads have a decade of monthly posts with
 * raw ATS URLs — high signal, deduplicates well, no auth, no rate limit.
 *
 * Output: data/slugs-<ats>.json (same shape as the Wayback version).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA_DIR = join(ROOT, 'data');
mkdirSync(DATA_DIR, { recursive: true });

// HN Algolia returns top ~1000 most-relevant hits per query, won't paginate
// past that. To bust the cap we fan queries across the slug alphabet: each
// provider gets the base host query plus 26 sub-queries ("<host>/a", "<host>/b",
// …). Sub-queries bias relevance toward slugs starting with that letter,
// surfacing the long tail. No auth needed, no rate limit.
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'.split('');

function alphaFan(base) {
  return [base, ...ALPHABET.map((c) => `${base}/${c}`)];
}

const greenhouseExtract = (text) => {
  const slugs = [];
  const re = /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9-_]{1,60})/gi;
  let m;
  while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
  return slugs;
};

const leverExtract = (text) => {
  const slugs = [];
  const re = /jobs\.lever\.co\/([a-z0-9][a-z0-9-_]{1,60})/gi;
  let m;
  while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
  return slugs;
};

const ashbyExtract = (text) => {
  const slugs = [];
  const re = /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-_]{1,60})/gi;
  let m;
  while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
  return slugs;
};

const smartrecruitersExtract = (text) => {
  const slugs = [];
  const re = /careers\.smartrecruiters\.com\/([a-z0-9][a-z0-9-_]{1,60})/gi;
  let m;
  while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
  return slugs;
};

const SOURCES = [
  {
    ats: 'greenhouse',
    queries: [
      ...alphaFan('boards.greenhouse.io'),
      ...alphaFan('job-boards.greenhouse.io'),
    ],
    extract: greenhouseExtract,
  },
  {
    ats: 'lever',
    queries: alphaFan('jobs.lever.co'),
    extract: leverExtract,
  },
  {
    ats: 'ashby',
    queries: alphaFan('jobs.ashbyhq.com'),
    extract: ashbyExtract,
  },
  {
    ats: 'smartrecruiters',
    queries: alphaFan('careers.smartrecruiters.com'),
    extract: smartrecruitersExtract,
  },
];

// HN stores comment text as HTML — `/` becomes `&#x2F;`, etc. Decode before regex.
function decodeHtml(s) {
  if (!s) return '';
  return s
    .replace(/&#x2F;/gi, '/')
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2f;/g, '/')
    .replace(/&#47;/g, '/')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

const RESERVED = new Set([
  'embed',
  'departments',
  'jobs',
  'search',
  'job',
  'j',
  'i',
  'careers',
  'about',
  'company',
  'apply',
  'static',
  'assets',
  'api',
  'login',
]);

// Algolia "search_by_date" returns chronological hits and supports pagination
// via numericFilters=created_at_i<<oldest>. hitsPerPage max is 1000.
async function pullPage(query, beforeTs) {
  const params = new URLSearchParams({
    query,
    tags: 'comment',
    hitsPerPage: '1000',
  });
  if (beforeTs) params.set('numericFilters', `created_at_i<${beforeTs}`);
  const url = `https://hn.algolia.com/api/v1/search_by_date?${params}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HN HTTP ${res.status}`);
  return res.json();
}

async function scrapeOne(source) {
  // slug -> { hits, latestYear }
  const slugMap = new Map();
  const totalQueries = source.queries.length;
  for (let qi = 0; qi < totalQueries; qi++) {
    const query = source.queries[qi];
    let beforeTs = null;
    let page = 0;
    // 5 pages per sub-query is plenty — each is a 1000-hit chronological slice;
    // marginal slug yield drops sharply after the first 1-2 pages on prefix queries.
    while (page < 5) {
      let json;
      try {
        json = await pullPage(query, beforeTs);
      } catch (e) {
        // Most likely a 429 from HN Algolia — sleep and retry once.
        await sleep(2000);
        try {
          json = await pullPage(query, beforeTs);
        } catch (e2) {
          console.error(`  ${query} (after retry): ${e2.message}`);
          break;
        }
      }
      const hits = json.hits || [];
      if (hits.length === 0) break;
      let newSlugs = 0;
      let oldestTs = Infinity;
      for (const h of hits) {
        const text = decodeHtml((h.comment_text || '') + ' ' + (h.story_text || '') + ' ' + (h.url || ''));
        const year = new Date((h.created_at_i || 0) * 1000).getUTCFullYear();
        oldestTs = Math.min(oldestTs, h.created_at_i);
        for (const slug of source.extract(text)) {
          if (slug.length < 2 || RESERVED.has(slug)) continue;
          const prev = slugMap.get(slug) || { hits: 0, latestYear: 0 };
          if (!slugMap.has(slug)) newSlugs++;
          prev.hits += 1;
          prev.latestYear = Math.max(prev.latestYear, year);
          slugMap.set(slug, prev);
        }
      }
      if (newSlugs > 0 || page === 0) {
        console.log(`  ${source.ats} [${qi + 1}/${totalQueries}] "${query}" p${page}: ${hits.length} hits → +${newSlugs} new (${slugMap.size} total)`);
      }
      if (hits.length < 1000) break;
      if (oldestTs === Infinity) break;
      beforeTs = oldestTs;
      page++;
      await sleep(120); // polite gap, HN Algolia tolerates ~10 req/s
    }
    await sleep(120);
  }
  return [...slugMap.entries()].map(([slug, meta]) => ({ slug, ...meta }));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  for (const source of SOURCES) {
    console.log(`\n=== ${source.ats} ===`);
    const slugs = await scrapeOne(source);
    slugs.sort((a, b) => b.latestYear - a.latestYear || b.hits - a.hits);
    const outPath = join(DATA_DIR, `slugs-${source.ats}.json`);
    writeFileSync(outPath, JSON.stringify(slugs, null, 2));
    console.log(`  wrote ${slugs.length} unique slugs → ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
