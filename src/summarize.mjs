/**
 * LLM-extracted job-description summary, for the resume-matching pipeline
 * and natural-language search.
 *
 * Why this exists: raw job descriptions are ~3-8KB of mostly company
 * marketing, mission statements, and EEO boilerplate. Embedding them
 * directly via text-embedding-3-small means the 1500-char window we
 * reserve for description gets eaten by "About Us" and clips before
 * the actual role specifics. This module asks gpt-4o-mini to extract
 * a multi-field structured precis covering role, level, experience,
 * required + preferred skills, team, industry, company stage, location,
 * remote policy, compensation, benefits, visa, and schedule — every
 * dimension a user might phrase a natural-language query around.
 *
 * The expanded field set vs. the original 4-line schema (Role/Skills/
 * Experience/Industry) trades ~$0.0001 per posting for much broader
 * query coverage: "remote senior backend at a fintech startup with equity
 * and visa sponsorship" now has token-level matches against every clause.
 *
 * Cost: gpt-4o-mini at $0.15/M input + $0.60/M output tokens. A typical
 * posting is ~750 input tokens, ~200 output tokens → ~$0.00023/job.
 * 46k backfill ≈ $10.50; recurring scan cost ≈ $0.23 per 1000 new postings.
 *
 * Failures are non-fatal — the caller writes `description_summary_at`
 * with whatever we got (text or null) and moves on. The embedder falls
 * back to the raw description when summary is null, so coverage gaps
 * just slightly degrade rather than break matching.
 */

import { update } from './supabase-client.mjs';
import { openaiChatUrl, aiGatewayHeaders } from './observability.mjs';

export const SUMMARY_MODEL = 'gpt-4o-mini';

// How long a description we'll feed to the model. gpt-4o-mini's context
// is 128k tokens; we cap at 10000 chars (~2500 tokens) to keep cost
// predictable. Slightly wider than the original 8000 because benefits /
// visa / schedule sections often live in the back half of the posting,
// and missing them shows up directly as "unknown" fields in the summary.
const DESCRIPTION_INPUT_CAP = 10000;

// Parallel chat-completions are the throughput knob (chat completions
// have no batch endpoint like embeddings do). Default 5 is conservative
// for tier-1 (500 RPM / 200k TPM on gpt-4o-mini); bump via env on higher
// tiers. 10 was the previous default and bit us with 429s on a 20k
// backfill — better to be slow than to retry storms.
const SUMMARIZE_CONCURRENCY = Number(process.env.SUMMARIZE_CONCURRENCY || 5);

// Retry policy for transient OpenAI failures (429 rate-limited, 5xx,
// network blip). Each retry waits at least RETRY_BASE_MS * 2^attempt
// with full jitter, OR `Retry-After` from the response, whichever is
// longer. Permanent failures (4xx other than 429, content-filter) skip
// retry and surface immediately so callers can mark the row "permanent
// fail" and stop wasting API spend on it.
const SUMMARIZE_MAX_ATTEMPTS = Number(process.env.SUMMARIZE_MAX_ATTEMPTS || 5);
const SUMMARIZE_RETRY_BASE_MS = Number(process.env.SUMMARIZE_RETRY_BASE_MS || 1_000);

// Returned from summarizeText to distinguish "tried and definitively
// failed, mark the row as done so we don't try again" from "transient
// error, leave description_summary_at null so the next run retries."
export const TRANSIENT_FAILURE = Symbol('summarize.transient');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Prompt is fixed and kept here (not in env) so the same input
// deterministically produces the same summary across deploys. If we
// change the prompt we should also bump a version marker and re-run
// the backfill; today that's a manual operation.
//
// Format choice: `Key: value` lines, one per dimension. Each fact becomes
// its own dense token group that the embedder associates cleanly —
// short labeled phrases embed more efficiently than prose. Field set
// is intentionally broad so natural-language queries like "remote senior
// backend at a fintech startup with equity and visa sponsorship" have
// token-level matches against every clause.
//
// What's NOT here: numeric comp filters (use jobs.comp_min/comp_max
// columns — embeddings are bad at numeric ranges). The Compensation
// field captures qualitative signal — equity, bonus, stated ranges —
// only to help free-text queries like "jobs with equity."
const SYSTEM_PROMPT = `You extract structured, search-friendly summaries from job postings.
Reply with EXACTLY these labeled lines, in this order, no preamble, no markdown, no blank lines:

Role: <one sentence on the actual day-to-day work>
Level: <intern / junior / mid / senior / staff / principal / lead / manager / director / vp; note IC vs manager track if clear>
Experience: <years of experience required, e.g. "5+ years"; "unknown" if not stated>
Required skills: <8-15 comma-separated keywords — must-have technologies, languages, frameworks, tools, methodologies>
Preferred skills: <comma-separated keywords for "nice to have" / "bonus" items; "unknown" if not stated>
Team: <engineering / design / product / data / sales / marketing / operations / finance / legal / etc., plus team or function focus if mentioned>
Industry: <product domain or vertical — e.g. fintech, healthcare, dev tools, AI/ML, e-commerce, climate, security, gaming, biotech>
Company stage: <early-stage startup / scale-up / late-stage / public / enterprise / agency / unknown>
Location: <primary city or region named in the posting; "remote" if no city is given>
Remote policy: <remote / hybrid / onsite, plus geographic restrictions if stated (e.g. "US only", "EMEA timezone")>
Compensation: <qualitative notes: explicit ranges if stated, equity, bonus, signing; "unknown" if absent>
Benefits: <distinguishing perks worth searching for — equity, 401k match, healthcare, unlimited PTO, learning budget, parental leave, relocation, etc.; "unknown" if none mentioned>
Visa: <sponsorship policy if stated — e.g. "sponsors H1B", "no sponsorship", "EU work auth required"; "unknown" if absent>
Schedule: <full-time / part-time / contract / internship; default to "full-time" if not specified>

Skip company marketing, mission statements, "about us" prose, and EEO/diversity boilerplate.
If any field cannot be determined from the posting, write "unknown" for that value — never invent.`;

export function isEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Summarise one description. Returns:
 *   string             — success, the summary text
 *   null               — permanent failure (4xx other than 429, content
 *                        filter, empty response). Caller should record
 *                        the attempt so this row isn't retried forever.
 *   TRANSIENT_FAILURE  — exhausted retries on transient errors (429,
 *                        5xx, network). Caller should leave the row
 *                        un-marked so the next run picks it up.
 *
 * Always resolves — never throws.
 */
export async function summarizeText(description) {
  if (!description) return null;
  const trimmed = description.length > DESCRIPTION_INPUT_CAP
    ? description.slice(0, DESCRIPTION_INPUT_CAP)
    : description;

  let lastTransient = null;
  for (let attempt = 1; attempt <= SUMMARIZE_MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      // Routes via Cloudflare AI Gateway when AI_GATEWAY_URL is set (logs/cost/
      // cache — identical descriptions re-summarized after a fingerprint change
      // become cache hits instead of paid calls).
      res = await fetch(openaiChatUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          ...aiGatewayHeaders(),
        },
        body: JSON.stringify({
          model: SUMMARY_MODEL,
          temperature: 0,
          // 14 labeled lines at ~20-30 tokens each = ~300-400 output tokens.
          // 500 leaves headroom for long Skills lines without truncation;
          // we'd rather pay a fraction of a cent more than ship summaries
          // that cut off mid-keyword-list.
          max_tokens: 500,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: trimmed },
          ],
        }),
      });
    } catch (e) {
      // Network errors (DNS, TCP reset, our-side abort) are transient.
      lastTransient = `fetch ${e.message}`;
      await backoff(attempt);
      continue;
    }

    if (res.ok) {
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content?.trim();
      if (!text) return null; // permanent — model returned nothing usable
      // Strip stray markdown fences the model sometimes emits despite
      // the system prompt.
      return text.replace(/^```[a-z]*\n?|\n?```$/gi, '').trim() || null;
    }

    const body = await res.text();
    // 429 = rate-limited. 5xx = OpenAI hiccup. Both transient.
    if (res.status === 429 || res.status >= 500) {
      lastTransient = `${res.status}: ${body.slice(0, 120)}`;
      // Honour Retry-After when OpenAI specifies it; otherwise back off
      // exponentially. Whichever is larger wins.
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      await backoff(attempt, retryAfter);
      continue;
    }

    // 4xx other than 429: bad request, auth, content filter. Not
    // retriable — log and mark this row done so we stop spending on it.
    console.error(`summarize ${res.status}: ${body.slice(0, 200)}`);
    return null;
  }

  console.error(`summarize exhausted ${SUMMARIZE_MAX_ATTEMPTS} attempts (${lastTransient}); will retry on next run`);
  return TRANSIENT_FAILURE;
}

// retry-after may be either seconds (an integer) or an HTTP-date.
// OpenAI emits seconds. Return milliseconds or null.
function parseRetryAfter(header) {
  if (!header) return null;
  const sec = Number(header);
  if (Number.isFinite(sec) && sec >= 0) return Math.ceil(sec * 1000);
  const epoch = Date.parse(header);
  if (Number.isFinite(epoch)) return Math.max(0, epoch - Date.now());
  return null;
}

async function backoff(attempt, minMs = 0) {
  // Exponential with full jitter: 0..base, 0..2*base, 0..4*base, …
  // capped so attempt 5 isn't waiting a full minute.
  const cap = SUMMARIZE_RETRY_BASE_MS * 2 ** (attempt - 1);
  const jittered = Math.floor(Math.random() * cap);
  const delay = Math.max(jittered, minMs || 0);
  if (delay > 0) await sleep(delay);
}

/**
 * Summarise + persist a list of job rows. Each row needs { id, description }.
 * Writes description_summary, description_summary_model, description_summary_at.
 * Returns counts for logging.
 *
 * Concurrency: a fixed in-flight cap; rows finish in any order. PostgREST
 * handles the parallel PATCHes fine. Failure of one row never blocks
 * the rest of the batch.
 */
export async function summarizeAndPersistJobs(jobs, { onProgress } = {}) {
  let ok = 0;
  let failed = 0;       // permanent failures — row marked done, won't retry
  let transient = 0;    // 429/5xx exhausted retries — row left unmarked
  let inputCharsSeen = 0;

  // Simple sliding-window concurrency. We process jobs in chunks of
  // SUMMARIZE_CONCURRENCY, awaiting each chunk before starting the
  // next. Good enough for the scan-pass and backfill scenarios — the
  // bottleneck is OpenAI latency, not Node scheduling.
  for (let i = 0; i < jobs.length; i += SUMMARIZE_CONCURRENCY) {
    const slice = jobs.slice(i, i + SUMMARIZE_CONCURRENCY);
    await Promise.all(
      slice.map(async (row) => {
        inputCharsSeen += row.description?.length || 0;
        const summary = await summarizeText(row.description);

        // Transient failure: don't touch the row. description_summary_at
        // stays null, so the next backfill / scan pass picks it up. This
        // is the only branch that skips the UPDATE.
        if (summary === TRANSIENT_FAILURE) {
          transient++;
          return;
        }

        const isPermanentFail = summary === null;
        const now = new Date().toISOString();
        try {
          // Mark the attempt so permanent-failure rows (content filter,
          // empty response, etc.) aren't retried indefinitely. Successful
          // rows obviously get description_summary set; permanent fails
          // get description_summary_at without the actual summary so the
          // backfill query (description_summary_at IS NULL) skips them.
          await update(
            'jobs',
            { id: `eq.${row.id}` },
            {
              description_summary: summary,
              description_summary_model: summary ? SUMMARY_MODEL : null,
              description_summary_at: now,
            },
            { returning: 'minimal' },
          );
          if (summary) ok++;
          else if (isPermanentFail) failed++;
        } catch (e) {
          console.error(`summary write failed for job ${row.id}: ${e.message}`);
          failed++;
        }
      }),
    );
    if (onProgress) onProgress({ ok, failed, transient, total: jobs.length });
  }

  // gpt-4o-mini: $0.15/M input + $0.60/M output. ~chars/4 for input token
  // estimate; output is ~300 tokens per successful call with the expanded
  // 14-field schema, so we add a per-success output term. Approximate but
  // good enough for the log line ("how much did this run cost me").
  const inputCostUsd = (inputCharsSeen / 4 / 1_000_000) * 0.15;
  const outputCostUsd = (ok * 300 / 1_000_000) * 0.60;
  const costEstimateUsd = inputCostUsd + outputCostUsd;
  return { ok, failed, transient, inputCharsSeen, costEstimateUsd };
}
