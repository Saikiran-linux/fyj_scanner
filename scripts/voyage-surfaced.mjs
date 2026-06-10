#!/usr/bin/env node
/**
 * voyage-surfaced.mjs — show the ACTUAL job postings each pipeline surfaces for
 * a resume, side by side. TEST ONLY: writes nothing to Supabase.
 *
 * Realistic two-stage flow (unlike the shared-pool bench, each embedder uses its
 * OWN retrieval): cosine top-RETRIEVE_N from the sample → rerank → top-10.
 *   OAI  text-embedding-3-small → gpt-4o-mini pointwise fit   (current prod)
 *   VOY  voyage-4-large (query/document) → rerank-2.5         (candidate)
 *
 * Each surfaced posting is annotated with an independent gpt-5.1 fit score
 * (0-100) so quality is visible, not just titles.
 *
 * Usage: OPENAI_API_KEY=... VOYAGE_API_KEY=... node --env-file=.env \
 *          scripts/voyage-surfaced.mjs
 *   env: SAMPLE_SIZE (800), RETRIEVE_N (40), RESUME (all|data-ai|frontend|devops),
 *        JUDGE (gpt-5.1), CONCURRENCY (10)
 */

import { selectAll } from '../src/supabase-client.mjs';
import { buildJobText } from '../src/embeddings.mjs';

const SAMPLE_SIZE = Number(process.env.SAMPLE_SIZE || 800);
const RETRIEVE_N = Number(process.env.RETRIEVE_N || 40);
const CONCURRENCY = Number(process.env.CONCURRENCY || 10);
const JUDGE = process.env.JUDGE || 'gpt-5.1';
const ONLY = (process.env.RESUME || 'all').toLowerCase();
const OAI_EMBED = 'text-embedding-3-small';
const VOY_EMBED = process.env.VOYAGE_EMBED_MODEL || 'voyage-4-large';
const VOY_RERANK = process.env.VOYAGE_RERANK_MODEL || 'rerank-2.5';
const MINI = 'gpt-4o-mini';

const RESUMES = [
  {
    id: 'data-ai',
    title: 'Senior Data Engineer / AI Engineer (GenAI · RAG · Healthcare IT)',
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
].filter((r) => ONLY === 'all' || r.id === ONLY);

const resumeText = (r) => `${r.title}\n\n${r.signals}\n\n${r.summary}`;
function normalize(v) { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); }
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

async function oaiEmbed(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 256) {
    const batch = texts.slice(i, i + 256);
    for (let a = 0; ; a++) {
      const res = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: OAI_EMBED, input: batch }) });
      if ((res.status === 429 || res.status >= 500) && a < 4) { await new Promise((r) => setTimeout(r, 1000 * 2 ** (a + 1))); continue; }
      if (!res.ok) throw new Error(`oai embed ${res.status}: ${(await res.text()).slice(0, 160)}`);
      const d = await res.json(); out.push(...d.data.slice().sort((x, y) => x.index - y.index).map((e) => normalize(e.embedding))); break;
    }
  }
  return out;
}
async function voyEmbed(texts, input_type) {
  const out = [];
  for (let i = 0; i < texts.length; i += 128) {
    const batch = texts.slice(i, i + 128);
    for (let a = 0; ; a++) {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', { method: 'POST', headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: VOY_EMBED, input: batch, input_type }) });
      if ((res.status === 429 || res.status >= 500) && a < 5) { await new Promise((r) => setTimeout(r, 1500 * 2 ** a)); continue; }
      if (!res.ok) throw new Error(`voy embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const d = await res.json(); out.push(...d.data.slice().sort((x, y) => x.index - y.index).map((e) => normalize(e.embedding))); break;
    }
  }
  return out;
}
async function voyRerank(query, documents) {
  for (let a = 0; ; a++) {
    const res = await fetch('https://api.voyageai.com/v1/rerank', { method: 'POST', headers: { Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: VOY_RERANK, query, documents, top_k: documents.length }) });
    if ((res.status === 429 || res.status >= 500) && a < 5) { await new Promise((r) => setTimeout(r, 1500 * 2 ** a)); continue; }
    if (!res.ok) throw new Error(`voy rerank ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const d = await res.json(); const m = new Map(); for (const x of d.data) m.set(x.index, x.relevance_score); return m;
  }
}
const isReasoning = (m) => /^(gpt-5|o\d)/.test(m);
const FIT_SYSTEM = `You are a meticulous senior technical recruiter. Score how well a candidate's resume matches a job posting on a 0-100 scale: 100 = ideal hire you would fast-track, 0 = unrelated. Weigh required-skills overlap most, then seniority alignment, then domain/role relevance. Ignore location and compensation. Reply with ONLY an integer 0-100.`;
async function fit(model, resume, job) {
  const body = { model, messages: [{ role: 'system', content: FIT_SYSTEM }, { role: 'user', content: `RESUME:\n${resumeText(resume)}\n\nJOB POSTING:\n${job.title || ''}\n${job.description_summary || ''}\n\nFit score (0-100):` }] };
  if (isReasoning(model)) body.max_completion_tokens = 2000; else { body.temperature = 0; body.max_tokens = 8; }
  for (let a = 0; a < 5; a++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if ((res.status === 429 || res.status >= 500) && a < 4) { await new Promise((r) => setTimeout(r, 1200 * 2 ** a)); continue; }
    if (!res.ok) throw new Error(`chat ${model} ${res.status}`);
    const d = await res.json(); const n = parseInt((d.choices?.[0]?.message?.content || '').match(/\d+/)?.[0] ?? '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  return null;
}
async function mapPool(items, fn, conc) {
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, async () => { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch { out[i] = null; } } }));
  return out;
}

if (!process.env.OPENAI_API_KEY || !process.env.VOYAGE_API_KEY) { console.error('Need OPENAI_API_KEY + VOYAGE_API_KEY'); process.exit(1); }
console.log(`Fetching ${SAMPLE_SIZE} active jobs...`);
const rows = await selectAll('jobs', {
  closed_at: 'is.null', description: 'not.is.null', description_summary: 'not.is.null',
  select: ['id', 'title', 'location', 'url', 'department', 'description', 'description_summary', 'comp_min', 'comp_max', 'comp_currency', 'comp_interval', 'comp_text', 'remote', 'employment_type', 'companies(slug)'].join(','),
  order: 'id.desc',
}, { pageSize: 1000, maxRows: SAMPLE_SIZE });
const co = (r) => r.companies?.slug || '?';
console.log(`Got ${rows.length} jobs.\n`);
const texts = rows.map((r) => buildJobText(r));

console.log('Embedding corpus (voyage-4-large + text-embedding-3-small)...');
const [voyCorpus, oaiCorpus] = await Promise.all([voyEmbed(texts, 'document'), oaiEmbed(texts)]);
const voyR = await voyEmbed(RESUMES.map(resumeText), 'query');
const oaiR = await oaiEmbed(RESUMES.map(resumeText));

const out = { when: new Date().toISOString(), sample: rows.length, retrieveN: RETRIEVE_N, judge: JUDGE, resumes: {} };
for (let ri = 0; ri < RESUMES.length; ri++) {
  const r = RESUMES[ri];
  // Each pipeline retrieves its OWN top-N, then reranks.
  const oaiTop = rows.map((row, i) => ({ row, i, cos: dot(oaiR[ri], oaiCorpus[i]) })).sort((a, b) => b.cos - a.cos).slice(0, RETRIEVE_N);
  const voyTop = rows.map((row, i) => ({ row, i, cos: dot(voyR[ri], voyCorpus[i]) })).sort((a, b) => b.cos - a.cos).slice(0, RETRIEVE_N);

  const miniScores = await mapPool(oaiTop, (c) => fit(MINI, r, c.row), CONCURRENCY);
  const oaiRanked = oaiTop.map((c, k) => ({ ...c, s: miniScores[k] ?? -1 })).sort((a, b) => b.s - a.s).slice(0, 10);

  const rr = await voyRerank(resumeText(r), voyTop.map((c) => c.row.description_summary || c.row.title || ''));
  const voyRanked = voyTop.map((c, k) => ({ ...c, s: rr.get(k) ?? 0 })).sort((a, b) => b.s - a.s).slice(0, 10);

  // Independent oracle fit on the union of surfaced jobs.
  const union = [...new Map([...oaiRanked, ...voyRanked].map((c) => [c.row.id, c.row])).values()];
  const oracle = await mapPool(union, (row) => fit(JUDGE, r, row), CONCURRENCY);
  const oracleById = new Map(union.map((row, k) => [row.id, oracle[k]]));

  const fmtList = (ranked) => ranked.map((c) => ({ title: c.row.title, company: co(c.row), location: c.row.location || '', url: c.row.url || '', score: c.s, fit: oracleById.get(c.row.id) }));
  out.resumes[r.id] = { oai: fmtList(oaiRanked), voy: fmtList(voyRanked) };

  // ── Print side by side ──
  const W = 46;
  const cell = (e, scoreLabel) => {
    if (!e) return ''.padEnd(W + 12);
    const t = `${(e.title || '').slice(0, 34)} · ${e.company}`.slice(0, W);
    const tag = `[fit ${e.fit ?? '—'}${scoreLabel}]`;
    return `${t.padEnd(W)} ${tag.padEnd(11)}`;
  };
  console.log('\n' + '═'.repeat(118));
  console.log(`RESUME: ${r.id}    (fit = independent ${JUDGE} 0-100;  retrieve top-${RETRIEVE_N} → rerank → top-10)`);
  console.log('═'.repeat(118));
  console.log(`${'#'.padStart(2)}  ${('OAI  text-embedding-3-small → gpt-4o-mini').padEnd(W + 12)} ${'VOY  voyage-4-large → rerank-2.5'}`);
  console.log('-'.repeat(118));
  for (let k = 0; k < 10; k++) {
    console.log(`${String(k + 1).padStart(2)}  ${cell(out.resumes[r.id].oai[k], '')} ${cell(out.resumes[r.id].voy[k], '')}`);
  }
  const meanFit = (l) => { const v = l.map((e) => e.fit).filter((x) => x != null); return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(1) : 'n/a'; };
  const overlap = new Set(out.resumes[r.id].oai.map((e) => e.title)); const shared = out.resumes[r.id].voy.filter((e) => overlap.has(e.title)).length;
  console.log('-'.repeat(118));
  console.log(`    mean ${JUDGE} fit@10:  OAI ${meanFit(out.resumes[r.id].oai)}   VOY ${meanFit(out.resumes[r.id].voy)}     shared titles in both top-10: ${shared}/10`);
}

const { writeFileSync } = await import('node:fs');
writeFileSync('scripts/_voyage-surfaced.json', JSON.stringify(out, null, 2));
console.log('\nWrote scripts/_voyage-surfaced.json (full titles, companies, URLs)');
