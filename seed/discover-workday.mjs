#!/usr/bin/env node
/**
 * discover-workday.mjs — verify Workday career URLs and merge them into
 * data/slugs-workday.json (the curated slug source for the workday adapter,
 * f-104).
 *
 * WHY URLs, not company names: fully-automatic name -> tenant:dc:site discovery
 * isn't possible from Workday itself. The datacenter subdomain is guessable via
 * DNS, but the *site* id lives only in the public career URL a company links to
 * — the myworkdayjobs.com host root returns 406 with no redirect, and the bare
 * {tenant}.myworkdayjobs.com host doesn't resolve. So the slug source is
 * external career URLs (from a web search for "<company> myworkdayjobs.com",
 * a careers-page link, LinkedIn, etc.). This script does the mechanical part:
 * parse tenant:dc:site out of each URL, confirm it's live via the CXS jobs
 * endpoint, and add the verified ones (deduped) to the seed file.
 *
 * Usage:
 *   node seed/discover-workday.mjs <career-url> [<career-url> ...]
 *   node seed/discover-workday.mjs --file urls.txt        # one URL per line
 *   node seed/discover-workday.mjs --file urls.txt --dry  # verify, don't write
 *
 * A career URL is anything under a myworkdayjobs.com host, e.g.
 *   https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite
 *   https://tenant.wd1.myworkdayjobs.com/SiteName/job/Loc/Title_JR123 (job link)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PROVIDERS } from '../src/providers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'data', 'slugs-workday.json');
const UA = 'Mozilla/5.0 (compatible; fyj-scanner/0.2; +https://github.com/Saikiran-linux/fyj_scanner)';

/** Parse any myworkdayjobs.com career/job URL -> { tenant, dc, site } | null. */
export function parseWorkdayUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  const host = u.hostname.match(/^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/i);
  if (!host) return null;
  const [, tenant, dc] = host;
  // Path is /{locale?}/{site}/... — the site is the first segment that isn't a
  // locale (en-US) and isn't the /job/ detail marker.
  const segs = u.pathname.split('/').filter(Boolean);
  const site = segs.find((s) => !/^[a-z]{2}-[A-Za-z]{2}$/.test(s) && s.toLowerCase() !== 'job');
  return site ? { tenant: tenant.toLowerCase(), dc: dc.toLowerCase(), site } : null;
}

/** Confirm a tenant:dc:site is live by asking its CXS listing for 1 job. */
async function cxsOk(tenant, dc, site) {
  const url = `https://${tenant}.${dc}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: '' }),
    });
    if (!r.ok) return { ok: false, status: r.status };
    const j = await r.json();
    return { ok: Number.isFinite(j.total), total: j.total };
  } catch (e) { return { ok: false, err: e.code || e.message }; }
}

const args = process.argv.slice(2);
const dry = args.includes('--dry');
let urls = [];
const fileIdx = args.indexOf('--file');
if (fileIdx !== -1 && args[fileIdx + 1]) {
  urls = readFileSync(args[fileIdx + 1], 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
} else {
  urls = args.filter((a) => !a.startsWith('--'));
}
if (!urls.length) {
  console.error('usage: discover-workday.mjs <career-url>... | --file urls.txt [--dry]');
  process.exit(1);
}

const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : [];
const bySlug = new Map(existing.map((r) => [r.slug, r]));
const startedWith = bySlug.size;

let verified = 0, added = 0, failed = 0;
for (const raw of urls) {
  const p = parseWorkdayUrl(raw);
  if (!p) { console.log(`SKIP  unparseable: ${raw}`); failed++; continue; }
  const slug = `${p.tenant}:${p.dc}:${p.site}`;
  const c = await cxsOk(p.tenant, p.dc, p.site);
  if (!c.ok) { console.log(`FAIL  ${slug}  (cxs ${c.status || c.err})`); failed++; continue; }
  verified++;
  const dup = bySlug.has(slug);
  console.log(`OK    ${slug}  (${c.total} jobs)${dup ? '  [already present]' : ''}`);
  if (!dup) {
    bySlug.set(slug, {
      slug,
      careers_url: PROVIDERS.workday.careersUrl(slug),
      probe_url: PROVIDERS.workday.probeUrl(slug),
    });
    added++;
  }
}

const merged = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
console.log(`\nVerified ${verified}, failed/skipped ${failed}, new ${added} (was ${startedWith}, now ${merged.length}).`);
if (dry) { console.log('--dry: not writing.'); process.exit(0); }
if (added) {
  writeFileSync(OUT, JSON.stringify(merged, null, 2) + '\n');
  console.log(`Wrote ${OUT}`);
} else {
  console.log('No new tenants — file unchanged.');
}
