#!/usr/bin/env node
/**
 * One-shot diagnostic: fetch a WAAS company page, decode the Inertia.js
 * payload, and print the keys + first 500 chars of every string-valued
 * field on the first job. Used to find the actual field name(s) that hold
 * descriptions, since they're guessed in providers.mjs.
 *
 * Usage:
 *   node scripts/inspect-waas.mjs              # default slug
 *   node scripts/inspect-waas.mjs anthropic    # custom slug
 *
 * Requires NODE_EXTRA_CA_CERTS on Norton'd Windows machines.
 */

import { selectAll } from '../src/supabase-client.mjs';
import { PROVIDERS } from '../src/providers.mjs';

const argSlug = process.argv[2];
let slugs;

if (argSlug) {
  slugs = [argSlug];
} else {
  // Pull a few real WAAS slugs from the DB so we sample actual data.
  try {
    const rows = await selectAll('companies', {
      ats: 'eq.workatastartup',
      enabled: 'eq.true',
      select: 'slug',
      limit: '5',
    });
    slugs = rows.map((r) => r.slug);
    if (!slugs.length) {
      console.error('No enabled workatastartup companies in DB. Pass a slug as arg.');
      process.exit(1);
    }
  } catch (e) {
    console.error(`couldn't query companies (${e.message}); falling back to a single example`);
    slugs = ['dots-2'];
  }
}

const provider = PROVIDERS.workatastartup;

for (const slug of slugs) {
  const url = provider.probeUrl(slug);
  console.log('\n' + '='.repeat(70));
  console.log(`Fetching ${url}`);

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; fyj-scanner-inspect/0.1)',
      },
    });
  } catch (e) {
    console.error(`fetch failed: ${e.message}`);
    continue;
  }

  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    continue;
  }

  const text = await res.text();
  let json;
  try {
    json = provider.extract(text);
  } catch (e) {
    console.error(`extract failed: ${e.message}`);
    continue;
  }

  const jobs = json?.props?.company?.jobs;
  if (!Array.isArray(jobs) || jobs.length === 0) {
    console.log(`  (no jobs)`);
    continue;
  }

  const sample = jobs[0];
  console.log(`Slug: ${slug}, jobs: ${jobs.length}, first job id: ${sample.id}`);
  console.log(`Listing fields: ${Object.keys(sample).sort().join(', ')}`);

  // Now fetch the per-job page to find where descriptions actually live.
  const jobUrl = `https://www.workatastartup.com/jobs/${sample.id}`;
  console.log(`\n  → fetching ${jobUrl}`);
  let jobRes;
  try {
    jobRes = await fetch(jobUrl, {
      headers: {
        Accept: 'text/html',
        'User-Agent': 'Mozilla/5.0 (compatible; fyj-scanner-inspect/0.1)',
      },
    });
  } catch (e) {
    console.error(`    fetch failed: ${e.message}`);
    continue;
  }
  if (!jobRes.ok) {
    console.error(`    HTTP ${jobRes.status}`);
    continue;
  }
  const jobText = await jobRes.text();
  let jobJson;
  try {
    jobJson = provider.extract(jobText); // same data-page extractor
  } catch (e) {
    console.error(`    extract failed: ${e.message}`);
    continue;
  }

  // Inertia pages have props.* with the page state. Dump where things live.
  const props = jobJson?.props ?? {};
  console.log(`    props top-level keys: ${Object.keys(props).sort().join(', ')}`);

  // Try common places the per-job payload could be: props.job, props.posting,
  // props.listing, props.company.jobs[0], etc.
  const candidates = [
    ['props.job', props.job],
    ['props.posting', props.posting],
    ['props.listing', props.listing],
    ['props.company?.jobs[0]', props.company?.jobs?.[0]],
  ].filter(([_, v]) => v && typeof v === 'object');

  for (const [path, obj] of candidates) {
    console.log(`\n    ${path} keys: ${Object.keys(obj).sort().join(', ')}`);
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (typeof v === 'string' && v.length > 100) {
        const preview = v.replace(/\s+/g, ' ').slice(0, 200);
        console.log(`      ${key}  (len=${v.length}): ${preview}…`);
      }
    }
  }
}
