#!/usr/bin/env node
/**
 * backfill-classification.mjs — tag jobs with {job_family, is_target, seniority}.
 *
 * Two-stage hybrid (relevance layer / f-113):
 *   1. RULES (free, always): src/classify.mjs high-precision title rules.
 *   2. LLM   (--llm, needs OPENAI_API_KEY): gpt-4o-mini adjudicates the
 *      titles the rules left ambiguous (confidence 'low').
 *
 * Usage:
 *   node --env-file=.env scripts/backfill-classification.mjs            # rules only, unclassified rows
 *   node --env-file=.env scripts/backfill-classification.mjs --llm      # rules + LLM for the ambiguous
 *   node --env-file=.env scripts/backfill-classification.mjs --all      # reclassify everything (after a rules change)
 *   node --env-file=.env scripts/backfill-classification.mjs --llm --limit 2000
 *
 * Updates are grouped by (family,is_target,seniority) and applied with one
 * PATCH per group over an id=in.() chunk — a few hundred requests for the whole
 * table instead of one per row.
 */

import { selectAll, update } from '../src/supabase-client.mjs';
import { classifyTitle } from '../src/classify.mjs';

const args = process.argv.slice(2);
const RECLASSIFY_ALL = args.includes('--all');
const USE_LLM = args.includes('--llm');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? Number(args[i + 1]) : Infinity;
})();
const ID_CHUNK = 150;
const LLM_MODEL = 'gpt-4o-mini';
const LLM_BATCH = Number(process.env.CLASSIFY_LLM_BATCH || 40);
const LLM_CONCURRENCY = Number(process.env.CLASSIFY_LLM_CONCURRENCY || 4);

// Families the rules engine + LLM share. Keep in sync with src/classify.mjs.
const TARGET_FAMILIES = ['software_engineering', 'data_ai', 'it_infrastructure', 'security', 'product', 'design', 'finance', 'sales', 'marketing', 'consulting', 'legal', 'hr_recruiting', 'executive_leadership', 'research', 'operations', 'other_professional'];
const NON_TARGET_FAMILIES = ['service_hospitality', 'retail', 'clinical_healthcare', 'skilled_trades', 'manual_labor', 'security_guard', 'education_childcare', 'other_non_professional'];

async function main() {
  const query = {
    closed_at: 'is.null',
    select: 'id,title',
  };
  if (!RECLASSIFY_ALL) query.classified_at = 'is.null';
  console.log(`Loading active jobs${RECLASSIFY_ALL ? ' (ALL — reclassify)' : ' (unclassified only)'}…`);
  const jobs = await selectAll('jobs', query, { maxRows: LIMIT });
  console.log(`  ${jobs.length} jobs to classify`);
  if (jobs.length === 0) return;

  // ── stage 1: rules ────────────────────────────────────────────────
  const ruled = [];
  const ambiguous = [];
  for (const j of jobs) {
    const c = classifyTitle(j.title);
    if (c.confidence === 'high') ruled.push({ id: j.id, ...c });
    else ambiguous.push({ id: j.id, title: j.title, seniority: c.seniority });
  }
  console.log(`Rules: ${ruled.length} confident, ${ambiguous.length} ambiguous`);
  const r = await flushUpdates(ruled, 'rules');
  console.log(`  wrote ${r} rules-classified rows`);

  // ── stage 2: LLM (optional) ───────────────────────────────────────
  if (!USE_LLM) {
    console.log(`Skipping ${ambiguous.length} ambiguous (run with --llm to resolve).`);
    return;
  }
  if (!process.env.OPENAI_API_KEY) {
    console.error('--llm set but OPENAI_API_KEY missing; leaving ambiguous rows unclassified.');
    return;
  }
  console.log(`LLM: classifying ${ambiguous.length} ambiguous titles (${LLM_MODEL}, batch ${LLM_BATCH})…`);
  const llmResults = await llmClassifyAll(ambiguous);
  const wrote = await flushUpdates(llmResults, 'llm');
  console.log(`  wrote ${wrote} LLM-classified rows (${ambiguous.length - wrote} failed/skipped)`);
}

// Group rows by identical (family,is_target,seniority) and PATCH each group's
// ids in chunks — one body per distinct classification, not per row.
async function flushUpdates(rows, by) {
  const groups = new Map();
  for (const row of rows) {
    if (row.is_target == null || !row.family) continue; // nothing to write
    const key = `${row.family}|${row.is_target}|${row.seniority ?? ''}`;
    let g = groups.get(key);
    if (!g) { g = { family: row.family, is_target: row.is_target, seniority: row.seniority ?? null, ids: [] }; groups.set(key, g); }
    g.ids.push(row.id);
  }
  const nowIso = new Date().toISOString();
  let written = 0;
  for (const g of groups.values()) {
    for (let i = 0; i < g.ids.length; i += ID_CHUNK) {
      const chunk = g.ids.slice(i, i + ID_CHUNK);
      try {
        await update('jobs', { id: `in.(${chunk.join(',')})` }, {
          job_family: g.family,
          is_target: g.is_target,
          seniority: g.seniority,
          classified_at: nowIso,
          classified_by: by,
        }, { returning: 'minimal' });
        written += chunk.length;
      } catch (e) {
        console.error(`update failed (${g.family}/${chunk.length} ids): ${e.message}`);
      }
    }
  }
  return written;
}

// ── LLM classification ──────────────────────────────────────────────
const LLM_SYSTEM = `You classify JOB TITLES for an AI staffing agency whose customers are tech/IT professionals, knowledge-workers, senior/executive leaders (any function), and students/interns in those fields.

For each title decide:
- family: one of [${[...TARGET_FAMILIES, ...NON_TARGET_FAMILIES].join(', ')}]
- is_target: true if a customer above would plausibly want this role; false for blue-collar/manual/service/retail/hospitality/skilled-trade/clinical-care roles they would never pay to be matched to.

Classify by the ROLE itself, never the employer's industry: "Data Scientist" at a restaurant = target; "Dishwasher" at a tech company = not. Engineering/finance/sales/marketing/product/design/legal/HR professional & leadership roles = target. Nurses, dentists, caregivers, technicians (auto/field/maintenance), drivers, warehouse, retail, food service, cleaning = not target. Use other_professional/other_non_professional only when no specific family fits.

Reply ONLY with a JSON object: {"results":[{"i":<index>,"family":"<family>","is_target":<bool>}, ...]} covering every input index.`;

async function llmClassifyAll(items) {
  const batches = [];
  for (let i = 0; i < items.length; i += LLM_BATCH) batches.push(items.slice(i, i + LLM_BATCH));
  const out = [];
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const b = batches[cursor++];
      const res = await llmClassifyBatch(b);
      for (let k = 0; k < b.length; k++) {
        const c = res[k];
        if (c && c.family && typeof c.is_target === 'boolean') {
          out.push({ id: b[k].id, family: c.family, is_target: c.is_target, seniority: b[k].seniority });
        }
      }
      if (cursor % 10 === 0) console.log(`  …${Math.min(cursor * LLM_BATCH, items.length)}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: LLM_CONCURRENCY }, worker));
  return out;
}

async function llmClassifyBatch(batch, attempt = 1) {
  const user = batch.map((b, i) => `${i}. ${b.title}`).join('\n');
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: LLM_SYSTEM }, { role: 'user', content: user }],
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      if (attempt > 5) return [];
      await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1000 * 2 ** attempt)));
      return llmClassifyBatch(batch, attempt + 1);
    }
    if (!res.ok) { console.error(`LLM ${res.status}: ${(await res.text()).slice(0, 160)}`); return []; }
    const data = await res.json();
    const parsed = JSON.parse(data.choices[0].message.content);
    const arr = Array.isArray(parsed.results) ? parsed.results : [];
    const byIdx = [];
    for (const x of arr) if (typeof x.i === 'number') byIdx[x.i] = x;
    return byIdx;
  } catch (e) {
    if (attempt > 5) { console.error(`LLM batch failed: ${e.message}`); return []; }
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 1000 * 2 ** attempt)));
    return llmClassifyBatch(batch, attempt + 1);
  }
}

await main();
