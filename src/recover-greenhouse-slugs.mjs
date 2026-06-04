#!/usr/bin/env node
/**
 * recover-greenhouse-slugs.mjs — reclaim Greenhouse companies the scanner lost.
 *
 * Background (feature_list.json f-101): a large slice of Greenhouse seeds 404
 * after we record them. The scanner auto-disables a company after
 * AUTO_DISABLE_THRESHOLD consecutive errors, so those tenants sit in the
 * `companies` table as `enabled=false` with a `404` last_error — companies we
 * already discovered but can no longer reach. Reclaiming them is the cheapest
 * way to grow scan coverage: no new discovery, no new ATS, just a corrected
 * pointer.
 *
 * MEASURED (40-row live sample of the disabled-Greenhouse pool, 2026-06):
 *   - Suffix slug-drift (`notion` → `notion-labs`): ~0% on this aged pool. The
 *     `e.g. notion → notion-labs` in the original f-101 note turns out to be
 *     illustrative, not the dominant pattern — `notion-labs` 404s too.
 *   - Cross-ATS migration (same slug, different ATS): ~15%. The recoverable
 *     companies are live businesses (Strava, Osmo, Mutiny, Benevity, …) that
 *     migrated Greenhouse → Ashby and kept their slug token.
 * So this script leads with cross-ATS recovery and keeps suffix-variants as a
 * cheap secondary pass. The rest of the disabled pool is mostly dead/acquired
 * companies that are genuinely gone — those are left disabled, not guessed at.
 *
 * Strategy per candidate, highest-confidence first:
 *   1. Re-verify the current Greenhouse slug. If it responds again (transient
 *      404 / tenant returned), re-enable the row in place — no pointer change.
 *   2. Cross-ATS: probe Ashby / Lever / SmartRecruiters with the *same* slug.
 *      An identical slug token on another ATS is a strong identity match
 *      (company migrated). First live, non-empty board wins → rewrite ats+slug.
 *   3. Same-ATS slug variants: append a common suffix, strip a trailing
 *      suffix, collapse hyphens. Lower confidence → tried last, capped.
 *   4. Nothing resolves → row is left exactly as it was.
 *
 * Heuristic, not exact. We (a) require a non-empty board by default, (b) never
 * rewrite onto an (ats, slug) another row already owns, and (c) print every
 * change and write a JSON audit report so a human can review.
 *
 * Candidate selection (default): ats=greenhouse AND last_error ~ 404. Disabled
 * rows are the prime targets; still-enabled 404'ing rows are included too.
 * --include-all sweeps every disabled Greenhouse row regardless of last_error.
 *
 * Safe + idempotent to re-run: a fixed row is now enabled with a working
 * pointer and no longer matches the 404 filter.
 *
 * Usage:
 *   node src/recover-greenhouse-slugs.mjs [--dry-run] [--limit=N]
 *        [--max-variants=N] [--allow-empty] [--include-all] [--include-enabled]
 *        [--no-cross-ats] [--no-variants]
 *   npm run recover-greenhouse -- --dry-run
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectAll, update } from './supabase-client.mjs';
import { PROVIDERS, fetchJobs } from './providers.mjs';
import { RateLimiter } from './rate-limiter.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── args ───────────────────────────────────────────────────────────────
const flag = (name) => process.argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DRY_RUN = flag('dry-run');
const LIMIT = Number(opt('limit', process.env.RECOVER_LIMIT || Infinity));
const MAX_VARIANTS = Number(opt('max-variants', process.env.RECOVER_MAX_VARIANTS || 3));
const ALLOW_EMPTY = flag('allow-empty') || process.env.RECOVER_ALLOW_EMPTY === '1';
const INCLUDE_ALL = flag('include-all'); // every disabled GH row, not just 404s
const INCLUDE_ENABLED = flag('include-enabled'); // also sweep enabled-but-404ing
const DO_CROSS_ATS = !flag('no-cross-ats');
const DO_VARIANTS = !flag('no-variants');
const TIMEOUT_MS = Number(process.env.SCAN_TIMEOUT_MS || 15_000);

const HOME_ATS = 'greenhouse';
// Cross-ATS probe order. Ashby first — empirically where migrated Greenhouse
// tenants land most often; SmartRecruiters last (slowest, most enterprise).
const CROSS_ATS = ['ashby', 'lever', 'smartrecruiters'];

// Suffixes that commonly get appended/dropped when a board token changes.
const APPEND_SUFFIXES = ['labs', 'hq', 'careers', 'jobs', 'inc', 'hr', 'global', 'ai', 'io'];
const KNOWN_SUFFIXES = ['labs', 'hq', 'inc', 'io', 'ai', 'app', 'team', 'careers', 'jobs', 'global', 'official', 'group', 'tech', 'hr'];

/**
 * Prioritised same-ATS slug variants for a drifted slug. Append-first (the
 * documented drift direction, lowest false-positive risk), then a suffix-strip,
 * then a hyphen collapse. De-duplicated; never includes the input slug.
 */
function slugVariants(slug) {
  const out = [];
  const seen = new Set([slug]);
  const push = (s) => {
    if (s && s !== slug && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const suf of APPEND_SUFFIXES) push(`${slug}-${suf}`);
  push(slug.replace(new RegExp(`-(${KNOWN_SUFFIXES.join('|')})$`), ''));
  if (slug.includes('-')) push(slug.replace(/-/g, ''));
  return out;
}

/** A probe "resolves" if it's a 200 with a parseable, non-empty board. */
function resolved(result) {
  if (!result?.ok || !result.schema_ok || !Array.isArray(result.jobs)) return false;
  return ALLOW_EMPTY ? true : result.jobs.length > 0;
}

async function probe(ats, slug, limiter) {
  try {
    return await fetchJobs(ats, slug, { timeoutMs: TIMEOUT_MS, limiter });
  } catch {
    return null;
  }
}

// ── load candidates ──────────────────────────────────────────────────────
const filter = { ats: `eq.${HOME_ATS}`, select: 'id,ats,slug,enabled,consecutive_errors,last_error' };
if (!INCLUDE_ENABLED) filter.enabled = 'eq.false';
if (!INCLUDE_ALL) filter.last_error = 'ilike.*404*';

let candidates = await selectAll('companies', filter);

// (ats, slug) is unique. Build the set of pairs every row already occupies so
// we never rewrite onto a tenant another company already covers (which would
// 409 and could merge two distinct companies).
const allRows = await selectAll('companies', { select: 'ats,slug' });
const taken = new Set(allRows.map((c) => `${c.ats}::${c.slug}`));

if (Number.isFinite(LIMIT)) candidates = candidates.slice(0, LIMIT);

console.log(
  `Greenhouse recovery${DRY_RUN ? ' (dry-run)' : ''}: ${candidates.length} candidate(s)` +
  `${INCLUDE_ALL ? ' [all disabled]' : ' [404 last_error]'}` +
  `${INCLUDE_ENABLED ? ' [incl. enabled]' : ''}. ` +
  `Strategies: re-verify` +
  `${DO_CROSS_ATS ? ', cross-ATS' : ''}` +
  `${DO_VARIANTS ? `, ${MAX_VARIANTS} slug-variant(s)` : ''}` +
  `${ALLOW_EMPTY ? '; empty boards allowed' : ''}.`,
);
if (candidates.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

const limiter = new RateLimiter();
const nowIso = () => new Date().toISOString();
const report = { reactivated: [], recovered_cross_ats: [], recovered_variant: [], unresolved: [], skipped: [] };
let attempted = 0;
const startedAt = Date.now();
let lastLog = 0;

function maybeLog() {
  const now = Date.now();
  if (now - lastLog < 10_000) return;
  lastLog = now;
  const elapsed = ((now - startedAt) / 1000).toFixed(0);
  const fixed = report.reactivated.length + report.recovered_cross_ats.length + report.recovered_variant.length;
  console.log(`  … ${attempted}/${candidates.length} checked (${fixed} fixed), ${elapsed}s`);
}

async function applyRewrite(id, ats, slug) {
  if (DRY_RUN) return;
  await update('companies', { id: `eq.${id}` }, {
    ats,
    slug,
    careers_url: PROVIDERS[ats].careersUrl(slug),
    probe_url: PROVIDERS[ats].probeUrl(slug),
    enabled: true,
    consecutive_errors: 0,
    last_error: null,
    last_success_at: nowIso(),
  }, { returning: 'minimal' });
}

for (const c of candidates) {
  attempted++;

  // 1. Re-verify the current Greenhouse slug.
  const base = await probe(HOME_ATS, c.slug, limiter);
  if (resolved(base)) {
    if (!DRY_RUN) {
      await update('companies', { id: `eq.${c.id}` }, {
        enabled: true, consecutive_errors: 0, last_error: null, last_success_at: nowIso(),
      }, { returning: 'minimal' });
    }
    report.reactivated.push({ slug: c.slug, jobs: base.jobs.length });
    console.log(`  ↻ reactivated ${c.slug} (${base.jobs.length} jobs, pointer unchanged)`);
    maybeLog();
    continue;
  }

  // 2. Cross-ATS: same slug on another provider (migration). High confidence.
  let won = null;
  if (DO_CROSS_ATS) {
    for (const ats of CROSS_ATS) {
      const key = `${ats}::${c.slug}`;
      if (taken.has(key)) { report.skipped.push({ slug: c.slug, target: key, reason: 'already covered' }); continue; }
      const r = await probe(ats, c.slug, limiter);
      if (resolved(r)) { won = { ats, slug: c.slug, jobs: r.jobs.length, how: 'cross_ats' }; break; }
    }
  }

  // 3. Same-ATS slug variants. Lower confidence → only if cross-ATS missed.
  if (!won && DO_VARIANTS) {
    for (const variant of slugVariants(c.slug).slice(0, MAX_VARIANTS)) {
      const key = `${HOME_ATS}::${variant}`;
      if (taken.has(key)) { report.skipped.push({ slug: c.slug, target: key, reason: 'already covered' }); continue; }
      const r = await probe(HOME_ATS, variant, limiter);
      if (resolved(r)) { won = { ats: HOME_ATS, slug: variant, jobs: r.jobs.length, how: 'variant' }; break; }
    }
  }

  if (!won) {
    report.unresolved.push({ slug: c.slug, last_error: c.last_error });
    maybeLog();
    continue;
  }

  await applyRewrite(c.id, won.ats, won.slug);
  taken.add(`${won.ats}::${won.slug}`); // reserve so a later candidate can't reclaim it
  if (won.how === 'cross_ats') {
    report.recovered_cross_ats.push({ slug: c.slug, from_ats: HOME_ATS, to_ats: won.ats, jobs: won.jobs });
    console.log(`  ⇄ recovered ${c.slug}: greenhouse → ${won.ats} (${won.jobs} jobs)`);
  } else {
    report.recovered_variant.push({ from: c.slug, to: won.slug, jobs: won.jobs });
    console.log(`  ✓ recovered ${c.slug} → ${won.slug} (${won.jobs} jobs)`);
  }
  maybeLog();
}

// ── summary + audit report ───────────────────────────────────────────────
const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
const totalFixed = report.reactivated.length + report.recovered_cross_ats.length + report.recovered_variant.length;
console.log('');
console.log(`Done in ${elapsed}s${DRY_RUN ? ' (dry-run — no rows changed)' : ''}.`);
console.log(`  Candidates:            ${candidates.length}`);
console.log(`  Reactivated:           ${report.reactivated.length}  (slug worked again, re-enabled in place)`);
console.log(`  Recovered (cross-ATS): ${report.recovered_cross_ats.length}  (migrated to Ashby/Lever/SR, same slug)`);
console.log(`  Recovered (variant):   ${report.recovered_variant.length}  (slug rewritten to a working variant)`);
console.log(`  Unresolved:            ${report.unresolved.length}  (no strategy resolved — left as-is)`);
if (report.skipped.length) {
  console.log(`  Skipped targets:       ${report.skipped.length}  (already owned by another company)`);
}

const snap = limiter.snapshot();
console.log('Per-source block-rate: ' + Object.entries(snap)
  .filter(([, s]) => s.ok + s.block + s.error > 0)
  .map(([ats, s]) => `${ats}: ${s.block_rate_pct}%`)
  .join(' | '));

const reportPath = join(__dirname, '..', 'data', 'recover-greenhouse-report.json');
writeFileSync(reportPath, JSON.stringify({ at: nowIso(), dry_run: DRY_RUN, ...report }, null, 2));
console.log(`Audit report → ${reportPath}`);

if (!DRY_RUN && totalFixed > 0) {
  console.log('');
  console.log(`${totalFixed} companies re-enabled. They'll be probed on the next scan —`);
  console.log('run `npm run scan` or wait for the cron to pick up the corrected pointers.');
}
