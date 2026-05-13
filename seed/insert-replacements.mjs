#!/usr/bin/env node
/**
 * insert-replacements.mjs
 *
 * Reads replacements.sql, extracts (ats, slug, careers_url, probe_url) rows,
 * and upserts them into Supabase `companies` using the existing client. New
 * rows default to enabled=true; rows that somehow already exist keep their
 * current enabled flag.
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.
 */

import { readFileSync } from 'fs';
import { upsert, selectAll } from '../src/supabase-client.mjs';

const sql = readFileSync('replacements.sql', 'utf8');

// Match each `  ('ats', 'slug', 'careers_url', 'probe_url')` tuple.
const re = /\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'\s*\)/g;
const rows = [];
let m;
while ((m = re.exec(sql))) {
  rows.push({ ats: m[1], slug: m[2], careers_url: m[3], probe_url: m[4] });
}
console.log(`Parsed ${rows.length} rows from replacements.sql`);

const existing = await selectAll('companies', { select: 'ats,slug,enabled' });
const existingMap = new Map(existing.map((c) => [`${c.ats}::${c.slug}`, c]));
console.log(`Existing in DB: ${existing.length}`);

const payload = rows.map((r) => {
  const cur = existingMap.get(`${r.ats}::${r.slug}`);
  return {
    ats: r.ats,
    slug: r.slug,
    careers_url: r.careers_url,
    probe_url: r.probe_url,
    enabled: cur ? cur.enabled : true,
    consecutive_errors: 0,
  };
});

const CHUNK = 200;
for (let i = 0; i < payload.length; i += CHUNK) {
  const chunk = payload.slice(i, i + CHUNK);
  await upsert('companies', chunk, 'ats,slug', { returning: 'minimal' });
  console.log(`  upserted ${Math.min(i + CHUNK, payload.length)}/${payload.length}`);
}

const after = await selectAll('companies', { select: 'ats,enabled' });
const total = after.length;
const enabled = after.filter((r) => r.enabled).length;
const byAts = after.reduce((a, r) => ({ ...a, [r.ats]: (a[r.ats] || 0) + 1 }), {});
console.log(`\nDone. Companies table now: ${total} total, ${enabled} enabled. Per ATS:`, byAts);
