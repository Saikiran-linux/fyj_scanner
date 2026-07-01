#!/usr/bin/env node
/**
 * Embedding-strategy experiments — TEST ONLY, writes nothing to Supabase
 * and changes nothing in the production embedding path (src/embeddings.mjs).
 *
 * Extends scripts/abembeddingtest.mjs (which compared truncated-desc /
 * full-desc / summary, all on text-embedding-3-small, one vector per job).
 * Here we test three ideas raised as possible accuracy levers:
 *
 *   B   baseline   whole 14-field summary, ONE vector, 3-small
 *                  (reproduced from abembeddingtest so everything is
 *                   apples-to-apples against it)
 *   C   field-chunk  summary split into its 14 labelled fields, each
 *                    embedded separately on BOTH the job and the resume,
 *                    scored by label-aligned per-field cosine (weighted).
 *                    3-small. Two aggregations reported: weighted + mean.
 *   L   3-large    whole summary, ONE vector, text-embedding-3-large
 *
 *   R   reranker   gpt-4o-mini scores each candidate's resume↔job fit
 *                  0-100. Used two ways:
 *                    1. as a RERANKER — reorder a candidate pool by fit
 *                    2. as the JUDGE — treat its 0-100 score as pseudo
 *                       ground truth and measure how well each embedding
 *                       strategy's ranking agrees with it (NDCG@10 +
 *                       Spearman). This is how we get an *objective*
 *                       comparison without hand-labelled data.
 *
 * Why LLM-as-judge: the original harness reports separation / overlap /
 * rank-correlation because there are no relevance labels. Those say how
 * strategies differ from each other, not which is *right*. An LLM fit
 * score is an imperfect but reasonable stand-in for "would a recruiter
 * call this a good match" — good enough to rank the strategies by.
 * Caveat: it is a proxy, not truth; read NDCG/Spearman as directional.
 *
 * Cost: ~$0.05-0.10 (3-large batch dominates; ~50 gpt-4o-mini rerank calls).
 *
 * Usage:  node --env-file=.env scripts/embedding-experiments.mjs
 *   env:  SAMPLE_SIZE (default 200), POOL_TOPK (default 25)
 */

import { selectAll } from '../src/supabase-client.mjs';
import {
  buildJobText,
  extractSeniorityFromTitle,
  formatCompForEmbedding,
} from '../src/embeddings.mjs';

// ── Config ──────────────────────────────────────────────────────────────────

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 200);
// Pool for the LLM judge = union of each strategy's top-K. Keeps the number
// of gpt-4o-mini calls (and cost) bounded while covering every strategy's
// best picks so the judge sees what each one would actually surface.
const POOL_TOPK = Number(process.env.POOL_TOPK || 25);

const MODEL_SMALL = 'text-embedding-3-small';
const MODEL_LARGE = 'text-embedding-3-large';
const RERANK_MODEL = 'gpt-4o-mini';

// OpenAI embeddings: up to 2048 inputs / 300k tokens per request. 256 keeps
// each request small and bounds the blast radius of a single failure.
const EMBED_BATCH = 256;
const RERANK_CONCURRENCY = 5;

// Per-field weights for the field-chunk aggregation (C-weighted). Skills and
// role are the discriminative fields for job↔resume fit; benefits/visa/
// schedule/compensation are mostly "unknown" noise and get the floor weight.
// Keyed by lowercased field label.
const FIELD_WEIGHTS = {
  'required skills': 3,
  'role': 2,
  'preferred skills': 1.5,
  'team': 1,
  'industry': 1,
  'level': 1,
  'experience': 0.5,
};
const DEFAULT_FIELD_WEIGHT = 0.5;

// ── Resume (identical text to abembeddingtest.mjs / embed-resume.mjs) ─────────

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

// ── Text construction (mirrors buildJobText prefix; see abembeddingtest) ──────

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

function buildText(job, body) {
  const parts = buildPrefix(job);
  if (body) parts.push(body);
  return parts.join('\n\n');
}

// Parse `Label: value` summary lines into a Map<lowercased label, value>.
// Skips lines whose value is empty or "unknown" — an unknown field carries
// no signal and would only add a misleading near-zero cosine to the average.
function parseFields(summary) {
  const out = new Map();
  if (!summary) return out;
  for (const line of summary.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]+?):\s*(.+?)\s*$/);
    if (!m) continue;
    const label = m[1].toLowerCase().trim();
    const value = m[2].trim();
    if (!value || /^unknown$/i.test(value)) continue;
    out.set(label, `${m[1].trim()}: ${value}`); // keep label in embedded text
  }
  return out;
}

// ── OpenAI helpers (model-parameterised; production embedTexts is hardcoded
//    to 3-small, so we can't reuse it for the 3-large arm) ────────────────────

async function embed(texts, model) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) throw new Error(`OpenAI embeddings ${res.status} (${model}): ${(await res.text()).slice(0, 300)}`);
    const data = await res.json();
    out.push(...data.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

const RERANK_SYSTEM = `You are an expert technical recruiter. Score how well a candidate's resume matches a job posting on a 0-100 scale, where 100 = ideal fit (required skills, seniority, and domain all align) and 0 = unrelated. Weigh required-skills overlap most, then seniority match, then domain. Reply with ONLY an integer 0-100 and nothing else.`;

async function fitScore(job) {
  const user = `RESUME:\n${RESUME_TEXT}\n\nJOB POSTING:\n${job.title || ''}\n${job.description_summary || ''}\n\nFit score (0-100):`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: RERANK_MODEL,
      temperature: 0,
      max_tokens: 6,
      messages: [
        { role: 'system', content: RERANK_SYSTEM },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI chat ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  const n = parseInt(raw.match(/\d+/)?.[0] ?? '', 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}

// Run an async fn over items with bounded concurrency, preserving order.
async function mapPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Metric helpers ────────────────────────────────────────────────────────────

function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0; }
function fmt(n) { return n.toFixed(4); }
function pct(n) { return (n * 100).toFixed(1) + '%'; }

function spearman(a, b) {
  const n = a.length;
  if (n < 2) return 0;
  const rankOf = (arr) => {
    const idx = arr.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v);
    const r = new Array(n);
    idx.forEach(({ i }, rank) => { r[i] = rank + 1; });
    return r;
  };
  const ra = rankOf(a); const rb = rankOf(b);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}

// Rank-based metrics for one strategy: sims aligned to jobIds.
function rankMetrics(sims, jobIds, label) {
  const ranked = jobIds.map((id, i) => ({ id, score: sims[i] })).sort((a, b) => b.score - a.score);
  const top10 = ranked.slice(0, 10);
  const allMean = mean(sims);
  const top10mean = mean(top10.map((r) => r.score));
  return {
    label,
    sims,
    top10ids: new Set(top10.map((r) => r.id)),
    top10mean,
    top30mean: mean(ranked.slice(0, 30).map((r) => r.score)),
    allMean,
    separation: top10mean - allMean,
    topK: ranked.slice(0, POOL_TOPK).map((r) => r.id),
    top10list: top10,
  };
}

function overlap10(a, b) { let c = 0; for (const id of a) if (b.has(id)) c++; return c / 10; }

function dcg(gains) { return gains.reduce((s, g, i) => s + g / Math.log2(i + 2), 0); }
function ndcgAtK(rankedIds, relById, k) {
  const gains = rankedIds.slice(0, k).map((id) => relById.get(id) ?? 0);
  const ideal = [...relById.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(gains) / idcg;
}

// ── Main ─────────────────────────────────────────────────────────────────────

if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY is not set'); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set'); process.exit(1);
}

console.log(`Fetching ${SAMPLE_SIZE} active jobs with both description and summary...`);
const rows = await selectAll('v_jobs_enriched', {
  closed_at: 'is.null',
  description: 'not.is.null',
  description_summary: 'not.is.null',
  select: [
    'id', 'title', 'department', 'location', 'description_summary',
    'comp_min', 'comp_max', 'comp_currency', 'comp_interval', 'comp_text',
    'remote', 'employment_type',
  ].join(','),
  order: 'id.desc',
}, { pageSize: SAMPLE_SIZE, maxRows: SAMPLE_SIZE });

if (rows.length < 10) {
  console.error(`Only ${rows.length} rows returned — not enough to evaluate.`);
  process.exit(1);
}
console.log(`Got ${rows.length} jobs.\n`);

const jobIds = rows.map((r) => r.id);
const byId = new Map(rows.map((r) => [r.id, r]));

// ── Build texts ───────────────────────────────────────────────────────────────
// B / L: whole summary, one vector (exactly buildJobText's output for a
// summarised row). C: per-field texts for every job + the resume.

const wholeTexts = rows.map((r) => buildJobText(r));

const resumeFields = parseFields(RESUME_SUMMARY);
const resumeFieldLabels = [...resumeFields.keys()];

// Flatten all job field-values into one array for a single batched embed,
// remembering which (jobIndex,label) each vector belongs to.
const jobFieldList = rows.map((r) => parseFields(r.description_summary));
const fieldTexts = [];
const fieldIndex = []; // { job, label }
jobFieldList.forEach((fields, j) => {
  for (const [label, text] of fields) { fieldTexts.push(text); fieldIndex.push({ job: j, label }); }
});

console.log('Embedding (this fires several OpenAI batches in parallel)...');
const t0 = Date.now();
const [
  resumeSmall, resumeLarge, resumeFieldVecs,
  vecsB, vecsL, jobFieldVecsFlat,
] = await Promise.all([
  embed([RESUME_TEXT], MODEL_SMALL).then((v) => v[0]),
  embed([RESUME_TEXT], MODEL_LARGE).then((v) => v[0]),
  embed(resumeFieldLabels.map((l) => resumeFields.get(l)), MODEL_SMALL),
  embed(wholeTexts, MODEL_SMALL),
  embed(wholeTexts, MODEL_LARGE),
  embed(fieldTexts, MODEL_SMALL),
]);
console.log(`Embeddings done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  whole-summary vectors: ${rows.length} (×2 models)   job field vectors: ${jobFieldVecsFlat.length}\n`);

const resumeFieldVecByLabel = new Map(resumeFieldLabels.map((l, i) => [l, resumeFieldVecs[i]]));

// Reassemble job field vectors into per-job Map<label, vec>.
const jobFieldVecs = rows.map(() => new Map());
fieldIndex.forEach(({ job, label }, i) => { jobFieldVecs[job].set(label, jobFieldVecsFlat[i]); });

// ── Scores ─────────────────────────────────────────────────────────────────────

const simsB = vecsB.map((v) => dot(resumeSmall, v));
const simsL = vecsL.map((v) => dot(resumeLarge, v));

// C: label-aligned per-field cosine, aggregated two ways.
function fieldChunkScore(jIdx, weighted) {
  const jf = jobFieldVecs[jIdx];
  let num = 0, den = 0;
  for (const label of resumeFieldLabels) {
    const jv = jf.get(label);
    if (!jv) continue; // field absent/unknown on the job side
    const cos = dot(resumeFieldVecByLabel.get(label), jv);
    const w = weighted ? (FIELD_WEIGHTS[label] ?? DEFAULT_FIELD_WEIGHT) : 1;
    num += w * cos; den += w;
  }
  return den ? num / den : 0;
}
const simsCw = rows.map((_, j) => fieldChunkScore(j, true));
const simsCm = rows.map((_, j) => fieldChunkScore(j, false));

const mB = rankMetrics(simsB, jobIds, 'B  whole summary (3-small)');
const mL = rankMetrics(simsL, jobIds, 'L  whole summary (3-large)');
const mCw = rankMetrics(simsCw, jobIds, 'C  field-chunk weighted (3-small)');
const mCm = rankMetrics(simsCm, jobIds, 'C  field-chunk mean (3-small)');
const strategies = [mB, mL, mCw, mCm];

// ── Reranker / LLM judge ───────────────────────────────────────────────────────

const pool = [...new Set(strategies.flatMap((m) => m.topK))];
console.log(`LLM judge: scoring ${pool.length} pooled candidates (union of each strategy's top-${POOL_TOPK}) with ${RERANK_MODEL}...`);
const tj = Date.now();
const judged = await mapPool(pool, (id) => fitScore(byId.get(id)), RERANK_CONCURRENCY);
const relById = new Map();
pool.forEach((id, i) => { if (judged[i] != null) relById.set(id, judged[i]); });
console.log(`Judged ${relById.size}/${pool.length} in ${((Date.now() - tj) / 1000).toFixed(1)}s (${pool.length - relById.size} unparseable)\n`);

// For each strategy, rank the POOL by its sim and score agreement vs the judge.
const simByIdFor = (sims) => new Map(jobIds.map((id, i) => [id, sims[i]]));
function judgeAgreement(m, sims) {
  const sById = simByIdFor(sims);
  const poolRel = pool.filter((id) => relById.has(id));
  const rankedByStrategy = [...poolRel].sort((a, b) => sById.get(b) - sById.get(a));
  const ndcg = ndcgAtK(rankedByStrategy, relById, 10);
  const a = poolRel.map((id) => sById.get(id));
  const b = poolRel.map((id) => relById.get(id));
  return { ndcg, rho: spearman(a, b) };
}
const agree = {
  B: judgeAgreement(mB, simsB),
  L: judgeAgreement(mL, simsL),
  Cw: judgeAgreement(mCw, simsCw),
  Cm: judgeAgreement(mCm, simsCm),
};

// ── Report ───────────────────────────────────────────────────────────────────

console.log('═'.repeat(74));
console.log('EMBEDDING-STRATEGY EXPERIMENTS');
console.log(`Sample: ${rows.length} active jobs · judge pool: ${relById.size} candidates`);
console.log('═'.repeat(74));

console.log('\n── Cosine vs resume (within-model; cross-model magnitudes NOT comparable) ──');
console.log(`${'Strategy'.padEnd(34)} ${'Top-10'.padStart(8)} ${'Top-30'.padStart(8)} ${'AllMean'.padStart(8)} ${'Separation'.padStart(11)}`);
console.log('-'.repeat(74));
for (const m of strategies) {
  console.log(`${m.label.padEnd(34)} ${fmt(m.top10mean).padStart(8)} ${fmt(m.top30mean).padStart(8)} ${fmt(m.allMean).padStart(8)} ${fmt(m.separation).padStart(11)}`);
}
console.log('  Separation is model-relative (top10 − allMean), so it IS comparable across models.');

console.log('\n── Ranking agreement with B (baseline) ────────────────────────────────────');
for (const m of [mL, mCw, mCm]) {
  console.log(`  ${m.label.padEnd(34)} overlap@10 ${pct(overlap10(mB.top10ids, m.top10ids)).padStart(6)}   Spearman ${spearman(mB.sims, m.sims).toFixed(4)}`);
}

console.log('\n── Agreement with LLM judge (objective-ish: higher = ranks fit better) ─────');
console.log(`${'Strategy'.padEnd(34)} ${'NDCG@10'.padStart(9)} ${'Spearman'.padStart(10)}`);
console.log('-'.repeat(74));
const agreeRows = [['B  whole summary (3-small)', agree.B], ['L  whole summary (3-large)', agree.L], ['C  field-chunk weighted (3-small)', agree.Cw], ['C  field-chunk mean (3-small)', agree.Cm]];
for (const [label, a] of agreeRows) {
  console.log(`${label.padEnd(34)} ${a.ndcg.toFixed(4).padStart(9)} ${a.rho.toFixed(4).padStart(10)}`);
}

// Reranker illustration: B's cosine top-10 vs the judge's top-10 over the pool.
const judgeTop10 = [...relById.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
console.log('\n── Reranker effect: LLM-judged top-10 (over the pool) ──────────────────────');
judgeTop10.forEach(([id, score], i) => {
  const inB = mB.top10ids.has(id) ? ' ' : '＋'; // ＋ = surfaced by rerank, not in B's cosine top-10
  console.log(`  ${String(i + 1).padStart(2)}. ${inB} fit ${String(score).padStart(3)}  ${(byId.get(id)?.title || id).slice(0, 52)}`);
});
console.log('     ＋ = pulled into top-10 by the reranker but NOT in B\'s cosine top-10');

console.log('\n── B (baseline) cosine top-10 for reference ────────────────────────────────');
mB.top10list.forEach((r, i) => {
  const j = byId.get(r.id);
  console.log(`  ${String(i + 1).padStart(2)}.   ${fmt(r.score)}  fit ${String(relById.get(r.id) ?? '--').padStart(3)}  ${(j?.title || r.id).slice(0, 48)}`);
});

console.log('\n── How to read this ────────────────────────────────────────────────────────');
console.log('  • Best NDCG@10 / Spearman vs judge → embedding that best approximates fit.');
console.log('  • If L ≈ B on judge agreement → 3-large not worth 6.5× the embed cost.');
console.log('  • If C-weighted > B on judge agreement → field chunking earns its complexity.');
console.log('  • Many ＋ rows above → a reranker adds a lot the embeddings alone miss.');
console.log('  • Judge is an LLM proxy, not ground truth — read as directional, not final.');
console.log('═'.repeat(74) + '\n');
