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

const SOURCES = [
  {
    ats: 'greenhouse',
    queries: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
    extract: (text) => {
      const slugs = [];
      const re = /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9-_]{1,60})/gi;
      let m;
      while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
      return slugs;
    },
  },
  {
    ats: 'lever',
    queries: ['jobs.lever.co'],
    extract: (text) => {
      const slugs = [];
      const re = /jobs\.lever\.co\/([a-z0-9][a-z0-9-_]{1,60})/gi;
      let m;
      while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
      return slugs;
    },
  },
  {
    ats: 'ashby',
    queries: ['jobs.ashbyhq.com', 'ashbyhq.com'],
    extract: (text) => {
      const slugs = [];
      const re = /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-_]{1,60})/gi;
      let m;
      while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
      return slugs;
    },
  },
  {
    ats: 'smartrecruiters',
    queries: ['careers.smartrecruiters.com', 'smartrecruiters.com'],
    extract: (text) => {
      const slugs = [];
      const re = /careers\.smartrecruiters\.com\/([a-z0-9][a-z0-9-_]{1,60})/gi;
      let m;
      while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
      return slugs;
    },
  },
  {
    ats: 'workable',
    queries: ['apply.workable.com', 'workable.com'],
    extract: (text) => {
      const slugs = [];
      const re = /apply\.workable\.com\/([a-z0-9][a-z0-9-_]{1,60})/gi;
      let m;
      while ((m = re.exec(text))) slugs.push(m[1].toLowerCase());
      return slugs;
    },
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
  for (const query of source.queries) {
    let beforeTs = null;
    let page = 0;
    while (page < 50) {
      let json;
      try {
        json = await pullPage(query, beforeTs);
      } catch (e) {
        console.error(`  ${query}: ${e.message}`);
        break;
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
      console.log(`  ${source.ats} q="${query}" page=${page}: ${hits.length} hits → +${newSlugs} new (${slugMap.size} total)`);
      if (hits.length < 1000) break;
      if (oldestTs === Infinity) break;
      beforeTs = oldestTs;
      page++;
    }
  }
  return [...slugMap.entries()].map(([slug, meta]) => ({ slug, ...meta }));
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
