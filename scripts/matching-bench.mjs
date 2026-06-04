#!/usr/bin/env node
/**
 * matching-bench.mjs — DEEP, unbiased bake-off of JD↔resume matching methods.
 * TEST ONLY: writes nothing to Supabase, changes no production code path.
 *
 * Goal: find the best matching method across the WHOLE design space (not just
 * the variants we've already tried), and quantify how much better it is than
 * (a) the current production path and (b) the proposed reranker sketch.
 *
 * ── Validity controls ───────────────────────────────────────────────────────
 *  • Generalisation: evaluated over 3 DIVERSE resumes (Data/AI, Frontend,
 *    DevOps/SRE), metrics averaged across them.
 *  • No self-grading: the relevance ORACLE is an ensemble of two strong judges
 *    (gpt-5.1 + gpt-5.2), both stronger than and distinct from every reranker
 *    model under test (gpt-4o-mini / gpt-4.1). Inter-judge agreement reported.
 *  • No pool bias: each resume's candidate pool is the UNION of top-K from four
 *    different retrievers, so no method gets a home-field recall advantage.
 *    Every method then RANKS this identical fixed pool — apples-to-apples.
 *  • LLM-reranker caveat: a cross-encoder graded by an LLM oracle is favoured
 *    by construction. So we crown TWO winners: best overall, and best
 *    retrieval-only method (the cheap, no-LLM-at-query-time path).
 *
 * ── Methods under test (each ranks the fixed pool) ──────────────────────────
 *  Retrieval-only (no LLM at query time):
 *    PROD      dense cosine · summary · 3-small      ← current production
 *    LARGE     dense cosine · summary · 3-large
 *    FIELD     field-level summary chunking (weighted, late-interaction)
 *    LEXICAL   skill-keyword overlap (BM25-ish)
 *    HYBRID    RRF(PROD, LEXICAL)                    ← dense+lexical fusion
 *    FEATURE   weighted(cosine, skill-overlap, seniority) fusion
 *    HYDE      embed an LLM "ideal candidate" generated from the JD, match
 *  Two-stage (LLM rerank of the pool):
 *    RR-mini   pointwise fit · gpt-4o-mini
 *    RR-4.1    pointwise fit · gpt-4.1               ← the reranker SKETCH
 *    LISTWISE  listwise ranking · gpt-4.1
 *
 * Usage: node --env-file=.env scripts/matching-bench.mjs
 *   env: SAMPLE_SIZE (1000), POOL_PER_METHOD (15), JUDGES, CONCURRENCY
 */

import { selectAll } from '../src/supabase-client.mjs';
import { buildJobText, extractSeniorityFromTitle, formatCompForEmbedding } from '../src/embeddings.mjs';
import { writeFileSync } from 'node:fs';

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 1000);
const POOL_PER_METHOD = Number(process.env.POOL_PER_METHOD || 15);
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);
const EMBED_BATCH = 256;
const SMALL = 'text-embedding-3-small';
const LARGE = 'text-embedding-3-large';
const JUDGE_MODELS = (process.env.JUDGES || 'gpt-5.1,gpt-5.2').split(',');
const RERANK_MINI = 'gpt-4o-mini';
const RERANK_BIG = 'gpt-4.1';
const HYDE_MODEL = 'gpt-4o-mini';

const FIELD_WEIGHTS = { 'required skills': 3, role: 2, 'preferred skills': 1.5, team: 1, industry: 1, level: 1, experience: 0.5 };
const DEFAULT_FIELD_WEIGHT = 0.5;
const SENIORITY_ORDER = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'director', 'vp'];

// ── Resumes (1 real + 2 synthetic, all in the 14-field summary format) ───────
const RESUMES = [
  {
    id: 'data-ai',
    title: 'Senior Data Engineer / AI Engineer (GenAI · RAG · Healthcare IT)',
    level: 'senior',
    signals: ['Seniority: senior', 'Workplace: hybrid', 'Employment type: full-time', 'Department: Data / AI Engineering', 'Location: Irving, Texas, United States'].join('\n'),
    summary: [
      'Role: Design AI-augmented data pipelines and RAG-based GenAI workflows over healthcare and financial datasets, integrating LLMs with cloud-native ETL on AWS.',
      'Level: senior (IC track)', 'Experience: 4+ years',
      'Required skills: Python, SQL, PySpark, Apache Spark, AWS (S3, Lambda, Bedrock, SageMaker, Step Functions, Redshift, CloudWatch), Snowflake, Databricks, Apache Airflow, dbt, ETL, data warehousing, RAG, LangChain, LangGraph, LlamaIndex, vector databases (FAISS, OpenSearch), LLM integration (GPT-4, Claude, Gemini), prompt engineering, TensorFlow, PyTorch, scikit-learn, MLflow, Docker, MLOps, NLP, Hugging Face transformers, Tableau, Power BI',
      'Preferred skills: GCP (BigQuery, Vertex AI), Azure (Synapse, Data Factory), agentic AI (CrewAI, AutoGen), Explainable AI, time-series forecasting, Jenkins, MEDITECH Expanse EHR, healthcare interoperability, FastAPI, Streamlit, Looker, Fivetran',
      'Team: data engineering / AI engineering / applied ML', 'Industry: healthcare IT, AI/ML, GenAI, fintech, enterprise data analytics',
      'Company stage: any', 'Location: Irving, Texas, United States', 'Remote policy: remote or hybrid, US-based',
      'Compensation: unknown', 'Benefits: unknown', 'Visa: US work authorization', 'Schedule: full-time',
    ].join('\n'),
  },
  {
    id: 'frontend',
    title: 'Senior Frontend Engineer (React · TypeScript · Design Systems)',
    level: 'senior',
    signals: ['Seniority: senior', 'Workplace: remote', 'Employment type: full-time', 'Department: Frontend / Web Platform', 'Location: Remote, United States'].join('\n'),
    summary: [
      'Role: Build accessible, high-performance web UIs and design systems for B2B SaaS using React and TypeScript.',
      'Level: senior (IC track)', 'Experience: 6+ years',
      'Required skills: JavaScript, TypeScript, React, Next.js, Redux, React Query, HTML5, CSS3, Tailwind CSS, Sass, Webpack, Vite, Jest, React Testing Library, Cypress, Playwright, GraphQL, REST, Storybook, design systems, web accessibility, WCAG, Core Web Vitals, performance optimization, responsive design, Figma',
      'Preferred skills: Node.js, Remix, SvelteKit, Vue, WebGL, Three.js, micro-frontends, Module Federation, PWA, i18n, A/B testing, Sentry, CI/CD, Vercel',
      'Team: frontend / web platform / design systems engineering', 'Industry: B2B SaaS, dev tools, e-commerce, fintech',
      'Company stage: scale-up or growth-stage', 'Location: Remote, United States', 'Remote policy: remote, US-based',
      'Compensation: unknown', 'Benefits: unknown', 'Visa: US citizen', 'Schedule: full-time',
    ].join('\n'),
  },
  {
    id: 'devops',
    title: 'Senior DevOps / Platform / SRE Engineer (Kubernetes · Terraform · AWS)',
    level: 'senior',
    signals: ['Seniority: senior', 'Workplace: remote', 'Employment type: full-time', 'Department: Platform / Infrastructure', 'Location: Remote, United States'].join('\n'),
    summary: [
      'Role: Operate and automate cloud infrastructure and CI/CD, run Kubernetes platforms, and own reliability and observability for production services.',
      'Level: senior (IC track)', 'Experience: 7+ years',
      'Required skills: Kubernetes, Docker, Terraform, AWS (EKS, EC2, S3, IAM, VPC, RDS, Lambda, CloudWatch), Linux, Bash, Python, Go, CI/CD, GitHub Actions, ArgoCD, Helm, Prometheus, Grafana, Datadog, observability, SRE, incident response, on-call, IaC, networking, Nginx, PostgreSQL, Redis',
      'Preferred skills: GCP, Azure, Ansible, Pulumi, Istio, service mesh, Kafka, Vault, SOC2, FinOps, ELK, OpenTelemetry, Jenkins, Cloudflare',
      'Team: platform / infrastructure / SRE / DevOps', 'Industry: SaaS, cloud infrastructure, fintech, security',
      'Company stage: any', 'Location: Remote, United States', 'Remote policy: remote, US-based',
      'Compensation: unknown', 'Benefits: unknown', 'Visa: US work authorization', 'Schedule: full-time',
    ].join('\n'),
  },
];
const resumeText = (r) => `${r.title}\n\n${r.signals}\n\n${r.summary}`;

// ── Parsing helpers ───────────────────────────────────────────────────────────
function parseFields(summary) {
  const out = new Map();
  if (!summary) return out;
  for (const line of summary.split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]+?):\s*(.+?)\s*$/);
    if (!m) continue;
    const label = m[1].toLowerCase().trim();
    const value = m[2].trim();
    if (!value || /^unknown$/i.test(value)) continue;
    out.set(label, `${m[1].trim()}: ${value}`);
  }
  return out;
}
function parseSkills(summary) {
  const all = new Set();
  if (!summary) return all;
  for (const line of summary.split('\n')) {
    const m = line.match(/^\s*(Required skills|Preferred skills|Role|Team|Industry):\s*(.+)$/i);
    if (!m) continue;
    for (let tok of m[2].split(/[,()/]/)) {
      tok = tok.toLowerCase().replace(/[^a-z0-9+#.\- ]/g, '').trim();
      if (tok.length >= 2 && !/^(and|the|or|etc|unknown)$/.test(tok)) all.add(tok);
    }
  }
  return all;
}
function seniorityMatch(resumeLevel, jobTitle) {
  const js = extractSeniorityFromTitle(jobTitle);
  if (!js) return 0.5;
  const a = SENIORITY_ORDER.indexOf(resumeLevel), b = SENIORITY_ORDER.indexOf(js);
  if (a < 0 || b < 0) return 0.5;
  return 1 - Math.abs(a - b) / (SENIORITY_ORDER.length - 1);
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function embed(texts, model) {
  const out = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    let attempt = 0;
    for (;;) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: batch }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { attempt++; await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt)); continue; }
      if (!res.ok) throw new Error(`embeddings ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      out.push(...data.data.slice().sort((a, b) => a.index - b.index).map((d) => d.embedding));
      break;
    }
  }
  return out;
}
const isReasoning = (m) => /^(gpt-5|o\d)/.test(m);
async function chat(model, system, user, maxTok) {
  const body = { model, messages: [] };
  if (system) body.messages.push({ role: 'system', content: system });
  body.messages.push({ role: 'user', content: user });
  if (isReasoning(model)) body.max_completion_tokens = maxTok;
  else { body.temperature = 0; body.max_tokens = maxTok; }
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 1200 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`chat ${model} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }
  return '';
}
const FIT_SYSTEM = `You are a meticulous senior technical recruiter. Score how well a candidate's resume matches a job posting on a 0-100 scale: 100 = ideal hire you would fast-track, 0 = unrelated. Weigh required-skills overlap most, then seniority alignment, then domain/role relevance. Ignore location and compensation. Reply with ONLY an integer 0-100.`;
async function fitScore(model, resume, job) {
  const user = `RESUME:\n${resumeText(resume)}\n\nJOB POSTING:\n${job.title || ''}\n${job.description_summary || ''}\n\nFit score (0-100):`;
  const raw = await chat(model, FIT_SYSTEM, user, isReasoning(model) ? 2000 : 8);
  const n = parseInt(raw.match(/\d+/)?.[0] ?? '', 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}
async function mapPool(items, fn, conc) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; } }
  }));
  return out;
}

// ── Metrics ───────────────────────────────────────────────────────────────────
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const mean = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
const dcg = (g) => g.reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
function ndcg(rankedIds, rel, k) {
  const gains = rankedIds.slice(0, k).map((id) => rel.get(id) ?? 0);
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, k);
  return dcg(ideal) === 0 ? 0 : dcg(gains) / dcg(ideal);
}
function spearman(a, b) {
  const n = a.length; if (n < 2) return 0;
  const rk = (arr) => { const idx = arr.map((v, i) => ({ v, i })).sort((x, y) => y.v - x.v); const r = new Array(n); idx.forEach(({ i }, p) => { r[i] = p + 1; }); return r; };
  const ra = rk(a), rb = rk(b); let d2 = 0; for (let i = 0; i < n; i++) d2 += (ra[i] - rb[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
const minmax = (vals) => { const lo = Math.min(...vals), hi = Math.max(...vals); const d = hi - lo || 1; return (x) => (x - lo) / d; };
const rankMap = (ids, scoreById) => { const o = [...ids].sort((a, b) => scoreById.get(b) - scoreById.get(a)); const m = new Map(); o.forEach((id, i) => m.set(id, i + 1)); return m; };

// ── Main ───────────────────────────────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Need OPENAI_API_KEY + SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY'); process.exit(1);
}
console.log(`Fetching ${SAMPLE_SIZE} active jobs...`);
const rows = await selectAll('jobs', {
  closed_at: 'is.null', description: 'not.is.null', description_summary: 'not.is.null',
  select: ['id', 'title', 'department', 'location', 'description', 'description_summary', 'comp_min', 'comp_max', 'comp_currency', 'comp_interval', 'comp_text', 'remote', 'employment_type'].join(','),
  order: 'id.desc',
}, { pageSize: 1000, maxRows: SAMPLE_SIZE });
console.log(`Got ${rows.length} jobs.\n`);

const corpus = rows.map((r) => ({ row: r, id: r.id, skills: parseSkills(r.description_summary), fields: parseFields(r.description_summary) }));
const idIndex = new Map(corpus.map((c, i) => [c.id, i]));

// Corpus embeddings (shared across resumes): summary-small, fulldesc-small, field-small.
console.log('Embedding corpus (summary, full-desc, fields — 3-small)...');
const t0 = Date.now();
const summarySmall = await embed(corpus.map((c) => buildJobText(c.row)), SMALL);
const fullDescSmall = await embed(corpus.map((c) => {
  const p = [c.row.title || ''];
  if (c.row.description) p.push(c.row.description.slice(0, 1500));
  return p.join('\n\n');
}), SMALL);
// Flatten corpus fields for one batched embed.
const fieldTexts = []; const fieldRef = [];
corpus.forEach((c, j) => { for (const [label, text] of c.fields) { fieldTexts.push(text); fieldRef.push({ j, label }); } });
const fieldVecsFlat = await embed(fieldTexts, SMALL);
const corpusFieldVecs = corpus.map(() => new Map());
fieldRef.forEach(({ j, label }, i) => corpusFieldVecs[j].set(label, fieldVecsFlat[i]));
console.log(`  corpus embeds done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// Resume embeddings.
const resumeSmall = await embed(RESUMES.map(resumeText), SMALL);
const resumeLarge = await embed(RESUMES.map(resumeText), LARGE);
const resumeFieldData = RESUMES.map((r) => parseFields(r.summary));
const resumeFieldVecsFlat = await embed(resumeFieldData.flatMap((f) => [...f.values()]), SMALL);
const resumeFieldVecs = RESUMES.map(() => new Map());
{ let p = 0; resumeFieldData.forEach((f, ri) => { for (const label of f.keys()) resumeFieldVecs[ri].set(label, resumeFieldVecsFlat[p++]); }); }
const resumeSkills = RESUMES.map((r) => parseSkills(r.summary));

// ── Build per-resume pool = union of top-K from PROD, FULLDESC, LEXICAL, FIELD ─
function fieldChunk(ri, ci) {
  let num = 0, den = 0;
  for (const [label, rvec] of resumeFieldVecs[ri]) {
    const jv = corpusFieldVecs[ci].get(label); if (!jv) continue;
    const w = FIELD_WEIGHTS[label] ?? DEFAULT_FIELD_WEIGHT; num += w * dot(rvec, jv); den += w;
  }
  return den ? num / den : 0;
}
function lexical(ri, ci) {
  const rs = resumeSkills[ri], js = corpus[ci].skills; if (!rs.size) return 0;
  let hit = 0; for (const s of rs) if (js.has(s)) hit++;
  return hit / rs.size;
}
const pools = RESUMES.map((_, ri) => {
  const prod = corpus.map((c, ci) => ({ id: c.id, s: dot(resumeSmall[ri], summarySmall[ci]) }));
  const fdesc = corpus.map((c, ci) => ({ id: c.id, s: dot(resumeSmall[ri], fullDescSmall[ci]) }));
  const lex = corpus.map((c, ci) => ({ id: c.id, s: lexical(ri, ci) }));
  const fld = corpus.map((c, ci) => ({ id: c.id, s: fieldChunk(ri, ci) }));
  const topK = (arr) => arr.slice().sort((a, b) => b.s - a.s).slice(0, POOL_PER_METHOD).map((x) => x.id);
  return [...new Set([...topK(prod), ...topK(fdesc), ...topK(lex), ...topK(fld)])];
});
pools.forEach((p, ri) => console.log(`  ${RESUMES[ri].id} pool = ${p.length} candidates`));

// Pool-only embeddings: LARGE + HyDE. Unique (resume-independent) job set.
const poolJobIds = [...new Set(pools.flat())];
console.log(`\nUnion pool ${poolJobIds.length} unique jobs — embedding 3-large + generating HyDE profiles...`);
const poolLargeVecs = await embed(poolJobIds.map((id) => buildJobText(corpus[idIndex.get(id)].row)), LARGE);
const largeById = new Map(poolJobIds.map((id, i) => [id, poolLargeVecs[i]]));
const HYDE_SYS = 'You write a concise ideal-candidate profile for a job posting: the resume summary of a perfect applicant. 6-9 short lines covering role focus, seniority, key skills, and domain. No preamble, no markdown.';
const hydeTexts = await mapPool(poolJobIds, (id) => chat(HYDE_MODEL, HYDE_SYS, `JOB:\n${corpus[idIndex.get(id)].row.title}\n${corpus[idIndex.get(id)].row.description_summary}\n\nIdeal candidate profile:`, 350), CONCURRENCY);
const hydeVecs = await embed(hydeTexts.map((t) => t || 'n/a'), SMALL);
const hydeById = new Map(poolJobIds.map((id, i) => [id, hydeVecs[i]]));

// ── Oracle: ensemble judge over every (resume, pooled job) pair ───────────────
const pairs = [];
RESUMES.forEach((r, ri) => pools[ri].forEach((id) => pairs.push({ ri, id })));
console.log(`\nOracle: ${JUDGE_MODELS.join(' + ')} scoring ${pairs.length} (resume,job) pairs each...`);
const tj = Date.now();
const judgeRuns = {};
for (const jm of JUDGE_MODELS) {
  judgeRuns[jm] = await mapPool(pairs, (p) => fitScore(jm, RESUMES[p.ri], corpus[idIndex.get(p.id)].row), CONCURRENCY);
  const ok = judgeRuns[jm].filter((x) => x != null).length;
  console.log(`  ${jm}: ${ok}/${pairs.length} scored`);
}
console.log(`  oracle done in ${((Date.now() - tj) / 1000).toFixed(1)}s`);
// Inter-judge agreement (Spearman over pairs both scored).
if (JUDGE_MODELS.length >= 2) {
  const [a, b] = JUDGE_MODELS;
  const idx = pairs.map((_, i) => i).filter((i) => judgeRuns[a][i] != null && judgeRuns[b][i] != null);
  console.log(`  inter-judge Spearman (${a} vs ${b}) over ${idx.length} pairs = ${spearman(idx.map((i) => judgeRuns[a][i]), idx.map((i) => judgeRuns[b][i])).toFixed(4)}`);
}
// Ensemble relevance: mean of available judge scores. relByResume[ri] = Map(id->score)
const relByResume = RESUMES.map(() => new Map());
pairs.forEach((p, i) => {
  const scores = JUDGE_MODELS.map((jm) => judgeRuns[jm][i]).filter((x) => x != null);
  if (scores.length) relByResume[p.ri].set(p.id, mean(scores));
});

// ── Rerankers: pointwise mini + 4.1, listwise 4.1 ─────────────────────────────
console.log('\nRerankers scoring the pool...');
const miniRuns = await mapPool(pairs, (p) => fitScore(RERANK_MINI, RESUMES[p.ri], corpus[idIndex.get(p.id)].row), CONCURRENCY);
const bigRuns = await mapPool(pairs, (p) => fitScore(RERANK_BIG, RESUMES[p.ri], corpus[idIndex.get(p.id)].row), CONCURRENCY);
const miniByResume = RESUMES.map(() => new Map()); const bigByResume = RESUMES.map(() => new Map());
pairs.forEach((p, i) => { if (miniRuns[i] != null) miniByResume[p.ri].set(p.id, miniRuns[i]); if (bigRuns[i] != null) bigByResume[p.ri].set(p.id, bigRuns[i]); });

// Listwise: one gpt-4.1 call per resume ranks the whole pool.
const listwiseByResume = RESUMES.map(() => new Map());
for (let ri = 0; ri < RESUMES.length; ri++) {
  const ids = pools[ri];
  const listing = ids.map((id, k) => `${k + 1}. ${corpus[idIndex.get(id)].row.title} :: ${(corpus[idIndex.get(id)].row.description_summary || '').replace(/\n/g, ' ').slice(0, 220)}`).join('\n');
  const out = await chat(RERANK_BIG, 'You are an expert technical recruiter ranking job postings for a candidate.', `RESUME:\n${resumeText(RESUMES[ri])}\n\nCANDIDATE JOBS (numbered):\n${listing}\n\nRank ALL job numbers from BEST to WORST fit for this resume. Output ONLY the numbers, comma-separated, best first. Include every number exactly once.`, 1200);
  const order = []; const seen = new Set();
  for (const m of out.matchAll(/\d+/g)) { const k = parseInt(m[0], 10) - 1; if (k >= 0 && k < ids.length && !seen.has(k)) { seen.add(k); order.push(ids[k]); } }
  ids.forEach((id) => { if (!order.includes(id)) order.push(id); }); // append any dropped
  order.forEach((id, i) => listwiseByResume[ri].set(id, ids.length - i)); // higher = better
}

// ── Score every method as a ranking of each resume's pool ─────────────────────
function methodScores(ri) {
  const ids = pools[ri];
  const prod = new Map(ids.map((id) => [id, dot(resumeSmall[ri], summarySmall[idIndex.get(id)])]));
  const large = new Map(ids.map((id) => [id, dot(resumeLarge[ri], largeById.get(id))]));
  const field = new Map(ids.map((id) => [id, fieldChunk(ri, idIndex.get(id))]));
  const lex = new Map(ids.map((id) => [id, lexical(ri, idIndex.get(id))]));
  const hyde = new Map(ids.map((id) => [id, dot(resumeSmall[ri], hydeById.get(id))]));
  // HYBRID: RRF of PROD and LEXICAL ranks.
  const rp = rankMap(ids, prod), rl = rankMap(ids, lex);
  const hybrid = new Map(ids.map((id) => [id, 1 / (60 + rp.get(id)) + 1 / (60 + rl.get(id))]));
  // FEATURE: min-max normalised cosine + skill-overlap + seniority, weighted.
  const cosN = minmax(ids.map((id) => prod.get(id)));
  const lexN = minmax(ids.map((id) => lex.get(id)));
  const feature = new Map(ids.map((id) => {
    const sen = seniorityMatch(RESUMES[ri].level, corpus[idIndex.get(id)].row.title);
    return [id, 0.5 * cosN(prod.get(id)) + 0.4 * lexN(lex.get(id)) + 0.1 * sen];
  }));
  return {
    PROD: prod, LARGE: large, FIELD: field, LEXICAL: lex, HYBRID: hybrid, FEATURE: feature, HYDE: hyde,
    'RR-mini': miniByResume[ri], 'RR-4.1': bigByResume[ri], LISTWISE: listwiseByResume[ri],
  };
}
const METHOD_NAMES = ['PROD', 'LARGE', 'FIELD', 'LEXICAL', 'HYBRID', 'FEATURE', 'HYDE', 'RR-mini', 'RR-4.1', 'LISTWISE'];
const agg = Object.fromEntries(METHOD_NAMES.map((m) => [m, { ndcg: [], fit: [], recall: [], rho: [] }]));
for (let ri = 0; ri < RESUMES.length; ri++) {
  const rel = relByResume[ri]; const ids = pools[ri];
  const idealTop10 = new Set([...rel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id));
  const ms = methodScores(ri);
  for (const m of METHOD_NAMES) {
    const sc = ms[m]; if (!sc || !sc.size) continue;
    const ranked = [...ids].sort((a, b) => (sc.get(b) ?? -1) - (sc.get(a) ?? -1));
    agg[m].ndcg.push(ndcg(ranked, rel, 10));
    agg[m].fit.push(mean(ranked.slice(0, 10).map((id) => rel.get(id))));
    agg[m].recall.push(ranked.slice(0, 10).filter((id) => idealTop10.has(id)).length / Math.min(10, idealTop10.size));
    agg[m].rho.push(spearman(ids.map((id) => sc.get(id) ?? 0), ids.map((id) => rel.get(id) ?? 0)));
  }
}
const table = METHOD_NAMES.map((m) => ({ method: m, ndcg: mean(agg[m].ndcg), fit: mean(agg[m].fit), recall: mean(agg[m].recall), rho: mean(agg[m].rho) }))
  .sort((a, b) => b.ndcg - a.ndcg);

// ── Report ───────────────────────────────────────────────────────────────────
const LLM_METHODS = new Set(['RR-mini', 'RR-4.1', 'LISTWISE']);
console.log('\n' + '═'.repeat(78));
console.log('MATCHING METHOD BAKE-OFF  (avg over ' + RESUMES.length + ' resumes; oracle = ' + JUDGE_MODELS.join('+') + ')');
console.log('═'.repeat(78));
console.log(`${'Rank Method'.padEnd(18)} ${'NDCG@10'.padStart(9)} ${'meanFit@10'.padStart(11)} ${'recall@10'.padStart(10)} ${'Spearman'.padStart(9)}  type`);
console.log('-'.repeat(78));
table.forEach((r, i) => {
  console.log(`${String(i + 1).padStart(2)}. ${r.method.padEnd(13)} ${r.ndcg.toFixed(4).padStart(9)} ${r.fit.toFixed(1).padStart(11)} ${(r.recall * 100).toFixed(0).padStart(9)}% ${r.rho.toFixed(4).padStart(9)}  ${LLM_METHODS.has(r.method) ? 'LLM rerank' : 'retrieval'}`);
});
const best = table[0];
const bestRetrieval = table.filter((r) => !LLM_METHODS.has(r.method))[0];
const prod = table.find((r) => r.method === 'PROD');
const sketch = table.find((r) => r.method === 'RR-4.1');
console.log('\n── Headline comparison ──────────────────────────────────────────────────────');
console.log(`  BEST overall:        ${best.method}  (NDCG ${best.ndcg.toFixed(4)}, fit ${best.fit.toFixed(1)}, recall ${(best.recall * 100).toFixed(0)}%)`);
console.log(`  BEST retrieval-only: ${bestRetrieval.method}  (NDCG ${bestRetrieval.ndcg.toFixed(4)}, fit ${bestRetrieval.fit.toFixed(1)}, recall ${(bestRetrieval.recall * 100).toFixed(0)}%)`);
console.log(`  Current production:  PROD  (NDCG ${prod.ndcg.toFixed(4)}, fit ${prod.fit.toFixed(1)}, recall ${(prod.recall * 100).toFixed(0)}%)`);
console.log(`  Reranker sketch:     RR-4.1  (NDCG ${sketch.ndcg.toFixed(4)}, fit ${sketch.fit.toFixed(1)}, recall ${(sketch.recall * 100).toFixed(0)}%)`);
console.log(`  BEST vs PROD:   meanFit@10 ${(best.fit - prod.fit >= 0 ? '+' : '')}${(best.fit - prod.fit).toFixed(1)}   recall ${(best.recall - prod.recall >= 0 ? '+' : '')}${((best.recall - prod.recall) * 100).toFixed(0)} pts`);
console.log(`  BEST vs sketch: meanFit@10 ${(best.fit - sketch.fit >= 0 ? '+' : '')}${(best.fit - sketch.fit).toFixed(1)}   recall ${(best.recall - sketch.recall >= 0 ? '+' : '')}${((best.recall - sketch.recall) * 100).toFixed(0)} pts`);
console.log('═'.repeat(78) + '\n');

writeFileSync('scripts/_bench-results.json', JSON.stringify({ when: new Date().toISOString(), resumes: RESUMES.map((r) => r.id), sample: rows.length, judges: JUDGE_MODELS, pools: pools.map((p) => p.length), table }, null, 2));
console.log('Wrote scripts/_bench-results.json');
