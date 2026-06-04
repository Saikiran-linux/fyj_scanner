#!/usr/bin/env node
// Two-stage resume↔jobs matcher: cosine retrieve (match_resume_candidates RPC)
// then LLM rerank (src/rerank.mjs). Reads the resume embedding from
// scripts/_resume.vec and, when present, the resume text from
// scripts/_resume.txt (both produced by scripts/embed-resume.mjs).
//
//   node scripts/embed-resume.mjs > scripts/_resume.vec   # writes _resume.txt too
//   node --env-file=.env scripts/call-match.mjs            # or: npm run match
//
// Reranking is on by default when OPENAI_API_KEY is set; disable with
// RERANK_ENABLED=0 to see the raw cosine ordering.
import fs from 'node:fs';
import { matchResume } from '../src/match-resume.mjs';

// Load .env when not already in the environment (mirrors the other scripts).
try {
  const env = fs.readFileSync('.env', 'utf8');
  for (const line of env.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* env may be supplied directly */ }

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing');
}

const resumeVec = JSON.parse(fs.readFileSync('scripts/_resume.vec', 'utf8').trim());
if (resumeVec.length !== 1536) throw new Error(`vec dim ${resumeVec.length}`);

let resumeText;
try { resumeText = fs.readFileSync('scripts/_resume.txt', 'utf8'); }
catch { console.error('no scripts/_resume.txt — rerank will be skipped'); }

const topK = Number(process.env.MATCH_TOPK || 20);
const t0 = Date.now();
const { candidates, reranked, retrieved } = await matchResume({ resumeVec, resumeText, topK });

console.error(`retrieved ${retrieved} cosine candidates · ${reranked ? 'reranked' : 'cosine-only'} · top ${candidates.length} · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (reranked) {
  console.error('rank  fit  cosine  title');
  candidates.forEach((c, i) => {
    console.error(`${String(i + 1).padStart(2)}.  ${String(c.rerank_score ?? '--').padStart(3)}  ${String(c.cosine_sim).padStart(6)}  ${(c.title || '').slice(0, 60)}`);
  });
}
console.log(JSON.stringify(candidates, null, 2));
