#!/usr/bin/env node
/**
 * seed-companies.mjs — one-shot loader.
 *
 * Reads data/seeds.json and upserts each row into Supabase `companies`.
 * Safe to re-run: existing rows are updated (careers_url / probe_url),
 * enabled flag is preserved unless explicitly being re-enabled.
 *
 * Run once after creating the schema. Re-run any time you regenerate seeds.json.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { upsert, selectAll } from './supabase-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEEDS = join(__dirname, '..', 'data', 'seeds.json');

const seeds = JSON.parse(readFileSync(SEEDS, 'utf-8'));
console.log(`Loaded ${seeds.length} seeds from ${SEEDS}`);

// selectAll paginates past PostgREST's 1k max-rows cap.
const existing = await selectAll('companies', { select: 'ats,slug,enabled' });
const existingMap = new Map(existing.map((c) => [`${c.ats}::${c.slug}`, c]));
console.log(`Existing in DB: ${existing.length}`);

const rows = seeds.map((s) => {
  const existingRow = existingMap.get(`${s.ats}::${s.slug}`);
  return {
    ats: s.ats,
    slug: s.slug,
    careers_url: s.careers_url,
    probe_url: s.probe_url,
    // Preserve enabled flag for existing rows. New rows default to true.
    enabled: existingRow ? existingRow.enabled : true,
  };
});

const CHUNK = 200;
for (let i = 0; i < rows.length; i += CHUNK) {
  const chunk = rows.slice(i, i + CHUNK);
  await upsert('companies', chunk, 'ats,slug', { returning: 'minimal' });
  console.log(`  upserted ${Math.min(i + CHUNK, rows.length)}/${rows.length}`);
}

const after = await selectAll('companies', { select: 'ats' });
const counts = after.reduce((acc, r) => ({ ...acc, [r.ats]: (acc[r.ats] || 0) + 1 }), {});
console.log(`\nDone. Companies table now contains:`, counts, `(total ${after.length})`);
