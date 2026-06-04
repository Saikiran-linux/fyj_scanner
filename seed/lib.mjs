/**
 * seed/lib.mjs — shared slug-discovery helpers.
 *
 * The scrapers (scrape-hn, scrape-github, scrape-smartrecruiters, …) all pull
 * ATS tenant slugs out of some text/JSON corpus and merge them into
 * data/slugs-<ats>.json. This module owns the bits they share so the host
 * regexes and the merge semantics live in exactly one place.
 *
 * slugs-<ats>.json shape (one array per ATS):
 *   [{ slug: string, hits: number, latestYear: number }, …]
 *   sorted by latestYear desc, then hits desc.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = join(__dirname, '..', 'data');

// Host → slug regex, one per supported ATS. The capture group is the tenant
// slug. Kept identical to the patterns scrape-hn relied on so a re-scrape
// produces the same slugs from the same corpus.
export const HOST_EXTRACTORS = {
  greenhouse: /(?:boards|job-boards)\.greenhouse\.io\/([a-z0-9][a-z0-9-_]{1,60})/gi,
  lever: /jobs\.lever\.co\/([a-z0-9][a-z0-9-_]{1,60})/gi,
  ashby: /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-_]{1,60})/gi,
  smartrecruiters: /(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9][a-z0-9-_]{1,60})/gi,
};

// Path segments that look like slugs in an ATS URL but aren't tenants —
// e.g. boards.greenhouse.io/embed, jobs.lever.co/search. Mirrors scrape-hn.
export const RESERVED = new Set([
  'embed', 'departments', 'jobs', 'search', 'job', 'j', 'i', 'careers',
  'about', 'company', 'apply', 'static', 'assets', 'api', 'login',
]);

/**
 * Pull every slug for one ATS out of a blob of text. Lower-cases (the public
 * Greenhouse/Lever/Ashby APIs are case-insensitive on the slug; SmartRecruiters
 * is NOT — its scraper supplies identifiers directly and shouldn't use this).
 */
export function extractSlugs(ats, text) {
  const re = HOST_EXTRACTORS[ats];
  if (!re) throw new Error(`No extractor for ats=${ats}`);
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text))) {
    const slug = m[1].toLowerCase();
    if (slug.length >= 2 && !RESERVED.has(slug)) out.push(slug);
  }
  return out;
}

/**
 * Merge freshly-discovered slugs into data/slugs-<ats>.json without losing
 * what's already there. `discovered` is a Map<slug, {hits, latestYear}> or an
 * array of {slug, hits, latestYear}. Existing rows are kept; hits accumulate,
 * latestYear takes the max. Returns { before, after, added }.
 */
export function mergeIntoSlugFile(ats, discovered) {
  mkdirSync(DATA_DIR, { recursive: true });
  const path = join(DATA_DIR, `slugs-${ats}.json`);

  const map = new Map();
  if (existsSync(path)) {
    for (const row of JSON.parse(readFileSync(path, 'utf8'))) {
      map.set(row.slug, { hits: row.hits || 0, latestYear: row.latestYear || 0 });
    }
  }
  const before = map.size;

  const entries = discovered instanceof Map
    ? [...discovered.entries()].map(([slug, meta]) => ({ slug, ...meta }))
    : discovered;

  for (const { slug, hits = 1, latestYear = 0 } of entries) {
    const prev = map.get(slug) || { hits: 0, latestYear: 0 };
    map.set(slug, {
      hits: prev.hits + hits,
      latestYear: Math.max(prev.latestYear, latestYear),
    });
  }

  const rows = [...map.entries()]
    .map(([slug, meta]) => ({ slug, ...meta }))
    .sort((a, b) => b.latestYear - a.latestYear || b.hits - a.hits);

  writeFileSync(path, JSON.stringify(rows, null, 2));
  return { before, after: rows.length, added: rows.length - before, path };
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
