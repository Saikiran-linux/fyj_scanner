#!/usr/bin/env node
/**
 * scripts/tailor-resume.mjs — CLI driver for the f-402 tailor pipeline.
 *
 * Usage:
 *   node --env-file=.env scripts/tailor-resume.mjs \
 *     --resume <path-to-resume.md-or-.txt> \
 *     ( --job-id <uuid> | --job-description <path-to-jd.md-or-.txt> ) \
 *     [ --job-title "Senior Data Engineer" ]      # required if --job-description used
 *     [ --job-company "Cohere Health" ]
 *     [ --job-location "Remote US" ]
 *     [ --threshold 7 ]   # evaluator score needed to stop early (default 7)
 *     [ --max-attempts 3 ] # 1 initial + 2 retries (default 3)
 *     [ --out output/tailored/auto.md ]   # default: output/tailored/<job>-<ts>.md
 *
 * Resume input: plain text or markdown only in v1. PDF parsing is the
 * planned process-resume edge function (see HOSTED_PLATFORM_PLAN.md
 * Phase 2). Convert PDF → text first: `pdftotext resume.pdf resume.txt`
 * or paste the resume into a .md file.
 *
 * Exit codes:
 *   0  shipped a draft (score >= threshold OR max attempts hit with best-effort draft)
 *   1  CLI usage error
 *   2  LLM error after retries — see stderr for the underlying failure
 */

import fs from 'node:fs';
import path from 'node:path';
import { tailor } from '../src/tailor/loop.mjs';
import { PROVIDER } from '../src/tailor/llm.mjs';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      args[key] = val;
    }
  }
  return args;
}

function die(code, msg) { console.error(msg); process.exit(code); }

const args = parseArgs(process.argv.slice(2));
if (!args.resume) die(1, 'usage: --resume <path> required');
if (!args['job-id'] && !args['job-description']) {
  die(1, 'usage: one of --job-id or --job-description required');
}

const resumePath = path.resolve(args.resume);
if (!fs.existsSync(resumePath)) die(1, `resume not found: ${resumePath}`);
const resumeText = fs.readFileSync(resumePath, 'utf8');
if (resumeText.length < 200) {
  die(1, `resume is suspiciously short (${resumeText.length} chars) — is the path right?`);
}

// Resolve the job — either from DB (preferred) or from a local file.
async function resolveJob() {
  if (args['job-description']) {
    const jdPath = path.resolve(args['job-description']);
    if (!fs.existsSync(jdPath)) die(1, `job-description not found: ${jdPath}`);
    return {
      title: args['job-title'] || die(1, '--job-title required when using --job-description'),
      company: args['job-company'] || null,
      location: args['job-location'] || null,
      url: null,
      description: fs.readFileSync(jdPath, 'utf8'),
      description_summary: null,
    };
  }

  // --job-id path: fetch from Supabase via PostgREST with the service-role key.
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) die(1, 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing for --job-id');
  const select = 'title,location,department,url,description,description_summary,companies(slug)';
  const endpoint = `${url}/rest/v1/jobs?select=${encodeURIComponent(select)}&id=eq.${args['job-id']}`;
  const res = await fetch(endpoint, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Accept: 'application/json' },
  });
  if (!res.ok) die(2, `fetching job ${args['job-id']}: HTTP ${res.status} ${(await res.text()).slice(0,200)}`);
  const rows = await res.json();
  if (!rows.length) die(1, `job ${args['job-id']} not found`);
  const j = rows[0];
  return {
    title: j.title,
    company: j.companies?.slug || null,
    location: j.location,
    url: j.url,
    description: j.description,
    description_summary: j.description_summary,
  };
}

const job = await resolveJob();
const threshold = Number(args.threshold ?? 7);
const maxAttempts = Number(args['max-attempts'] ?? 3);

console.log(`──────────────────────────────────────────────────`);
console.log(`f-402 tailor · provider=${PROVIDER} · threshold=${threshold} · max=${maxAttempts}`);
console.log(`resume:  ${resumePath} (${resumeText.length} chars)`);
console.log(`job:     ${job.title}${job.company ? ' @ ' + job.company : ''}${job.location ? ' · ' + job.location : ''}`);
console.log(`──────────────────────────────────────────────────`);

const result = await tailor({
  resumeText,
  job,
  threshold,
  maxAttempts,
  onProgress: (rec) => {
    console.log(
      `  attempt ${rec.attempt}: score=${rec.score}/10 · ${rec.durationMs}ms · ` +
      `gen $${rec.generatorCostUSD?.toFixed(4)} + eval $${rec.evaluatorCostUSD?.toFixed(4)}`,
    );
    if (rec.critique?.missing_keywords?.length) {
      console.log(`    missing: ${rec.critique.missing_keywords.slice(0, 8).join(', ')}` +
        (rec.critique.missing_keywords.length > 8 ? '…' : ''));
    }
    if (rec.critique?.weakest_sections?.length) {
      console.log(`    weakest: ${rec.critique.weakest_sections.join(', ')}`);
    }
  },
});

// Where to write the winning draft.
const outPath = args.out
  ? path.resolve(args.out)
  : path.resolve(
      'output/tailored',
      `${(job.company || 'job').replace(/[^a-z0-9-]/gi, '_')}-${Date.now()}.md`,
    );
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, result.winner.tailoredMarkdown);

console.log(`──────────────────────────────────────────────────`);
console.log(`stop reason:  ${result.stopReason}`);
console.log(`best attempt: #${result.winner.attempt} · score ${result.winner.score}/10`);
console.log(`total calls:  ${result.totalCalls} · total cost: $${result.totalCostUSD.toFixed(4)}`);
console.log(`wrote draft:  ${outPath}`);
if (result.winner.critique?.feedback) {
  console.log(`\nevaluator feedback on winning draft:`);
  console.log(`  ${result.winner.critique.feedback}`);
}
if (result.stopReason === 'error') {
  console.error(`\n(loop hit an LLM error: ${result.error?.message})`);
  process.exit(2);
}
