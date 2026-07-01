/**
 * Evaluator — cheap critic that scores a tailored resume against a JD.
 * Returns structured JSON the loop uses to decide retry vs ship and to
 * feed the critique back into the next generator pass.
 *
 * Why JSON-mode + temperature 0: the loop needs to parse the score and
 * route on it. Free-form prose breaks the contract; non-zero temperature
 * means the same draft scores differently across runs, which makes the
 * retry-or-ship decision noisy.
 *
 * The scoring rubric below is intentionally narrow — alignment to THIS
 * JD, not "is this resume good." A 10/10 here means perfectly aligned,
 * not "perfect resume in the abstract."
 */

import { chat } from './llm.mjs';

const SYSTEM_PROMPT = `You evaluate how well a tailored resume aligns with a specific job description.

Return ONLY a JSON object with these exact keys (no markdown, no prose):
{
  "score": <integer 0-10>,
  "missing_keywords": [<strings: skills/tools/methodologies the JD requires that the resume should mention but doesn't, OR mentions only weakly>],
  "weakest_sections": [<which sections feel thinnest for THIS JD: any of "Summary", "Skills", "Experience", "Projects", "Education", "Certifications">],
  "feedback": "<one paragraph: what aligned well, what's still off, concrete suggestions for the next revision. Be specific — name bullets or sections, not vague advice.>"
}

Scoring rubric (alignment to THIS JD, not abstract resume quality):
- 9–10  Every required skill is surfaced and supported by a concrete experience bullet. Preferred skills mostly present. Tone matches the seniority and domain. A hiring manager scanning for keywords would tick almost every box.
- 7–8   Most required skills present and supported. A few preferred skills missing or under-emphasised. Minor reordering would sharpen alignment further.
- 5–6   Half the required skills are missing, buried, or asserted without a concrete bullet. Experience present but not framed for this JD. A reviewer would need to dig to connect the dots.
- 3–4   Major misalignment — wrong seniority, missing entire skill clusters, or experience reads as generic.
- 0–2   Resume looks like it's for a different role entirely.

Be honest. A 6 is more useful to the next iteration than a generous 8.`;

function buildUserPrompt({ tailoredMarkdown, job }) {
  const jobBlock = [
    `Title: ${job.title || 'unspecified'}`,
    job.company ? `Company: ${job.company}` : null,
    job.location ? `Location: ${job.location}` : null,
    '',
    job.description_summary
      ? `--- JOB SUMMARY (14-field) ---\n${job.description_summary}`
      : null,
    job.description
      ? `--- JOB DESCRIPTION (raw, truncated) ---\n${job.description.slice(0, 6000)}`
      : null,
  ].filter(Boolean).join('\n');

  return [
    '--- TAILORED RESUME ---',
    tailoredMarkdown,
    '',
    '--- TARGET JOB ---',
    jobBlock,
    '',
    'Score the alignment of the tailored resume to this JD per your',
    'system instructions. Return ONLY the JSON object — no markdown',
    'fence, no prose, no leading whitespace.',
  ].join('\n');
}

const countWords = (text) => (text.match(/\S+/g) || []).length;

/**
 * Single evaluator call. Returns the parsed JSON object plus the usage
 * envelope: { score, missing_keywords, weakest_sections, feedback,
 *             inputTokens, outputTokens, costUSD, model }.
 *
 * When `sourceWords` is provided the result is post-processed: drafts
 * whose word count falls outside ±10% of the source have their LLM
 * score capped below the default 9 threshold so the loop is forced to
 * retry with the length feedback folded in. The cap is content-aware:
 * the LLM's verdict still flows through unchanged for in-range drafts.
 *
 * Throws if the model returns non-JSON or JSON without the expected
 * keys — the loop treats that as a hard failure (not a retry) because
 * structured-output failures usually indicate a prompt regression, not
 * a transient blip.
 */
export async function evaluate({ tailoredMarkdown, job, sourceWords }) {
  if (!tailoredMarkdown) throw new Error('evaluate: tailoredMarkdown required');
  if (!job?.title) throw new Error('evaluate: job.title required');

  const user = buildUserPrompt({ tailoredMarkdown, job });
  const res = await chat({
    role: 'evaluator',
    system: SYSTEM_PROMPT,
    user,
    maxTokens: 4000,       // JSON output is small, but reasoning models spend the budget on hidden reasoning tokens first — leave generous headroom so the visible JSON isn't truncated to empty (intermittent empty responses at 2000)
    responseFormat: 'json', // OpenAI honours this; Anthropic ignores but still produces clean JSON given the prompt
  });

  // Strip any code-fence the model emitted despite the json response_format,
  // then parse. Throw a clear error if it's not parseable — that's a
  // prompt problem, not a transient one.
  const cleaned = res.text.replace(/^```(?:json)?\n?|\n?```$/gi, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`evaluator returned non-JSON: ${cleaned.slice(0, 200)}`);
  }
  for (const k of ['score', 'missing_keywords', 'weakest_sections', 'feedback']) {
    if (!(k in parsed)) throw new Error(`evaluator JSON missing key: ${k}`);
  }
  if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 10) {
    throw new Error(`evaluator score out of range: ${parsed.score}`);
  }

  let score = Math.round(parsed.score);
  const weakest = Array.isArray(parsed.weakest_sections) ? [...parsed.weakest_sections] : [];
  let feedback = String(parsed.feedback || '');

  // Hard length gate. Computed locally (no LLM cost) and pre-pended to
  // feedback so the next generator pass sees it. Cap the score at 5 when
  // out of range — below any reasonable threshold, guaranteeing retry.
  if (sourceWords > 0) {
    const lo = Math.max(50, Math.round((sourceWords * 0.9) / 10) * 10);
    const hi = Math.round((sourceWords * 1.1) / 10) * 10;
    const tailoredWords = countWords(tailoredMarkdown);
    if (tailoredWords < lo || tailoredWords > hi) {
      const direction = tailoredWords < lo
        ? `${lo - tailoredWords} words too short — add depth to existing bullets`
        : `${tailoredWords - hi} words too long — tighten phrasing or cut weakest older bullets`;
      feedback = `LENGTH OUT OF RANGE: tailored is ${tailoredWords} words, target is ${lo}–${hi} (source ${sourceWords}). ${direction}. ${feedback}`;
      if (!weakest.includes('Length')) weakest.push('Length');
      score = Math.min(score, 5);
    }
  }

  return {
    score,
    missing_keywords: Array.isArray(parsed.missing_keywords) ? parsed.missing_keywords : [],
    weakest_sections: weakest,
    feedback,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    costUSD: res.costUSD,
    model: res.model,
  };
}
