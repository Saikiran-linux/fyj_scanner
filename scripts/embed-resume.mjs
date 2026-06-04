#!/usr/bin/env node
// One-shot: build a 14-field "JD-style" precis of Sai's resume in the
// EXACT same schema src/summarize.mjs produces for jobs, prepend the
// same title + signal block buildJobText() uses, then embed via
// text-embedding-3-small (1536d) — i.e. land the resume in the same
// vector space as jobs.embedding so pgvector cosine search is symmetric.
//
// Prints two things to stdout:
//   1. the embedding text (for sanity-checking against the JD format)
//   2. a single line `[v1,v2,...,v1536]` — paste into Postgres as
//      '<literal>'::vector(1536) and order by  embedding <=> resume.

import fs from 'node:fs';

// Load OPENAI_API_KEY from .env (same pattern as backfill scripts).
const env = fs.readFileSync('.env', 'utf8');
for (const line of env.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');

// Title + structured signal block — same shape buildJobText() puts above
// the summary. Title is the canonical role the candidate is qualified for;
// the signal lines mirror the labels embedded for jobs (Seniority /
// Workplace / Location), so the resume and jobs share the same prelude
// distribution.
const title = 'Senior Data Engineer / AI Engineer (GenAI · RAG · Healthcare IT)';
const signals = [
  'Seniority: senior',
  'Workplace: hybrid',
  'Employment type: full-time',
  'Department: Data / AI Engineering',
  'Location: Irving, Texas, United States',
].join('\n');

// 14-field precis, identical labels & order to summarize.mjs SYSTEM_PROMPT.
// Phrased as if describing the role this candidate fills — that lands the
// vector in the right neighbourhood of the JD distribution rather than the
// résumé distribution.
const summary = [
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

const input = `${title}\n\n${signals}\n\n${summary}`;
console.error('---- embedding input ----\n' + input + '\n-------------------------');

// Persist the resume TEXT next to the vector so the second-stage reranker
// (src/rerank.mjs, via scripts/call-match.mjs) can score candidate fit against
// the same resume. The vector goes to stdout (redirected to _resume.vec); the
// text is a side-file because stdout is reserved for the vector literal.
fs.writeFileSync('scripts/_resume.txt', input);
console.error('wrote scripts/_resume.txt (' + input.length + ' chars)');

const res = await fetch('https://api.openai.com/v1/embeddings', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'text-embedding-3-small',
    input,
  }),
});
if (!res.ok) {
  console.error('OpenAI HTTP', res.status, await res.text());
  process.exit(1);
}
const data = await res.json();
const vec = data.data[0].embedding;
if (vec.length !== 1536) throw new Error(`expected 1536d, got ${vec.length}`);

// Postgres vector literal: [v1,v2,...] — no spaces, max precision.
process.stdout.write('[' + vec.join(',') + ']\n');
console.error(`embedded ok · ${vec.length} dims · usage=${JSON.stringify(data.usage)}`);
