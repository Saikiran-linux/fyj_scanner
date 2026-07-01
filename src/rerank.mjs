/**
 * Second-stage LLM reranker for resume↔job matching.
 *
 * Dense cosine retrieval (the HNSW search behind match_resume_candidates) is
 * great for recall but only a rough proxy for actual fit — on a pool of
 * already-plausible candidates its ordering barely tracks how good each match
 * really is. A pointwise LLM "fit score" reorders that shortlist far better.
 *
 * This is the validated winner of the matching bake-off
 * (docs/matching-benchmark.md): pointwise fit scoring lifted mean judged-fit of
 * the top-10 by ~+11 points and recall@10 by ~+30 pts over the raw cosine path,
 * and the cheap gpt-4o-mini model matched (slightly beat) gpt-4.1 — so we
 * default to gpt-4o-mini.
 *
 * Design mirrors src/summarize.mjs: bounded concurrency, retry on transient
 * OpenAI errors, and — critically — NON-FATAL. If the rerank pass fails for any
 * candidate (or entirely), we fall back to the original cosine order rather
 * than break matching. A degraded match is acceptable; a broken one is not.
 *
 * Cost: gpt-4o-mini at $0.15/M input + $0.60/M output. A candidate is
 * ~600 input + a few output tokens → ~$0.0001 each. Reranking 50 candidates
 * for one resume ≈ $0.005, query-time only (never on the 70k index).
 */

export const RERANK_MODEL = process.env.RERANK_MODEL || 'gpt-4o-mini';

// Parallel chat-completions. gpt-4o-mini tier-1 is 500 RPM / 200k TPM; 6 keeps
// a 50-candidate rerank well under that while finishing in ~1-2s.
const RERANK_CONCURRENCY = Number(process.env.RERANK_CONCURRENCY || 6);
const RERANK_MAX_ATTEMPTS = Number(process.env.RERANK_MAX_ATTEMPTS || 4);
const RERANK_RETRY_BASE_MS = Number(process.env.RERANK_RETRY_BASE_MS || 800);

// Reasoning models (gpt-5*, o*) reject `temperature` and need
// `max_completion_tokens` plus headroom for hidden reasoning tokens. We default
// to gpt-4o-mini, but honour RERANK_MODEL overrides without breaking the call.
const isReasoning = (m) => /^(gpt-5|o\d)/.test(m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Validated in the bake-off. Skills first, then seniority, then domain.
const FIT_SYSTEM = `You are a meticulous senior technical recruiter. Score how well a candidate's resume matches a job posting on a 0-100 scale: 100 = ideal hire you would fast-track, 0 = unrelated. Weigh required-skills overlap most, then seniority alignment, then domain/role relevance. Ignore location and compensation. Reply with ONLY an integer 0-100.`;

export function isEnabled() {
  // On by default when a key is present; RERANK_ENABLED=0/false/no opts out.
  if (/^(0|false|no)$/i.test(process.env.RERANK_ENABLED || '')) return false;
  return Boolean(process.env.OPENAI_API_KEY);
}

function fitPrompt(resumeText, job) {
  const body = `${job.title || ''}\n${job.description_summary || ''}`.trim();
  return `RESUME:\n${resumeText}\n\nJOB POSTING:\n${body}\n\nFit score (0-100):`;
}

// Returns an integer 0-100, or null if the call permanently fails or the reply
// can't be parsed. Retries transient (429/5xx/network) errors with backoff.
async function scoreOne(resumeText, job, model) {
  const body = { model, messages: [{ role: 'system', content: FIT_SYSTEM }, { role: 'user', content: fitPrompt(resumeText, job) }] };
  if (isReasoning(model)) body.max_completion_tokens = 2000;
  else { body.temperature = 0; body.max_tokens = 8; }

  for (let attempt = 1; attempt <= RERANK_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      if (attempt === RERANK_MAX_ATTEMPTS) return null;
      await sleep(RERANK_RETRY_BASE_MS * 2 ** (attempt - 1) * Math.random());
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt === RERANK_MAX_ATTEMPTS) return null;
      const retryAfter = Number(res.headers.get('retry-after')) * 1000 || 0;
      await sleep(Math.max(retryAfter, RERANK_RETRY_BASE_MS * 2 ** (attempt - 1) * Math.random()));
      continue;
    }
    if (!res.ok) return null; // 4xx other than 429 — permanent, don't retry
    const data = await res.json().catch(() => null);
    const raw = (data?.choices?.[0]?.message?.content || '').trim();
    const n = parseInt(raw.match(/\d+/)?.[0] ?? '', 10);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
  }
  return null;
}

// Bounded-concurrency map preserving input order.
async function mapPool(items, fn, concurrency) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

/**
 * Rerank cosine-retrieved candidates by LLM fit score and return the top-K.
 *
 * @param {string} resumeText  The resume in the same labelled form embed-resume
 *                             builds (title + signals + 14-field summary).
 * @param {object[]} candidates  Cosine-ordered rows from match_resume_candidates
 *                               (need at least title + description_summary).
 * @param {object} [opts]
 * @param {number} [opts.topK]  How many to return (default: all).
 * @param {string} [opts.model] Override RERANK_MODEL.
 * Returns rows annotated with `rerank_score` (0-100, or null on failure),
 * sorted best-first. On total failure / disabled, returns the original cosine
 * order (top-K) with rerank_score=null — matching never breaks.
 */
export async function rerankCandidates(resumeText, candidates, { topK = candidates.length, model = RERANK_MODEL, concurrency = RERANK_CONCURRENCY } = {}) {
  if (!isEnabled() || !resumeText || !candidates?.length) {
    return candidates.slice(0, topK).map((c) => ({ ...c, rerank_score: null }));
  }

  const scores = await mapPool(candidates, (job) => scoreOne(resumeText, job, model), concurrency);
  const failed = scores.filter((s) => s == null).length;
  if (failed) console.warn(`rerank: ${failed}/${candidates.length} candidates failed to score; they fall back to cosine order`);

  // Annotate, then sort by rerank_score desc. Failures (null) sort to the
  // bottom but keep their relative cosine order via the stable index tiebreak,
  // so a partial failure degrades gracefully instead of dropping good matches
  // unpredictably. If everything failed, this preserves the cosine order.
  const annotated = candidates.map((c, i) => ({ ...c, rerank_score: scores[i], _i: i }));
  annotated.sort((a, b) => (b.rerank_score ?? -1) - (a.rerank_score ?? -1) || a._i - b._i);
  return annotated.slice(0, topK).map(({ _i, ...row }) => row);
}
