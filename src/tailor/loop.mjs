/**
 * Generator → Evaluator → maybe-retry loop. The whole tailor v1 (f-402).
 *
 * Stop conditions (whichever comes first):
 *   - evaluator score >= threshold (default 9)
 *   - attempts == maxAttempts (default 5 → 1 initial + 4 retries)
 *
 * Returns the winning draft + all per-attempt records so the CLI can show
 * the score progression and the user can decide whether the result is
 * good enough to actually use.
 *
 * The loop is the resilience boundary — generator.mjs and evaluator.mjs
 * do not retry on transient errors. If an LLM call throws, we record the
 * error and try one more time at the loop level (single bounce). After
 * that we surface the failure to the caller.
 */

import { generate } from './generator.mjs';
import { evaluate } from './evaluator.mjs';

const DEFAULT_THRESHOLD = 9;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * tailor({ resumeText, job, threshold?, maxAttempts?, onProgress? })
 *
 * Returns:
 *   {
 *     winner: { attempt, tailoredMarkdown, score, critique, costUSD },
 *     attempts: [ { attempt, tailoredMarkdown, score, critique,
 *                   generatorCostUSD, evaluatorCostUSD, durationMs }, ... ],
 *     totalCostUSD,
 *     totalCalls,           // generator + evaluator calls combined
 *     stopReason: 'threshold' | 'max-attempts' | 'error',
 *     error?: Error,        // present only when stopReason === 'error'
 *   }
 *
 * onProgress (optional): called after each attempt with the attempt record.
 * Lets the CLI stream live updates instead of waiting for the whole loop.
 */
export async function tailor({
  resumeText,
  job,
  threshold = DEFAULT_THRESHOLD,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  onProgress,
}) {
  if (!resumeText) throw new Error('tailor: resumeText required');
  if (!job?.title) throw new Error('tailor: job.title required');

  // Source word count drives the evaluator's length gate. Computed once
  // since the master resume doesn't change across attempts.
  const sourceWords = (resumeText.match(/\S+/g) || []).length;

  const attempts = [];
  let priorAttempt = null;
  let priorCritique = null;
  let stopReason = 'max-attempts';
  let loopError = null;

  for (let i = 1; i <= maxAttempts; i++) {
    const startedAt = Date.now();
    let genRes, evalRes;

    try {
      genRes = await generate({ resumeText, job, priorAttempt, priorCritique });
    } catch (e) {
      // One bounce: retry the generator once if the first call throws.
      // Real outages should bubble up; this only catches the transient
      // 429/5xx blip that's recoverable in a single re-try.
      console.error(`[tailor] generator attempt ${i} failed: ${e.message} — retrying once`);
      try {
        genRes = await generate({ resumeText, job, priorAttempt, priorCritique });
      } catch (e2) {
        loopError = e2;
        stopReason = 'error';
        break;
      }
    }

    try {
      evalRes = await evaluate({ tailoredMarkdown: genRes.text, job, sourceWords });
    } catch (e) {
      console.error(`[tailor] evaluator attempt ${i} failed: ${e.message} — retrying once`);
      try {
        evalRes = await evaluate({ tailoredMarkdown: genRes.text, job, sourceWords });
      } catch (e2) {
        // The evaluator (a reasoning model) intermittently returns an empty
        // body. Don't let one bad score abort the whole run — record the
        // unscored draft and move on so the remaining attempts still get a
        // shot at the threshold. priorAttempt/priorCritique are left as-is
        // so the next generate() still iterates on the last good critique.
        loopError = e2;
        console.error(`[tailor] evaluator attempt ${i} unscored after retry: ${e2.message} — skipping to next attempt`);
        attempts.push({
          attempt: i,
          tailoredMarkdown: genRes.text,
          score: null,
          critique: null,
          generatorCostUSD: genRes.costUSD,
          evaluatorCostUSD: 0,
          durationMs: Date.now() - startedAt,
          error: e2.message,
        });
        continue;
      }
    }

    const record = {
      attempt: i,
      tailoredMarkdown: genRes.text,
      score: evalRes.score,
      critique: {
        missing_keywords: evalRes.missing_keywords,
        weakest_sections: evalRes.weakest_sections,
        feedback: evalRes.feedback,
      },
      generatorCostUSD: genRes.costUSD,
      evaluatorCostUSD: evalRes.costUSD,
      generatorModel: genRes.model,
      evaluatorModel: evalRes.model,
      durationMs: Date.now() - startedAt,
    };
    attempts.push(record);
    if (onProgress) onProgress(record);

    if (evalRes.score >= threshold) {
      stopReason = 'threshold';
      break;
    }

    // Set up the next iteration's retry context.
    priorAttempt = genRes.text;
    priorCritique = {
      score: evalRes.score,
      missing_keywords: evalRes.missing_keywords,
      weakest_sections: evalRes.weakest_sections,
      feedback: evalRes.feedback,
    };
  }

  // Winner = the highest-scoring attempt. Falls back to last attempt if
  // every score is null (evaluator broke on every attempt).
  const scored = attempts.filter((a) => typeof a.score === 'number');
  const winner = scored.length
    ? scored.reduce((best, cur) => (cur.score > best.score ? cur : best))
    : attempts[attempts.length - 1];

  // Only a true failure if we never managed to score a single draft. If at
  // least one attempt scored, an evaluator hiccup on another attempt is not
  // fatal — clear the carried error so the CLI ships the best scored draft.
  if (scored.length) {
    loopError = null;
  } else if (loopError) {
    stopReason = 'error';
  }

  const totalCostUSD = attempts.reduce(
    (s, a) => s + (a.generatorCostUSD || 0) + (a.evaluatorCostUSD || 0),
    0,
  );
  // Each attempt = 1 generator + 1 evaluator call (unless evaluator failed,
  // in which case still 1 generator call was made).
  const totalCalls = attempts.reduce(
    (s, a) => s + 1 + (a.score !== null ? 1 : 0),
    0,
  );

  return {
    winner: {
      attempt: winner.attempt,
      tailoredMarkdown: winner.tailoredMarkdown,
      score: winner.score,
      critique: winner.critique,
      costUSD: (winner.generatorCostUSD || 0) + (winner.evaluatorCostUSD || 0),
    },
    attempts,
    totalCostUSD,
    totalCalls,
    stopReason,
    error: loopError,
  };
}
