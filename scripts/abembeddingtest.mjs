#!/usr/bin/env node
/**
 * A/B embedding quality harness — compares three strategies for job↔resume
 * matching quality using your actual Supabase data and your resume.
 *
 *   A2  truncated raw description (first 1500 chars — current scan fallback)
 *   A1  full raw description (no truncation, ~5400 chars avg)
 *   B   LLM 14-field summary (current production path when summary exists)
 *
 * All three use the same title + structured-signal block prefix that
 * buildJobText() prepends in src/embeddings.mjs. Only the description
 * portion varies.
 *
 * Metrics:
 *   mean cosine similarity @ top-10 and top-30
 *   separation  = mean(top-10) − mean(all jobs) — discriminability score
 *   overlap@10  = |top-10(X) ∩ top-10(Y)| / 10  for each strategy pair
 *   Spearman ρ  = rank correlation between strategy pairs (full 200-job list)
 *
 * Does NOT write to Supabase. Reads ~200 rows + fires OpenAI embedding batches.
 * Cost: ~$0.01 total (three batches of 200 texts + 1 resume embed).
 *
 * Usage:  npm run ab-test
 *   or:   node --env-file=.env scripts/abembeddingtest.mjs
 */

import { selectAll } from '../src/supabase-client.mjs';
import {
  embedTexts,
  buildJobText,
  extractSeniorityFromTitle,
  formatCompForEmbedding,
} from '../src/embeddings.mjs';

// ── Config ──────────────────────────────────────────────────────────────────

const SAMPLE_SIZE = 200;
// A2 mirrors the production fallback in buildJobText (src/embeddings.mjs).
const DESCRIPTION_CHAR_LIMIT_A2 = 1500;
// A1 ("full description") still needs a ceiling: text-embedding-3-small caps
// at 8191 tokens (~32k chars) and a few descriptions reach 232k chars, which
// would 400 the request. 30k chars (~7.5k tok) keeps every realistic posting
// intact while staying safely under the model limit.
const DESCRIPTION_CHAR_LIMIT_A1 = 30000;

// ── Text construction ─────────────────────────────────────────────────────────
// buildJobText() in src/embeddings.mjs ALWAYS truncates a raw description to
// 1500 chars, so we can't use it to build the "full description" variant — it
// would silently clip A1 down to A2. Instead we replicate its exact prefix
// (title + structured-signal block) and append whatever description body each
// strategy specifies. The prefix is held identical across A2/A1/B so the only
// variable is the description body — that's the whole experiment.

function buildPrefix(job) {
  const parts = [job.title || ''];
  const signals = [];
  const seniority = extractSeniorityFromTitle(job.title);
  if (seniority) signals.push(`Seniority: ${seniority}`);
  if (job.remote) signals.push(`Workplace: ${job.remote}`);
  const comp = formatCompForEmbedding(job);
  if (comp) signals.push(`Compensation: ${comp}`);
  if (job.employment_type) signals.push(`Employment type: ${job.employment_type}`);
  if (job.department) signals.push(`Department: ${job.department}`);
  if (job.location) signals.push(`Location: ${job.location}`);
  if (signals.length) parts.push(signals.join('\n'));
  return parts;
}

// Same join shape as buildJobText: prefix parts + body, '\n\n'-joined.
function buildText(job, body) {
  const parts = buildPrefix(job);
  if (body) parts.push(body);
  return parts.join('\n\n');
}

// Truncate to a char cap, appending the same '…' marker buildJobText uses.
function cap(text, limit) {
  if (!text) return text;
  return text.length > limit ? text.slice(0, limit) + '…' : text;
}

// ── Resume definition ───────────────────────────────────────────────────────
// Same text as scripts/embed-resume.mjs — kept inline to avoid the dep and
// so the test is self-contained. Update both if the resume changes.

const RESUME_TITLE = 'Senior Data Engineer / AI Engineer (GenAI · RAG · Healthcare IT)';
const RESUME_SIGNALS = [
  'Seniority: senior',
  'Workplace: hybrid',
  'Employment type: full-time',
  'Department: Data / AI Engineering',
  'Location: Irving, Texas, United States',
].join('\n');
const RESUME_SUMMARY = [
  'Role: Design AI-augmented data pipelines and RAG-based GenAI workflows over healthcare and financial datasets, integrating LLMs with cloud-native ETL on AWS.',
  'Level: senior (IC track)',
  'Experience: 4+ years',
  'Required skills: Python, SQL, PySpark, Apache Spark, AWS (S3, Lambda, Bedrock, SageMaker, Step Functions, Redshift, CloudWatch), Snowflake, Databricks, Apache Airflow, dbt, ETL, data warehousing, RAG, LangChain, LangGraph, LlamaIndex, vector databases (FAISS, OpenSearch), LLM integration (GPT-4, Claude, Gemini, OpenAI, Anthropic), prompt engineering, TensorFlow, PyTorch, XGBoost, LightGBM, scikit-learn, MLflow, Docker, MLOps, NLP, Hugging Face transformers, Tableau, Power BI',
  'Preferred skills: GCP (BigQuery, Vertex AI), Azure (Synapse, Data Factory, Blob Storage), agentic AI (CrewAI, AutoGen), Explainable AI (XAI), time-series forecasting (ARIMA, Prophet), Jenkins, Azure DevOps, MEDITECH Expanse EHR, healthcare interoperability, R, MATLAB, SAS, Streamlit, FastAPI, Plotly, Looker, Alteryx, Fivetran',
  'Team: data engineering / AI engineering / applied ML — building ingestion, embedding, retrieval, and LLM-serving pipelines that feed analytics and BI',
  'Industry: healthcare IT, AI/ML, GenAI, fintech / financial services, enterprise data analytics',
  'Company stage: any (experience across enterprise healthcare and offshore IT services)',
  'Location: Irving, Texas, United States',
  'Remote policy: remote or hybrid, US-based',
  'Compensation: unknown',
  'Benefits: unknown',
  'Visa: US work authorization',
  'Schedule: full-time',
].join('\n');

const RESUME_TEXT = `${RESUME_TITLE}\n\n${RESUME_SIGNALS}\n\n${RESUME_SUMMARY}`;

// ── Helpers ──────────────────────────────────────────────────────────────────

// OpenAI text-embedding-3-small returns unit-normalised vectors,
// so dot product == cosine similarity.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

// Spearman rank-correlation between two equal-length arrays of scores.
// Returns ρ in [-1, 1]. Higher = strategies agree on ranking.
function spearman(a, b) {
  const n = a.length;
  const rankOf = (arr) => {
    const idx = arr.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v);
    const r = new Array(n);
    idx.forEach(({ i }, rank) => { r[i] = rank + 1; });
    return r;
  };
  const ra = rankOf(a);
  const rb = rankOf(b);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

// Given a sorted-desc list of { id, score } and a similarity array aligned
// to jobIds, compute metrics.
function metrics(sims, jobIds, label, resumeSims) {
  const ranked = jobIds
    .map((id, i) => ({ id, score: sims[i] }))
    .sort((a, b) => b.score - a.score);

  const top10 = ranked.slice(0, 10);
  const top30 = ranked.slice(0, 30);
  const allMean = mean(sims);

  return {
    label,
    top10ids: new Set(top10.map((r) => r.id)),
    top10: top10.map((r) => r.score),
    top30mean: mean(top30.map((r) => r.score)),
    top10mean: mean(top10.map((r) => r.score)),
    allMean,
    separation: mean(top10.map((r) => r.score)) - allMean,
    scores: sims, // full aligned array for rank correlation
    top10list: top10,
  };
}

function overlap(setA, setB) {
  let count = 0;
  for (const id of setA) if (setB.has(id)) count++;
  return count / 10;
}

function pct(n) { return (n * 100).toFixed(1) + '%'; }
function fmt(n) { return n.toFixed(4); }

// ── Main ─────────────────────────────────────────────────────────────────────

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY is not set');
  process.exit(1);
}
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

console.log(`Fetching ${SAMPLE_SIZE} active jobs with both description and summary...`);
const rows = await selectAll('v_jobs_enriched', {
  closed_at: 'is.null',
  description: 'not.is.null',
  description_summary: 'not.is.null',
  select: [
    'id', 'title', 'department', 'location', 'description', 'description_summary',
    'comp_min', 'comp_max', 'comp_currency', 'comp_interval', 'comp_text',
    'remote', 'employment_type',
  ].join(','),
  // Most-recently scanned first to get a representative current sample.
  order: 'id.desc',
}, { pageSize: SAMPLE_SIZE, maxRows: SAMPLE_SIZE });

if (rows.length < 10) {
  console.error(`Only ${rows.length} rows returned — not enough to evaluate. Run backfill-summaries first.`);
  process.exit(1);
}

console.log(`Got ${rows.length} jobs. Building 3 text variants per job...`);

const jobIds = rows.map((r) => r.id);

// A2: prefix + raw description truncated to 1500 chars (production fallback).
const textsA2 = rows.map((r) => buildText(r, cap(r.description, DESCRIPTION_CHAR_LIMIT_A2)));

// A1: prefix + full raw description (capped at the model's token ceiling).
const textsA1 = rows.map((r) => buildText(r, cap(r.description, DESCRIPTION_CHAR_LIMIT_A1)));

// B: prefix + LLM 14-field summary (production path when a summary exists).
const textsB = rows.map((r) => buildText(r, r.description_summary));

// Sanity: B built here must equal what production buildJobText() emits for a
// summarised row — otherwise the prefix replication has drifted from source.
const bMismatch = rows.findIndex((r) => buildText(r, r.description_summary) !== buildJobText(r));
if (bMismatch !== -1) {
  console.error(`WARN: buildText drifted from buildJobText at row ${bMismatch} — prefix logic out of sync with src/embeddings.mjs`);
}

// Token-length stats for reporting
const avgLen = (texts) => Math.round(mean(texts.map((t) => t.length / 4)));
console.log(`  A2 avg ~${avgLen(textsA2)} tok  A1 avg ~${avgLen(textsA1)} tok  B avg ~${avgLen(textsB)} tok`);

console.log('\nEmbedding resume...');
const [[resumeVec]] = await Promise.all([embedTexts([RESUME_TEXT])]);
console.log(`Resume embedded (${resumeVec.length} dims)`);

console.log('\nEmbedding all three job variants in parallel...');
const t0 = Date.now();
const [vecsA2, vecsA1, vecsB] = await Promise.all([
  embedTexts(textsA2),
  embedTexts(textsA1),
  embedTexts(textsB),
]);
console.log(`Embeddings done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// Cost estimate: text-embedding-3-small = $0.02 / 1M tokens
const totalTokens =
  textsA2.reduce((s, t) => s + t.length / 4, 0) +
  textsA1.reduce((s, t) => s + t.length / 4, 0) +
  textsB.reduce((s, t) => s + t.length / 4, 0) +
  RESUME_TEXT.length / 4;
const costUsd = (totalTokens / 1_000_000) * 0.02;

// Cosine similarities (dot product of unit vecs = cosine)
const simsA2 = vecsA2.map((v) => dot(resumeVec, v));
const simsA1 = vecsA1.map((v) => dot(resumeVec, v));
const simsB  = vecsB.map((v)  => dot(resumeVec, v));

// Compute metrics per strategy
const mA2 = metrics(simsA2, jobIds, 'A2 (truncated 1500c)', resumeVec);
const mA1 = metrics(simsA1, jobIds, 'A1 (full raw desc)', resumeVec);
const mB  = metrics(simsB,  jobIds, 'B  (LLM summary)', resumeVec);

// ── Report ───────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(72));
console.log('EMBEDDING A/B TEST RESULTS');
console.log(`Sample: ${rows.length} active jobs with both description + summary`);
console.log(`Cost: ~$${costUsd.toFixed(4)} (all 3 batches + resume)`);
console.log('═'.repeat(72));

console.log('\n── Similarity vs. resume (higher = better match signal) ──────────');
console.log(`${'Strategy'.padEnd(22)} ${'Top-10 mean'.padStart(12)} ${'Top-30 mean'.padStart(12)} ${'All mean'.padStart(10)} ${'Separation'.padStart(11)}`);
console.log('-'.repeat(72));
for (const m of [mA2, mA1, mB]) {
  console.log(
    `${m.label.padEnd(22)} ${fmt(m.top10mean).padStart(12)} ${fmt(m.top30mean).padStart(12)} ${fmt(m.allMean).padStart(10)} ${fmt(m.separation).padStart(11)}`,
  );
}

console.log('\n── Overlap@10 between strategies (1.0 = identical top-10) ────────');
console.log(`  A2 ∩ A1 = ${pct(overlap(mA2.top10ids, mA1.top10ids))}`);
console.log(`  A2 ∩ B  = ${pct(overlap(mA2.top10ids, mB.top10ids))}`);
console.log(`  A1 ∩ B  = ${pct(overlap(mA1.top10ids, mB.top10ids))}`);

console.log('\n── Spearman ρ (rank correlation over all 200 jobs) ────────────────');
console.log(`  A2 vs A1 = ${spearman(simsA2, simsA1).toFixed(4)}`);
console.log(`  A2 vs B  = ${spearman(simsA2, simsB).toFixed(4)}`);
console.log(`  A1 vs B  = ${spearman(simsA1, simsB).toFixed(4)}`);

console.log('\n── Top-10 matches per strategy ────────────────────────────────────');
for (const m of [mA2, mA1, mB]) {
  console.log(`\n  ${m.label}:`);
  m.top10list.forEach((r, i) => {
    const job = rows.find((j) => j.id === r.id);
    const title = (job?.title || r.id).slice(0, 55);
    console.log(`    ${String(i + 1).padStart(2)}. ${fmt(r.score)}  ${title}`);
  });
}

console.log('\n── Interpretation guide ────────────────────────────────────────────');
console.log('  Separation   > 0.05  strong discriminability');
console.log('  Overlap@10   > 0.7   strategies broadly agree on top jobs');
console.log('  Spearman ρ   > 0.85  strategies agree on the full ranking');
console.log('  If B separation >> A1 separation → summary worth the LLM cost');
console.log('  If A1 ≈ B → skip summarise pass; switch to full-desc embed instead');
console.log('═'.repeat(72) + '\n');
