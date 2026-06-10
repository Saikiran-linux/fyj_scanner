#!/usr/bin/env node
/**
 * voyage-vs-openai.mjs — head-to-head bake-off of two full matching pipelines,
 * scored by a neutral LLM oracle. TEST ONLY: writes nothing to Supabase.
 *
 *   OAI  (current production)  text-embedding-3-small cosine → gpt-4o-mini rerank
 *   VOY  (candidate)           voyage-4-large cosine (query/document) → rerank-2.5
 *
 * Methodology mirrors scripts/matching-bench.mjs so results are comparable:
 *   • No pool bias — each resume's candidate pool is the UNION of top-K from
 *     OAI-cosine, VOY-cosine and a lexical retriever, so neither embedder gets a
 *     home-field recall advantage. Both pipelines then RANK this identical pool.
 *   • No self-grading — relevance ORACLE is an ensemble of gpt-5.1 + gpt-5.2,
 *     a different/stronger generation than either reranker under test.
 *   • Reported metrics: NDCG@10, meanFit@10, recall@10 (avg over 3 resumes).
 *
 * CAVEAT (disclosed, not hidden): the oracle is an OpenAI model, which may carry
 * a mild same-family prior toward the OpenAI reranker. We therefore ALSO report
 * the retrieval-only cut (VOY-cos vs OAI-cos), which the oracle judges with no
 * such pipeline overlap, as a cross-check.
 *
 * MODES:
 *   • Full bake-off       — needs OPENAI_API_KEY + VOYAGE_API_KEY + Supabase.
 *   • Voyage sanity run   — VOYAGE_API_KEY + Supabase only (no OpenAI). Runs the
 *                           VOY pipeline end-to-end on real jobs and prints its
 *                           top-10 so we can eyeball quality before a migration.
 *
 * Usage:
 *   VOYAGE_API_KEY=... node --env-file=.env scripts/voyage-vs-openai.mjs
 *   env: SAMPLE_SIZE (800), POOL_PER_METHOD (15), CONCURRENCY (10),
 *        JUDGES (gpt-5.1,gpt-5.2), VOYAGE_EMBED_MODEL (voyage-4-large),
 *        VOYAGE_RERANK_MODEL (rerank-2.5)
 */

import { selectAll } from '../src/supabase-client.mjs';
import { buildJobText, extractSeniorityFromTitle } from '../src/embeddings.mjs';
import { writeFileSync } from 'node:fs';

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 800);
const POOL_PER_METHOD = Number(process.env.POOL_PER_METHOD || 15);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const JUDGE_MODELS = (process.env.JUDGES || 'gpt-5.1,gpt-5.2').split(',');
const RERANK_MINI = 'gpt-4o-mini';
const OAI_EMBED = 'text-embedding-3-small';
const VOY_EMBED = process.env.VOYAGE_EMBED_MODEL || 'voyage-4-large';
const VOY_RERANK = process.env.VOYAGE_RERANK_MODEL || 'rerank-2.5';
const OAI_BATCH = 256;
const VOY_BATCH = 128; // ≤1000 texts & well under the per-request token cap

const HAS_OAI = Boolean(process.env.OPENAI_API_KEY);
const HAS_VOY = Boolean(process.env.VOYAGE_API_KEY);

// ── Resumes (shared with matching-bench.mjs: Data/AI, Frontend, DevOps) ───────
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

// ── Skill parsing for the lexical retriever (pool diversity only) ─────────────
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

// ── Vector helpers (normalise so dot == cosine for either provider) ───────────
function normalize(v) {
  let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const mean = (a) => { const v = a.filter((x) => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; };
const dcg = (g) => g.reduce((s, x, i) => s + x / Math.log2(i + 2), 0);
function ndcg(rankedIds, rel, k) {
  const gains = rankedIds.slice(0, k).map((id) => rel.get(id) ?? 0);
  const ideal = [...rel.values()].sort((a, b) => b - a).slice(0, k);
  return dcg(ideal) === 0 ? 0 : dcg(gains) / dcg(ideal);
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function oaiEmbed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += OAI_BATCH) {
    const batch = texts.slice(i, i + OAI_BATCH);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: OAI_EMBED, input: batch }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 4) { await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt + 1))); continue; }
      if (!res.ok) throw new Error(`oai embeddings ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const data = await res.json();
      out.push(...data.data.slice().sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding)));
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

// ── Voyage ────────────────────────────────────────────────────────────────────
async function voyEmbed(texts, input_type) {
  const out = [];
  for (let i = 0; i < texts.length; i += VOY_BATCH) {
    const batch = texts.slice(i, i + VOY_BATCH);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST', headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: VOY_EMBED, input: batch, input_type }),
      });
      if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
      if (!res.ok) throw new Error(`voyage embeddings ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = await res.json();
      out.push(...data.data.slice().sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding)));
      break;
    }
  }
  return out;
}
// One rerank call: returns Map(docIndex -> relevance_score).
async function voyRerank(query, documents) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST', headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: VOY_RERANK, query, documents, top_k: documents.length }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) { await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt)); continue; }
    if (!res.ok) throw new Error(`voyage rerank ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const m = new Map();
    for (const d of data.data) m.set(d.index, d.relevance_score);
    return m;
  }
}

async function mapPool(items, fn, conc) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch { out[i] = null; } }
  }));
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────────────
if (!HAS_VOY) { console.error('VOYAGE_API_KEY is required'); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error('Need Supabase creds'); process.exit(1); }

console.log(`Fetching ${SAMPLE_SIZE} active jobs (summary + description)...`);
const rows = await selectAll('jobs', {
  closed_at: 'is.null', description: 'not.is.null', description_summary: 'not.is.null',
  select: ['id', 'title', 'department', 'location', 'description', 'description_summary', 'comp_min', 'comp_max', 'comp_currency', 'comp_interval', 'comp_text', 'remote', 'employment_type'].join(','),
  order: 'id.desc',
}, { pageSize: 1000, maxRows: SAMPLE_SIZE });
console.log(`Got ${rows.length} jobs.\n`);
const corpus = rows.map((r) => ({ row: r, id: r.id, skills: parseSkills(r.description_summary) }));
const idIndex = new Map(corpus.map((c, i) => [c.id, i]));
const jobTexts = corpus.map((c) => buildJobText(c.row)); // identical input for BOTH embedders — fair

// ── Voyage corpus + resume embeddings (always) ────────────────────────────────
console.log(`Embedding corpus with ${VOY_EMBED} (input_type=document)...`);
let t0 = Date.now();
const voyCorpus = await voyEmbed(jobTexts, 'document');
const voyResume = await voyEmbed(RESUMES.map(resumeText), 'query');
console.log(`  voyage embeds done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// ── Sanity mode: no OpenAI key → run VOY pipeline only and eyeball top-10 ──────
if (!HAS_OAI) {
  console.log('═'.repeat(78));
  console.log('VOYAGE SANITY RUN  (no OPENAI_API_KEY — baseline + oracle unavailable)');
  console.log(`Pipeline: ${VOY_EMBED} cosine → ${VOY_RERANK}.  No quality verdict — eyeball only.`);
  console.log('═'.repeat(78));
  for (let ri = 0; ri < RESUMES.length; ri++) {
    const cos = corpus.map((c, ci) => ({ id: c.id, ci, s: dot(voyResume[ri], voyCorpus[ci]) }));
    const top = cos.sort((a, b) => b.s - a.s).slice(0, 30);
    const rr = await voyRerank(resumeText(RESUMES[ri]), top.map((t) => corpus[t.ci].row.description_summary || corpus[t.ci].row.title || ''));
    const reranked = top.map((t, k) => ({ ...t, rr: rr.get(k) ?? 0 })).sort((a, b) => b.rr - a.rr).slice(0, 10);
    console.log(`\n── ${RESUMES[ri].id}: ${VOY_RERANK} top-10 (cos shown for reference) ──`);
    reranked.forEach((t, i) => {
      console.log(`  ${String(i + 1).padStart(2)}. rr=${t.rr.toFixed(4)} cos=${t.s.toFixed(4)}  ${(corpus[t.ci].row.title || t.id).slice(0, 58)}`);
    });
  }
  console.log('\nVoyage pipeline ran clean on real data. Provide OPENAI_API_KEY to run the');
  console.log('judged head-to-head (OAI baseline + neutral gpt-5.x oracle).');
  process.exit(0);
}

// ── Full bake-off (OpenAI key present) ────────────────────────────────────────
console.log(`Embedding corpus + resumes with ${OAI_EMBED}...`);
t0 = Date.now();
const oaiCorpus = await oaiEmbed(jobTexts);
const oaiResume = await oaiEmbed(RESUMES.map(resumeText));
console.log(`  openai embeds done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// Lexical scorer (pool diversity only).
const resumeSkills = RESUMES.map((r) => parseSkills(r.summary));
function lexical(ri, ci) {
  const rs = resumeSkills[ri], js = corpus[ci].skills; if (!rs.size) return 0;
  let hit = 0; for (const s of rs) if (js.has(s)) hit++;
  return hit / rs.size;
}

// Union pool: top-K from VOY-cos, OAI-cos, lexical — no home-field advantage.
const pools = RESUMES.map((_, ri) => {
  const voy = corpus.map((c, ci) => ({ id: c.id, s: dot(voyResume[ri], voyCorpus[ci]) }));
  const oai = corpus.map((c, ci) => ({ id: c.id, s: dot(oaiResume[ri], oaiCorpus[ci]) }));
  const lex = corpus.map((c, ci) => ({ id: c.id, s: lexical(ri, ci) }));
  const topK = (arr) => arr.slice().sort((a, b) => b.s - a.s).slice(0, POOL_PER_METHOD).map((x) => x.id);
  return [...new Set([...topK(voy), ...topK(oai), ...topK(lex)])];
});
pools.forEach((p, ri) => console.log(`  ${RESUMES[ri].id} pool = ${p.length} candidates`));

// Oracle: gpt-5.x ensemble over every (resume, pooled job) pair.
const pairs = [];
RESUMES.forEach((r, ri) => pools[ri].forEach((id) => pairs.push({ ri, id })));
console.log(`\nOracle ${JUDGE_MODELS.join('+')} scoring ${pairs.length} (resume,job) pairs...`);
const judgeRuns = {};
for (const jm of JUDGE_MODELS) {
  judgeRuns[jm] = await mapPool(pairs, (p) => fitScore(jm, RESUMES[p.ri], corpus[idIndex.get(p.id)].row), CONCURRENCY);
  console.log(`  ${jm}: ${judgeRuns[jm].filter((x) => x != null).length}/${pairs.length} scored`);
}
const relByResume = RESUMES.map(() => new Map());
pairs.forEach((p, i) => {
  const scores = JUDGE_MODELS.map((jm) => judgeRuns[jm][i]).filter((x) => x != null);
  if (scores.length) relByResume[p.ri].set(p.id, mean(scores));
});

// OAI reranker (gpt-4o-mini pointwise) over the pool.
console.log('\nOAI reranker (gpt-4o-mini) scoring the pool...');
const oaiRerunRaw = await mapPool(pairs, (p) => fitScore(RERANK_MINI, RESUMES[p.ri], corpus[idIndex.get(p.id)].row), CONCURRENCY);
const oaiRerank = RESUMES.map(() => new Map());
pairs.forEach((p, i) => { if (oaiRerunRaw[i] != null) oaiRerank[p.ri].set(p.id, oaiRerunRaw[i]); });

// VOY reranker (rerank-2.5): one call per resume over its pool.
console.log(`VOY reranker (${VOY_RERANK}) scoring the pool...`);
const voyRerankByResume = RESUMES.map(() => new Map());
for (let ri = 0; ri < RESUMES.length; ri++) {
  const ids = pools[ri];
  const docs = ids.map((id) => corpus[idIndex.get(id)].row.description_summary || corpus[idIndex.get(id)].row.title || '');
  const m = await voyRerank(resumeText(RESUMES[ri]), docs);
  ids.forEach((id, k) => voyRerankByResume[ri].set(id, m.get(k) ?? 0));
}

// ── Score each method as a ranking of each resume's pool ──────────────────────
const METHODS = ['OAI-cos', 'VOY-cos', 'OAI→mini', 'VOY→2.5'];
const agg = Object.fromEntries(METHODS.map((m) => [m, { ndcg: [], fit: [], recall: [] }]));
for (let ri = 0; ri < RESUMES.length; ri++) {
  const rel = relByResume[ri]; const ids = pools[ri];
  const idealTop10 = new Set([...rel.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id]) => id));
  const scoreMaps = {
    'OAI-cos': new Map(ids.map((id) => [id, dot(oaiResume[ri], oaiCorpus[idIndex.get(id)])])),
    'VOY-cos': new Map(ids.map((id) => [id, dot(voyResume[ri], voyCorpus[idIndex.get(id)])])),
    'OAI→mini': oaiRerank[ri],
    'VOY→2.5': voyRerankByResume[ri],
  };
  for (const m of METHODS) {
    const sc = scoreMaps[m]; if (!sc || !sc.size) continue;
    const ranked = [...ids].sort((a, b) => (sc.get(b) ?? -1) - (sc.get(a) ?? -1));
    agg[m].ndcg.push(ndcg(ranked, rel, 10));
    agg[m].fit.push(mean(ranked.slice(0, 10).map((id) => rel.get(id))));
    agg[m].recall.push(ranked.slice(0, 10).filter((id) => idealTop10.has(id)).length / Math.min(10, idealTop10.size));
  }
}
const table = METHODS.map((m) => ({ method: m, ndcg: mean(agg[m].ndcg), fit: mean(agg[m].fit), recall: mean(agg[m].recall) }))
  .sort((a, b) => b.ndcg - a.ndcg);

console.log('\n' + '═'.repeat(72));
console.log(`VOYAGE vs OPENAI BAKE-OFF  (avg over ${RESUMES.length} resumes; oracle=${JUDGE_MODELS.join('+')})`);
console.log('═'.repeat(72));
console.log(`${'Rank Method'.padEnd(16)} ${'NDCG@10'.padStart(9)} ${'meanFit@10'.padStart(11)} ${'recall@10'.padStart(10)}  type`);
console.log('-'.repeat(72));
table.forEach((r, i) => {
  const type = r.method.includes('→') ? 'two-stage' : 'retrieval';
  console.log(`${String(i + 1).padStart(2)}. ${r.method.padEnd(11)} ${r.ndcg.toFixed(4).padStart(9)} ${r.fit.toFixed(1).padStart(11)} ${(r.recall * 100).toFixed(0).padStart(9)}%  ${type}`);
});
const get = (m) => table.find((r) => r.method === m);
console.log('\n── Headline ─────────────────────────────────────────────────────────');
console.log(`  Two-stage:  VOY→2.5 vs OAI→mini  →  meanFit ${(get('VOY→2.5').fit - get('OAI→mini').fit >= 0 ? '+' : '')}${(get('VOY→2.5').fit - get('OAI→mini').fit).toFixed(1)}, recall ${(get('VOY→2.5').recall - get('OAI→mini').recall >= 0 ? '+' : '')}${((get('VOY→2.5').recall - get('OAI→mini').recall) * 100).toFixed(0)} pts`);
console.log(`  Retrieval:  VOY-cos vs OAI-cos   →  meanFit ${(get('VOY-cos').fit - get('OAI-cos').fit >= 0 ? '+' : '')}${(get('VOY-cos').fit - get('OAI-cos').fit).toFixed(1)}, recall ${(get('VOY-cos').recall - get('OAI-cos').recall >= 0 ? '+' : '')}${((get('VOY-cos').recall - get('OAI-cos').recall) * 100).toFixed(0)} pts`);
console.log('  NOTE: oracle is an OpenAI model — treat the retrieval-only row as the');
console.log('        less pipeline-correlated cross-check on the two-stage verdict.');
console.log('═'.repeat(72) + '\n');

writeFileSync('scripts/_voyage-bench.json', JSON.stringify({ when: new Date().toISOString(), sample: rows.length, judges: JUDGE_MODELS, voyEmbed: VOY_EMBED, voyRerank: VOY_RERANK, pools: pools.map((p) => p.length), table }, null, 2));
console.log('Wrote scripts/_voyage-bench.json');
