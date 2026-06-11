#!/usr/bin/env node
/**
 * Reranker A/B — TEST ONLY. Writes nothing to Supabase, changes no
 * production code. Answers two questions the embedding experiments raised:
 *
 *   1. Does an LLM reranker beat cosine-only ordering?
 *   2. Does a BETTER reranker model (gpt-4.1) beat the cheap one (gpt-4o-mini)?
 *
 * Design (deliberately non-circular — the earlier harness graded gpt-4o-mini
 * rerank with a gpt-4o-mini judge, which is self-fulfilling):
 *
 *   Stage 1  retrieval : cosine over the whole-summary embedding (3-small),
 *                        exactly the production B path → top-POOL_TOPK pool.
 *   Rankers  reorder the pool:
 *     R0  cosine-only          (baseline ordering from stage 1)
 *     R1  gpt-4o-mini reranker (fit 0-100, reorder by score)
 *     R2  gpt-4.1     reranker (the "better model")
 *   Judge    INDEPENDENT ground truth: gpt-5.1 scores every pooled
 *            candidate 0-100. It is neither reranker, so it can referee
 *            both without grading its own work.
 *
 * Metrics per ranker, over its top-10 of the pool:
 *   meanFit@10   mean judge score of the 10 it surfaces (higher = better)
 *   NDCG@10      judge score as gain, vs the ideal ordering
 *   recall@10    fraction of the judge's own top-10 the ranker captures
 *   Spearman     full-pool rank correlation with the judge
 *
 * Caveat: gpt-5.1 is a strong but still-LLM proxy for "good match," and may
 * share blind spots with gpt-4.1 (same vendor). Only human judgements are
 * true ground truth — read this as strong directional evidence, not proof.
 *
 * Cost: ~$0.05-0.20 (gpt-5.1 judge on POOL_TOPK candidates dominates).
 *
 * Usage:  node --env-file=.env scripts/reranker-test.mjs
 *   env:  SAMPLE_SIZE (default 400), POOL_TOPK (default 30)
 */

import { selectAll } from '../src/supabase-client.mjs';
import { buildJobText } from '../src/embeddings.mjs';

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 400);
const POOL_TOPK = Number(process.env.POOL_TOPK || 30);
const MODEL_SMALL = 'text-embedding-3-small';
const EMBED_BATCH = 256;

const RERANK_CHEAP = 'gpt-4o-mini';
const RERANK_BETTER = 'gpt-4.1';
const JUDGE_MODEL = 'gpt-5.1';
const LLM_CONCURRENCY = 6;

// ── Resume (identical text to abembeddingtest.mjs / embed-resume.mjs) ─────────
const RESUME_TITLE = 'Senior Data Engineer / AI Engineer (GenAI · RAG · Healthcare IT)';
const RESUME_SIGNALS = [
  'Seniority: senior', 'Workplace: hybrid', 'Employment type: full-time',
  'Department: Data / AI Engineering', 'Location: Irving, Texas, United States',
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
  'Compensation: unknown', 'Benefits: unknown',
  'Visa: US work authorization', 'Schedule: full-time',
].join('\n');
const RESUME_TEXT = `${RESUME_TITLE}\n\n${RESUME_SIGNALS}\n\n${RESUME_SUMMARY}`;

// ── OpenAI helpers ────────────────────────────────────────────────────────────

async function embed(texts, model) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    out.push(...data.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

// gpt-5 / o-series are reasoning models: they reject `temperature` and use
// `max_completion_tokens` (and need headroom for hidden reasoning tokens).
const isReasoning = (m) => /^(gpt-5|o\d)/.test(m);

const FIT_SYSTEM = `You are an expert technical recruiter. Score how well a candidate's resume matches a job posting on a 0-100 scale, where 100 = ideal fit (required skills, seniority, and domain all align) and 0 = unrelated. Weigh required-skills overlap most, then seniority match, then domain. Reply with ONLY an integer 0-100 and nothing else.`;

async function fitScore(model, job) {
  const user = `RESUME:\n${RESUME_TEXT}\n\nJOB POSTING:\n${job.title || ''}\n${job.description_summary || ''}\n\nFit score (0-100):`;
  const body = { model, messages: [{ role: 'system', content: FIT_SYSTEM }, { role: 'user', content: user }] };
  if (isReasoning(model)) body.max_completion_tokens = 2000;
  else { body.temperature = 0; body.max_tokens = 8; }
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) { await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`chat ${model} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    const n = parseInt(raw.match(/\d+/)?.[0] ?? '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  return null;
}

async function mapPool(items, fn, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function mean(a) { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }
function dcg(g) { return g.reduce((s, x, i) => s + x / Math.log2(i + 2), 0); }
function ndcgAtK(rankedIds, relById, k) {
  const gains = rankedIds.slice(0, k).map((id) => relById.get(id) ?? 0);
  const ideal = [...relById.values()].sort((a, b) => b - a).slice(0, k);
  const idcg = dcg(ideal);
  return idcg === 0 ? 0 : dcg(gains) / idcg;
}
function spearman(a, b) {
  const n = a.length; if (n < 2) return 0;
  const rankOf = (arr) => { const idx = arr.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v); const r = new Array(n); idx.forEach(({ i }, k) => { r[i] = k + 1; }); return r; };
  const ra = rankOf(a), rb = rankOf(b); let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
const f = (n) => n.toFixed(4);

// ── Main ───────────────────────────────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) { console.error('OPENAI_API_KEY not set'); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error('SUPABASE_* not set'); process.exit(1); }

console.log(`Fetching ${SAMPLE_SIZE} active jobs with description_summary...`);
const rows = await selectAll('v_jobs_enriched', {
  closed_at: 'is.null', description: 'not.is.null', description_summary: 'not.is.null',
  select: ['id', 'title', 'department', 'location', 'description_summary', 'comp_min', 'comp_max', 'comp_currency', 'comp_interval', 'comp_text', 'remote', 'employment_type'].join(','),
  order: 'id.desc',
}, { pageSize: SAMPLE_SIZE, maxRows: SAMPLE_SIZE });
console.log(`Got ${rows.length} jobs.\n`);

// Stage 1: cosine retrieval (production B path).
console.log('Stage 1 — embedding + cosine retrieval (3-small whole summary)...');
const [resumeVec] = await embed([RESUME_TEXT], MODEL_SMALL);
const jobVecs = await embed(rows.map((r) => buildJobText(r)), MODEL_SMALL);
const cosById = new Map(rows.map((r, i) => [r.id, dot(resumeVec, jobVecs[i])]));
const pool = [...rows].sort((a, b) => cosById.get(b.id) - cosById.get(a.id)).slice(0, POOL_TOPK);
const byId = new Map(pool.map((r) => [r.id, r]));
console.log(`Pool = cosine top-${pool.length}.\n`);

// Rerankers + judge: score the SAME pool.
console.log(`Scoring pool with cheap reranker (${RERANK_CHEAP}), better reranker (${RERANK_BETTER}), judge (${JUDGE_MODEL})...`);
const t0 = Date.now();
const [cheapScores, betterScores, judgeScores] = await Promise.all([
  mapPool(pool, (j) => fitScore(RERANK_CHEAP, j), LLM_CONCURRENCY),
  mapPool(pool, (j) => fitScore(RERANK_BETTER, j), LLM_CONCURRENCY),
  mapPool(pool, (j) => fitScore(JUDGE_MODEL, j), LLM_CONCURRENCY),
]);
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(1)}s.\n`);

const relById = new Map(); pool.forEach((j, i) => { if (judgeScores[i] != null) relById.set(j.id, judgeScores[i]); });
const cheapById = new Map(pool.map((j, i) => [j.id, cheapScores[i] ?? -1]));
const betterById = new Map(pool.map((j, i) => [j.id, betterScores[i] ?? -1]));

const poolIds = pool.map((j) => j.id);
const judgeTop10 = [...relById.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id);
const judgeTop10Set = new Set(judgeTop10);

function evalRanker(label, orderIds, scoreOverPool) {
  const top10 = orderIds.slice(0, 10);
  const meanFit10 = mean(top10.map((id) => relById.get(id)));
  const ndcg = ndcgAtK(orderIds, relById, 10);
  const recall = top10.filter((id) => judgeTop10Set.has(id)).length / Math.min(10, judgeTop10.length);
  const rho = spearman(poolIds.map((id) => scoreOverPool.get(id)), poolIds.map((id) => relById.get(id) ?? 0));
  return { label, meanFit10, ndcg, recall, rho, top10 };
}

const rankCosine = [...poolIds].sort((a, b) => cosById.get(b) - cosById.get(a));
const rankCheap = [...poolIds].sort((a, b) => cheapById.get(b) - cheapById.get(a));
const rankBetter = [...poolIds].sort((a, b) => betterById.get(b) - betterById.get(a));

const R0 = evalRanker('R0  cosine only', rankCosine, cosById);
const R1 = evalRanker(`R1  ${RERANK_CHEAP}`, rankCheap, cheapById);
const R2 = evalRanker(`R2  ${RERANK_BETTER}`, rankBetter, betterById);

// ── Report ───────────────────────────────────────────────────────────────────
console.log('═'.repeat(76));
console.log('RERANKER A/B  (independent judge: ' + JUDGE_MODEL + ')');
console.log(`Sample ${rows.length} · pool ${pool.length} · judged ${relById.size}`);
console.log('═'.repeat(76));

console.log('\n── Ranking quality vs independent judge (higher = better) ──────────────────');
console.log(`${'Ranker'.padEnd(20)} ${'meanFit@10'.padStart(11)} ${'NDCG@10'.padStart(9)} ${'recall@10'.padStart(10)} ${'Spearman'.padStart(9)}`);
console.log('-'.repeat(76));
for (const r of [R0, R1, R2]) {
  console.log(`${r.label.padEnd(20)} ${r.meanFit10.toFixed(1).padStart(11)} ${f(r.ndcg).padStart(9)} ${(r.recall * 100).toFixed(0).padStart(9)}% ${f(r.rho).padStart(9)}`);
}

console.log('\n── Deltas ───────────────────────────────────────────────────────────────────');
console.log(`  rerank lift (R1 − R0):  meanFit@10 ${(R1.meanFit10 - R0.meanFit10 >= 0 ? '+' : '')}${(R1.meanFit10 - R0.meanFit10).toFixed(1)}   NDCG ${(R1.ndcg - R0.ndcg >= 0 ? '+' : '')}${(R1.ndcg - R0.ndcg).toFixed(4)}`);
console.log(`  better model (R2 − R1): meanFit@10 ${(R2.meanFit10 - R1.meanFit10 >= 0 ? '+' : '')}${(R2.meanFit10 - R1.meanFit10).toFixed(1)}   NDCG ${(R2.ndcg - R1.ndcg >= 0 ? '+' : '')}${(R2.ndcg - R1.ndcg).toFixed(4)}`);

console.log('\n── Top-10 per ranker (number = independent judge fit) ──────────────────────');
const colTitle = (id) => (byId.get(id)?.title || id).slice(0, 30).padEnd(30);
console.log(`${'#'.padStart(2)}  ${'R0 cosine'.padEnd(36)} ${'R1 ' + RERANK_CHEAP.padEnd(33)} R2 ${RERANK_BETTER}`);
for (let i = 0; i < 10; i++) {
  const a = R0.top10[i], b = R1.top10[i], c = R2.top10[i];
  const cell = (id) => id ? `${String(relById.get(id) ?? '--').padStart(3)} ${colTitle(id)}` : ''.padEnd(34);
  console.log(`${String(i + 1).padStart(2)}  ${cell(a)} ${cell(b)} ${cell(c)}`);
}

console.log('\n── Read ────────────────────────────────────────────────────────────────────');
console.log('  • R1/R2 meanFit@10 > R0 → reranking surfaces better matches than cosine.');
console.log('  • R2 > R1 → the stronger reranker model is worth its extra cost.');
console.log('  • recall@10 = how much of the judge\'s ideal top-10 each ranker recovers.');
console.log('  • Judge is gpt-5.1 (independent of both rerankers) but still an LLM proxy.');
console.log('═'.repeat(76) + '\n');
