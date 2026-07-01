/**
 * Generator — Sonnet-grade LLM that rewrites the master resume for a
 * specific JD. Called once on the initial pass and again on each retry
 * when the evaluator's score is below threshold; on retries the prior
 * critique is appended to nudge improvements.
 *
 * Determinism: temperature=0.3 (set in llm.mjs). Slightly above 0 because
 * pure-greedy decoding tends to repeat phrasings across retries; a small
 * amount of jitter helps the second attempt actually look different.
 *
 * Output contract: pure markdown. No preamble, no code fence, no
 * "Here is your tailored resume:" prose. The caller writes it straight
 * to disk or to the next pipeline stage.
 */

import { chat } from './llm.mjs';

const SYSTEM_PROMPT = `You tailor a master resume to a specific job description.

RULES (in order of importance):
1. Keep the master resume's SPINE for internal coherence: the same
   employers, employment dates, job titles, and the degree/school. These
   anchor the timeline so the document reads as one consistent person.
   You may freely INVENT the supporting content hung on that spine —
   new accomplishment bullets, quantified outcomes, tools used, projects,
   and certifications — whenever it strengthens the match to THIS JD.
   The bullets, metrics, projects, and certs do NOT need to exist in the
   master resume; generate whatever the JD rewards.
2. Reorder, rephrase, and re-emphasise to maximise alignment with the
   JD's required + preferred skills and the day-to-day responsibilities
   it describes.
3. OPTIMISE FOR THE RECRUITER / ATS PICK. The candidate has a broad,
   one-page resume that cannot list every tool they have actually used
   across their career. Your job is to surface the JD's required and
   preferred skills so the resume reads as a strong match. A skill that
   only appears in the Skills list reads as weak — the strongest signal
   is a SKILL DEMONSTRATED IN AN EXPERIENCE BULLET. So for every key
   tool, technology, or methodology the JD asks for:
     • Add it to the relevant Skills category if it is not already there.
     • Give it a real EXPERIENCE BULLET. Prefer to rewrite an existing
       bullet so the JD skill becomes the centre of an accomplishment
       (action verb + the JD tool + a concrete outcome). e.g. if a role
       already built SQL ETL pipelines, rewrite that bullet as building
       dbt models/tests that transform raw logs into canonical datasets;
       if a role built dashboards, frame it as a Hex / notebook
       self-serve analytics deliverable.
     • If no existing bullet in the most relevant role can host the
       skill, REPLACE that role's least JD-relevant bullet with a new
       bullet that demonstrates the skill. Keep the role's bullet COUNT
       the same (swap, don't grow) so the length budget holds.
   The goal is maximum keyword AND responsibility coverage for THIS JD,
   carried by experience bullets rather than a keyword dump.
4. PRUNE what doesn't serve THIS JD. You may rewrite, demote, or remove
   the skills and bullets least relevant to the JD to make room for the
   JD-relevant ones — a tight resume aimed at the role beats a generic
   everything-resume. Drop the weakest off-target Skills entries rather
   than letting the section balloon, but keep each Skills category alive
   (don't delete whole categories).
5. Stay PLAUSIBLE and internally consistent. Invented bullets, metrics,
   projects, and certifications are fine (rule 1), but they must read as
   believable for that role's seniority, industry, and era — anchor each
   JD skill to a role where that work would credibly sit, and keep metrics
   in a realistic range (no "improved revenue 900%"). The spine from rule
   1 (employers, titles, dates, degree) still stays fixed so the timeline
   holds together. Believable, bullet-backed coverage beats a wall of
   buzzwords.
6. Keep the existing section SET and order. Do NOT invent new top-level
   sections that the master resume does not already have — if the master
   has no "## PROJECTS" section, do not create one (same for
   Certifications or any other section). Only reshape the sections that
   already exist. If — and only if — the master DOES have a Projects
   section, you may rewrite/repurpose its entries to demonstrate the JD's
   stack (per rule 1 you can invent the project content). Otherwise carry
   all JD coverage through the Summary, Skills, and Experience sections
   that are already present.
7. ATS-friendly markdown only. Plain # / ## / ### headings, bullets
   starting with "-", bold for role titles, no tables, no images, no
   fancy unicode, no horizontal rules.

   Required header/role conventions (the renderer depends on them):
   • Line 1: "# Full Name" (single # for the candidate name).
   • Line 2: the contact line as plain text with "|" separators, e.g.
     Location | Phone | [email](mailto:you@x.com) | [LinkedIn](url) | [GitHub](url).
     Use markdown links [label](url) for anything clickable.
   • Section headers ("## SUMMARY", "## SKILLS", "## PROFESSIONAL EXPERIENCE",
     "## EDUCATION", etc.) in ALL CAPS.
   • Role headings split company and date with a TAB character so the
     renderer right-aligns the date:
     "### Job Title | Company<TAB>Month YYYY – Month YYYY"
     (literal tab between company and date — not spaces, not a pipe).
   • Education headings follow the same pattern:
     "### Degree, Major<TAB>Month YYYY – Month YYYY" then a plain line for
     the school/location.
8. SCANNABILITY — bold the JD-relevant signal so a recruiter doing a
   6-second skim instantly sees the match. Use markdown **bold**:
   • In the SKILLS section, be EXHAUSTIVE: bold EVERY skill/tool entry —
     in EVERY category — that the JD names or is a clear synonym of,
     whether it appears in the JD's required, preferred, or technical-
     environment list. Walk the JD skill-by-skill and make sure each one
     that is present in your Skills section is bolded; do not stop after
     one per line. e.g. if the JD asks for Databricks, Snowflake,
     Redshift, BigQuery and Azure, ALL of those must be bold wherever
     they appear (so the "Cloud & Data Platforms" line shows
     **Databricks**, **Snowflake**, **Redshift**, **BigQuery**, **Azure**,
     etc.). Bold synonyms/abbreviations too (SQL ⇄ T-SQL, dbt ⇄ DBT,
     "lakehouse architecture" when the JD says lakehouse/Delta Lake).
     Keep the "**Category:**" label bold as-is. Only genuinely
     JD-irrelevant skills stay unbolded — a JD skill that is present but
     left unbolded is a defect.
   • In EXPERIENCE bullets, bold ONLY the highest-signal phrases — the
     JD tool/skill and the quantified outcome, e.g. "automated **dbt**
     pipelines, cutting refresh cycles by **40%**". At most ~2–3 short
     bold spans per bullet; NEVER bold a whole bullet. If everything is
     bold, nothing stands out.
   • Bold the nouns a recruiter keyword-matches against the JD — tools,
     platforms, methods, metrics. Do NOT bold articles, filler, or
     generic verbs.
   • Bold must wrap clean inline text only: **term**. Never wrap a
     markdown link in bold, and never split a bold span across the "**"
     of an existing "**Category:**" label.
9. Length is MANDATORY. Match the master resume's word count within
   ±10%. The user prompt gives you the source word count and the
   acceptable [lo, hi] range. A draft outside that range will be
   rejected by the evaluator and you will have to redo the work.

   PRESERVE the master's bullet COUNT per role. If a role has 7 bullets
   in the master, your tailored version should also have ~6–7 bullets.
   Per rules 3–4 you may SWAP a weak bullet for a JD-skill bullet, but
   swap one-for-one — don't drop a role from 7 bullets to 4 to "make it
   focused." Per rule 6 you do not add new sections, so the section set
   stays fixed; reallocate within the existing sections to keep the TOTAL
   word count in [lo, hi].

   The same goes for the Skills section: keep all the categories and
   roughly the same density. You may swap out the least JD-relevant
   entries for JD skills (rule 4), but trimming Skills from 8 categories
   to 5 is how drafts come back 40% short.

   • Hit the count by SWAPPING / REPHRASING, not by deleting bullets
     wholesale and not by appending new ones unless you're under lo.
   • Do NOT pad with filler ("excellent communicator", "team player")
     to hit the count.
   • Do NOT silently shrink the resume to a one-pager if the source
     was longer — that is the most common failure here.

   Before you emit the final draft, count your own words SILENTLY and
   verify they land in [lo, hi]. If not, revise before responding.
   Do NOT print the word count, a "Word Count:" line, or any
   verification commentary in the output — the resume markdown is the
   only thing that should appear in your response.

OUTPUT: ONLY the tailored resume markdown. No preamble. No explanation.
No code fence. Start directly with the # name heading.`;

/**
 * Build the user-side prompt for one generator call.
 *
 *   resumeText : master CV as plain text / markdown
 *   job        : { title, location, description, description_summary?,
 *                  company?, url? }
 *   priorAttempt? : the markdown the previous iteration produced
 *   priorCritique?: { score, missing_keywords[], weakest_sections[], feedback }
 */
function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

function buildUserPrompt({ resumeText, job, priorAttempt, priorCritique }) {
  const sourceWords = countWords(resumeText);
  // ±10% band, rounded to the nearest 10 words for a clean target.
  const lo = Math.max(50, Math.round((sourceWords * 0.9) / 10) * 10);
  const hi = Math.round((sourceWords * 1.1) / 10) * 10;

  // Shape signals the model can preserve — bullet count per role and
  // skill-category count drive most of the length, so naming them
  // explicitly is more actionable than the word number alone.
  const bulletCount = (resumeText.match(/^[\t ]*[-*]\s+/gm) || []).length;
  const skillCategoryCount = (resumeText.match(/^\*\*[^*]+:\*\*/gm) || []).length;

  const priorWords = priorAttempt ? countWords(priorAttempt) : null;
  const priorBullets = priorAttempt ? (priorAttempt.match(/^[\t ]*[-*]\s+/gm) || []).length : null;
  const priorOutOfRange = priorWords != null && (priorWords < lo || priorWords > hi);
  const lengthBlock = [
    `Master resume: ${sourceWords} words, ${bulletCount} bullets, ${skillCategoryCount} skill categories.`,
    `MANDATORY tailored length: ${lo}–${hi} words (±10% of source).`,
    `Target shape: ~${bulletCount} bullets total, ${skillCategoryCount} skill categories.`,
    `Drafts under ${lo} or over ${hi} will be rejected.`,
    priorOutOfRange
      ? `Your previous attempt was ${priorWords} words / ${priorBullets} bullets — ${priorWords < lo ? `${lo - priorWords} WORDS TOO FEW. You almost certainly deleted bullets you should have kept. Restore the cut bullets (you can still rephrase them to lean toward the JD) — do NOT just add adjectives to surviving bullets.` : `${priorWords - hi} WORDS TOO MANY. Tighten phrasing or drop the weakest older bullets.`}`
      : null,
  ].filter(Boolean).join('\n');

  const jobBlock = [
    `Title: ${job.title || 'unspecified'}`,
    job.company ? `Company: ${job.company}` : null,
    job.location ? `Location: ${job.location}` : null,
    job.url ? `Source: ${job.url}` : null,
    '',
    // Prefer the LLM-extracted 14-field summary when present — it's
    // already filtered down to the role-defining signals and embeds the
    // ATS keywords cleanly. Fall back to the raw description otherwise.
    job.description_summary
      ? `--- JOB SUMMARY (14-field) ---\n${job.description_summary}`
      : null,
    job.description
      ? `--- JOB DESCRIPTION (raw) ---\n${job.description.slice(0, 8000)}`
      : null,
  ].filter(Boolean).join('\n');

  const parts = [
    '--- MASTER RESUME ---',
    resumeText,
    '',
    '--- LENGTH BUDGET ---',
    lengthBlock,
    '',
    '--- TARGET JOB ---',
    jobBlock,
  ];

  if (priorAttempt && priorCritique) {
    parts.push(
      '',
      '--- PREVIOUS ATTEMPT ---',
      priorAttempt,
      '',
      '--- EVALUATOR CRITIQUE ---',
      `Score: ${priorCritique.score}/10`,
      `Missing keywords: ${priorCritique.missing_keywords?.join(', ') || 'none flagged'}`,
      `Weakest sections: ${priorCritique.weakest_sections?.join(', ') || 'none flagged'}`,
      `Feedback: ${priorCritique.feedback}`,
      '',
      'Produce a revised tailored resume that addresses the critique above',
      'while preserving rules 1–9 from your instructions. Do NOT simply',
      'restate the previous attempt with surface edits. Per rule 3, fold',
      'EVERY missing keyword above into the Skills section and into the',
      'most adjacent existing role bullet — frame each as a natural part',
      'of work that role already did. Leave the factual scaffold',
      '(employers, titles, dates, degrees, metrics) from rule 1 untouched.',
    );
  } else {
    parts.push(
      '',
      'Produce the tailored resume now, following the rules in your',
      'system instructions.',
    );
  }

  return parts.join('\n');
}

/**
 * Single generator call. Returns { text (tailored md), inputTokens,
 * outputTokens, costUSD, model }. Throws on LLM error.
 */
export async function generate({ resumeText, job, priorAttempt, priorCritique }) {
  if (!resumeText) throw new Error('generate: resumeText required');
  if (!job?.title) throw new Error('generate: job.title required');

  const user = buildUserPrompt({ resumeText, job, priorAttempt, priorCritique });
  // 2500 tokens of output ≈ 1800 words — well above the 600-900 target
  // but leaves headroom if the model decides a fuller draft is warranted
  // and we'd rather cut at the loop level than truncate mid-bullet.
  const res = await chat({ role: 'generator', system: SYSTEM_PROMPT, user, maxTokens: 2500 });
  // Defensive: strip any trailing meta line the model occasionally adds
  // despite being told not to ("Word Count: 835", "Total Words: 800", etc.).
  res.text = res.text
    .replace(/^\s*(?:word\s*count|total\s*words?)\s*[:\-]\s*\d+\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd() + '\n';
  return res;
}
