/**
 * LLM-extracted job-description summary, for the resume-matching pipeline.
 *
 * Why this exists: raw job descriptions are ~3-8KB of mostly company
 * marketing, mission statements, and EEO boilerplate. Embedding them
 * directly via text-embedding-3-small means the 1500-char window we
 * reserve for description gets eaten by "About Us" and clips before
 * the actual role specifics. This module asks gpt-4o-mini to extract
 * a ~250-char structured precis (Role / Skills / Experience / Industry)
 * which then becomes the input to the embedder.
 *
 * Cost: gpt-4o-mini at $0.15/M input + $0.60/M output tokens. A typical
 * posting is ~600 input tokens, ~80 output tokens → ~$0.00014/job.
 * 46k backfill ≈ $6.50; recurring scan cost ≈ $0.14 per 1000 new postings.
 *
 * Failures are non-fatal — the caller writes `description_summary_at`
 * with whatever we got (text or null) and moves on. The embedder falls
 * back to the raw description when summary is null, so coverage gaps
 * just slightly degrade rather than break matching.
 */

import { update } from './supabase-client.mjs';

export const SUMMARY_MODEL = 'gpt-4o-mini';

// How long a description we'll feed to the model. gpt-4o-mini's context
// is 128k tokens; we cap at 8000 chars (~2000 tokens) to keep cost
// predictable and skip the tail of unusually long postings, which is
// almost always benefits / company values / EEO and adds no signal.
const DESCRIPTION_INPUT_CAP = 8000;

// Parallel chat-completions are the throughput knob (chat completions
// have no batch endpoint like embeddings do). OpenAI's per-org limits
// for gpt-4o-mini are generous — 10 in flight is well under tier-1.
const SUMMARIZE_CONCURRENCY = 10;

// Prompt is fixed and kept here (not in env) so the same input
// deterministically produces the same summary across deploys. If we
// change the prompt we should also bump a version marker and re-run
// the backfill; today that's a manual operation.
//
// Format choice: four `Key: value` lines so each fact becomes its own
// dense token group that the embedder can associate cleanly. Avoids
// prose, which the embedder weights less efficiently per token than
// short labeled phrases.
const SYSTEM_PROMPT = `You extract job-matching summaries from postings.
Reply with EXACTLY these four lines, no preamble, no markdown, no blank lines:

Role: <one sentence on the actual day-to-day work>
Skills: <8-15 comma-separated keywords — technologies, tools, languages, frameworks, methodologies>
Experience: <years required and seniority/specialization>
Industry: <product domain or industry vertical>

Skip company marketing, mission statements, benefits, perks, and EEO language.
If any field cannot be determined from the posting, write "unknown" for that line's value.`;

export function isEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * Summarise one description. Returns the summary text on success, null
 * on any failure (rate-limit, parse error, content-filter). Always
 * resolves — never throws.
 *
 * Caller is responsible for writing the result back; this function is
 * pure aside from its OpenAI fetch.
 */
export async function summarizeText(description) {
  if (!description) return null;
  const trimmed = description.length > DESCRIPTION_INPUT_CAP
    ? description.slice(0, DESCRIPTION_INPUT_CAP)
    : description;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: trimmed },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`summarize ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) return null;
    // Sanity check: the model occasionally adds markdown fences or a
    // preamble despite the system prompt. Strip leading ``` or whitespace.
    return text.replace(/^```[a-z]*\n?|\n?```$/gi, '').trim() || null;
  } catch (e) {
    console.error(`summarize fetch error: ${e.message}`);
    return null;
  }
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
  let failed = 0;
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
        const now = new Date().toISOString();
        try {
          // Always write description_summary_at so a permanently failing
          // row doesn't keep getting picked as a candidate forever (the
          // next-attempt logic in the backfill / scan pass relies on this).
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
          else failed++;
        } catch (e) {
          console.error(`summary write failed for job ${row.id}: ${e.message}`);
          failed++;
        }
      }),
    );
    if (onProgress) onProgress({ ok, failed, total: jobs.length });
  }

  // gpt-4o-mini: ~$0.15 per 1M input tokens. ~chars/4 for token estimate;
  // ignore output cost (~$0.60/M but only ~80 tokens per call, so the
  // input dominates by ~7x for our typical posting size).
  const costEstimateUsd = (inputCharsSeen / 4 / 1_000_000) * 0.15;
  return { ok, failed, inputCharsSeen, costEstimateUsd };
}
