/**
 * Resume → jobs matching, server-side only (reads OPENAI_API_KEY + the
 * service-role key — never import from a Client Component).
 *
 * This mirrors the canonical CLI matcher in the repo's src/ (resume-to-jd.mjs
 * + embeddings + match-resume.mjs + rerank.mjs), reimplemented here because the
 * status-page deploys independently to Vercel (root dir = status-page) and
 * can't import files outside its own tree. Keep the two in sync if the
 * matching approach changes — see docs/matching-benchmark.md for why it's a
 * two-stage cosine-retrieve → gpt-4o-mini rerank.
 */

import { pgRpc } from './supabase';

const EMBED_MODEL = 'text-embedding-3-small';
const SUMMARY_MODEL = process.env.RESUME_JD_MODEL || 'gpt-4o-mini';
const RERANK_MODEL = process.env.RERANK_MODEL || 'gpt-4o-mini';
const CANDIDATES = Number(process.env.MATCH_CANDIDATES || 40);
const TOPK = Number(process.env.MATCH_TOPK || 15);
const RERANK_CONCURRENCY = Number(process.env.RERANK_CONCURRENCY || 6);

function openaiKey() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error('Server missing OPENAI_API_KEY');
  return k;
}

async function openai(path, body) {
  const res = await fetch(`https://api.openai.com/v1/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`OpenAI ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// ── 1. résumé → JD-style 14-field precis (lands in jobs.embedding space) ──────
const SIGNAL_FIELDS = ['Seniority', 'Workplace', 'Employment type', 'Department', 'Location'];
const SUMMARY_FIELDS = ['Role', 'Level', 'Experience', 'Required skills', 'Preferred skills', 'Team', 'Industry', 'Company stage', 'Location', 'Remote policy', 'Compensation', 'Benefits', 'Visa', 'Schedule'];

const JD_SYSTEM = `You convert a candidate's résumé into a structured, search-friendly profile describing the kind of role they are a strong fit for, so it can be matched against job postings.
Reply with EXACTLY these labelled lines, in this order, no preamble, no markdown, no blank lines:

Title: <concise target role title, e.g. "Senior Data Engineer (GenAI · Healthcare)">
Seniority: <intern / junior / mid / senior / staff / principal / lead / manager / director / vp>
Workplace: <remote / hybrid / onsite / unknown>
Employment type: <full-time / contract / unknown>
Department: <e.g. Data / AI Engineering>
Role: <one sentence on the candidate's actual day-to-day work>
Level: <same scale as Seniority; note IC vs manager track if clear>
Experience: <years of experience, e.g. "4+ years"; "unknown" if unclear>
Required skills: <12-20 comma-separated CORE technologies, languages, frameworks, tools the candidate clearly has>
Preferred skills: <comma-separated secondary / nice-to-have skills; "unknown" if none>
Team: <engineering / data / product / design / etc., plus function focus>
Industry: <domains the candidate has worked in — e.g. healthcare, fintech, AI/ML>
Company stage: <preference if stated, else "any">
Location: <city, region, country if present; else "unknown">
Remote policy: <remote / hybrid / onsite preference; "unknown" if unclear>
Compensation: <"unknown" unless the resume states a target>
Benefits: <"unknown">
Visa: <work authorization if stated, else "unknown">
Schedule: <full-time / part-time / unknown>`;

function parseLabelled(text) {
  const map = new Map();
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\s*([A-Za-z][A-Za-z /]+?):\s*(.*)$/);
    if (m) map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

async function resumeToJd(resumeRaw) {
  const data = await openai('chat/completions', {
    model: SUMMARY_MODEL, temperature: 0, max_tokens: 600,
    messages: [
      { role: 'system', content: JD_SYSTEM },
      { role: 'user', content: `RÉSUMÉ:\n${resumeRaw.slice(0, 12000)}\n\nStructured profile:` },
    ],
  });
  const map = parseLabelled(data.choices?.[0]?.message?.content);
  const title = map.get('Title') || 'Candidate';
  const keep = (l) => { const v = map.get(l); return v && !/^unknown$/i.test(v) ? `${l}: ${v}` : null; };
  const signals = SIGNAL_FIELDS.map(keep).filter(Boolean).join('\n');
  const summary = SUMMARY_FIELDS.map((l) => `${l}: ${map.get(l) || 'unknown'}`).join('\n');
  return { jdText: [title, signals, summary].filter(Boolean).join('\n\n'), title };
}

// ── 2. embed (text-embedding-3-small, same space as jobs.embedding) ──────────
async function embed(text) {
  const data = await openai('embeddings', { model: EMBED_MODEL, input: text });
  return data.data[0].embedding;
}

// ── 3. pointwise rerank (gpt-4o-mini fit score) — bake-off winner ────────────
const FIT_SYSTEM = `You are a meticulous senior technical recruiter. Score how well a candidate's resume matches a job posting on a 0-100 scale: 100 = ideal hire you would fast-track, 0 = unrelated. Weigh required-skills overlap most, then seniority alignment, then domain/role relevance. Ignore location and compensation. Reply with ONLY an integer 0-100.`;

async function fitScore(resumeText, job) {
  try {
    const data = await openai('chat/completions', {
      model: RERANK_MODEL, temperature: 0, max_tokens: 8,
      messages: [
        { role: 'system', content: FIT_SYSTEM },
        { role: 'user', content: `RESUME:\n${resumeText}\n\nJOB POSTING:\n${job.title || ''}\n${job.description_summary || ''}\n\nFit score (0-100):` },
      ],
    });
    const n = parseInt((data.choices?.[0]?.message?.content || '').match(/\d+/)?.[0] ?? '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  } catch {
    return null; // non-fatal: this candidate falls back to its cosine rank
  }
}

async function mapPool(items, fn, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ── orchestration ────────────────────────────────────────────────────────────
function toMatch(c) {
  const comp = c.comp_min != null || c.comp_max != null
    ? `${c.comp_currency || ''}${c.comp_min ?? ''}${c.comp_max != null && c.comp_max !== c.comp_min ? '–' + c.comp_max : ''}`.trim()
    : null;
  return {
    title: c.title, company: c.company, location: c.location, remote: c.remote,
    comp, posted: c.posted, url: c.url, fit: c.rerank_score, cosine: c.cosine_sim,
    why: (c.description_summary || '').split('\n').find((l) => /^Role:/i.test(l))?.replace(/^Role:\s*/i, '') || null,
  };
}

/**
 * Full pipeline: résumé text → JD precis → embed → cosine retrieve → rerank.
 * Returns { title, matches, reranked, retrieved, tookMs }.
 */
export async function matchResume(resumeRaw) {
  if (!resumeRaw || resumeRaw.trim().length < 30) {
    throw new Error('Could not read enough résumé text. Try another file or paste the text.');
  }
  const t0 = Date.now();
  const { jdText, title } = await resumeToJd(resumeRaw);
  const resumeVec = await embed(jdText);

  // Stage 1 — cosine retrieve (HNSW). supabase pgRpc throws on PGRST002; the
  // schema cache is warm in steady state so a one-off cold start is the only risk.
  const candidates = await pgRpc('match_resume_candidates', { resume_vec: resumeVec, match_count: CANDIDATES });

  // Stage 2 — rerank by LLM fit, sort desc, failures sink via cosine tiebreak.
  const scores = await mapPool(candidates, (j) => fitScore(jdText, j), RERANK_CONCURRENCY);
  const reranked = candidates.map((c, i) => ({ ...c, rerank_score: scores[i], _i: i }));
  reranked.sort((a, b) => (b.rerank_score ?? -1) - (a.rerank_score ?? -1) || a._i - b._i);

  return {
    title,
    reranked: true,
    retrieved: candidates.length,
    tookMs: Date.now() - t0,
    matches: reranked.slice(0, TOPK).map(toMatch),
  };
}
