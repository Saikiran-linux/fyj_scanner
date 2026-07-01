/**
 * Voyage AI embeddings client + helpers for the resume-matching feature.
 *
 * The scanner and the backfill script both pull rows lacking embeddings
 * and run them through this module. Embedding failures are non-fatal —
 * the caller logs and moves on; the next pass will retry.
 *
 * Model: voyage-4-large, truncated to 1024 dims via Matryoshka
 * (output_dimension). input_type='document' for job text — pairs with
 * the ops-console side embedding résumés/queries as input_type='query',
 * which is Voyage's recommended asymmetric-retrieval shape.
 */

import { update } from './supabase-client.mjs';

export const EMBEDDING_MODEL = 'voyage-4-large';
export const EMBEDDING_DIM = 1024;
// Voyage accepts up to 1000 texts per request; 100 keeps individual
// requests fast and limits the blast radius of a failure.
export const EMBED_BATCH_SIZE = 100;
// Parallel PATCHes when writing embeddings back. PostgREST handles this
// fine; tune up if you hit rate limits on the Supabase side.
const WRITE_CONCURRENCY = 10;

export function isEnabled() {
  return Boolean(process.env.VOYAGE_API_KEY);
}

// Truncate descriptions to ~1500 chars (~375 tokens) to keep embedding
// costs predictable — voyage-4-large's 120K-token context dwarfs this, but
// the first ~1500 chars of a job description carry the bulk of the semantic
// signal (role + responsibilities); boilerplate like benefits and EEO
// statements lives further down and would mostly add noise.
const DESCRIPTION_CHAR_LIMIT = 1500;

/**
 * Build the text we embed for a job row. Kept deterministic so the same
 * row always produces the same input — important if we ever want to detect
 * "content changed, re-embed."
 *
 * Layout: title, then a single block of `Key: value` lines for the
 * structured signals (seniority, workplace, compensation, employment
 * type, department, location), then the description. Putting the
 * structured signals BEFORE the truncated description matters — they're
 * the most filter-relevant signals for resume matching, and the
 * first-1500-chars cap on description often clips before hitting
 * "Responsibilities" anyway.
 *
 * Why bother embedding fields we also filter on in SQL?
 *   - A pure semantic search would miss "remote senior $200K backend" if
 *     none of those tokens appear in title+description.
 *   - Combining hard filters AND in-vector signal makes the ranking
 *     within filtered results sharper (the embedding can prefer the
 *     "actually remote remote" job over the "remote OK but office
 *     preferred" one when both pass the boolean filter).
 *   - It costs us nothing — these fields are ~50 tokens combined, well
 *     within the budget the description truncation reserves.
 */
export function buildJobText(job) {
  const parts = [job.title || ''];

  // Structured-signal block. Each line is `Key: value` so the embedder
  // can associate the label with the value (vs. a bare value floating
  // in the text). Skip any field that's null/empty — the line itself
  // would otherwise add a token without information.
  const signals = [];
  const seniority = extractSeniorityFromTitle(job.title);
  if (seniority) signals.push(`Seniority: ${seniority}`);
  if (job.remote) signals.push(`Workplace: ${job.remote}`);
  const comp = formatCompForEmbedding(job);
  if (comp) signals.push(`Compensation: ${comp}`);
  if (job.employment_type) signals.push(`Employment type: ${job.employment_type}`);
  if (job.department) signals.push(`Department: ${job.department}`);
  if (job.location) signals.push(`Location: ${job.location}`);
  if (signals.length) parts.push(signals.join('\n'));

  // Prefer the LLM-extracted summary when present — it's a dense,
  // structured 14-line precis (Role / Level / Experience / Required
  // skills / Preferred skills / Team / Industry / Company stage /
  // Location / Remote policy / Compensation / Benefits / Visa / Schedule)
  // that embeds far better than the raw description's "About Us /
  // mission / responsibilities" prose. Fall back to the truncated raw
  // description for rows the summarisation pass hasn't reached yet.
  // See src/summarize.mjs and the description_summary column in
  // supabase/schema.sql.
  if (job.description_summary) {
    // Summaries are already short (~600-800 chars) and structured; no
    // need to truncate. Embedding them verbatim preserves the labelled
    // Key: value structure the prompt produced, which the embedder picks
    // up on for query-side phrase matching.
    parts.push(job.description_summary);
  } else if (job.description) {
    const trimmed = job.description.length > DESCRIPTION_CHAR_LIMIT
      ? job.description.slice(0, DESCRIPTION_CHAR_LIMIT) + '…'
      : job.description;
    parts.push(trimmed);
  }
  return parts.join('\n\n');
}

/**
 * Pull a seniority label out of a job title when one is obvious. Returns
 * one of {'intern','junior','mid','senior','staff','principal','lead',
 * 'director','vp'} or null. We only match standalone words to avoid
 * false positives — "Junior Penetration Tester" hits, "Junior College
 * Tutor" hits too but that's fine; "Major Account Executive" does NOT
 * match "senior" just because "senior" appears in some account terms.
 *
 * Order matters: more-specific labels first (staff/principal beat
 * senior; intern beats everything because intern roles often have
 * "Engineer" too).
 */
export function extractSeniorityFromTitle(title) {
  if (!title) return null;
  const t = ` ${title.toLowerCase()} `;
  if (/\b(intern|internship)\b/.test(t)) return 'intern';
  if (/\b(vp|vice president)\b/.test(t)) return 'vp';
  if (/\bdirector\b/.test(t)) return 'director';
  if (/\bprincipal\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\b(senior|sr\.?|snr\.?)\b/.test(t)) return 'senior';
  if (/\blead\b/.test(t)) return 'lead';
  if (/\b(junior|jr\.?)\b/.test(t)) return 'junior';
  // "Mid-level" / "II" / "III" — leave alone; too noisy to infer reliably.
  return null;
}

/**
 * Format a compensation summary for the embedding. Prefer the structured
 * min/max (which we can normalise across providers) but fall back to the
 * raw text the provider shipped (`comp_text`) when min/max are missing —
 * the model can still glean "around 150K" from "$140-160K total comp".
 *
 * Returns null when there's nothing useful to say. Keeps the format
 * close to how a human would write it ("$160K – $220K /year") rather
 * than a machine code dump, because the embedder is trained on prose.
 */
export function formatCompForEmbedding(job) {
  const hasStructured = job.comp_min != null || job.comp_max != null;
  if (!hasStructured) return job.comp_text || null;

  const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  const sym = symbols[job.comp_currency] || '';
  // For currencies we don't have a symbol for, prefix the 3-letter code
  // once at the front instead of repeating it on each number.
  const codePrefix = sym ? '' : (job.comp_currency ? `${job.comp_currency} ` : '');
  const fmt = (n) => {
    if (n == null) return '';
    const num = n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n));
    // Symbol attaches to each number ("$180K – $240K" reads naturally);
    // the 3-letter code is hoisted to a single prefix above.
    return `${sym}${num}`;
  };
  const range = job.comp_min != null && job.comp_max != null && job.comp_min !== job.comp_max
    ? `${fmt(job.comp_min)} – ${fmt(job.comp_max)}`
    : fmt(job.comp_min ?? job.comp_max);

  const intervalSuffix = job.comp_interval ? ` /${job.comp_interval}` : '';

  return `${codePrefix}${range}${intervalSuffix}`;
}

/**
 * Call Voyage's embeddings API for a batch of texts. Throws on non-2xx.
 * Returns an array of vectors in the same order as the input.
 *
 * input_type='document' primes Voyage's asymmetric retrieval mode (it
 * prepends "Represent the document for retrieval: " internally) — jobs are
 * always the document side; the résumé/query side (ops-console) embeds with
 * input_type='query' so the two vectors are optimized for cross-retrieval,
 * not just embedded with the same model.
 */
export async function embedTexts(texts) {
  if (!texts.length) return [];
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input: texts,
      input_type: 'document',
      output_dimension: EMBEDDING_DIM,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage embeddings ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // Voyage's response is OpenAI-shaped: { data: [{ embedding, index }], usage }
  // — sort by index to be safe rather than assume array order matches input.
  return data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

// pgvector accepts vectors as the string literal "[0.1,0.2,...]". JSON
// arrays of numbers don't auto-cast through PostgREST, so we serialize here.
export function vectorToPg(vec) {
  return '[' + vec.join(',') + ']';
}

/**
 * Embed and persist a list of job rows. Each row must have { id, title,
 * department, location }. Writes embedding / embedding_model / embedded_at.
 *
 * Returns { embedded, failed, costEstimateUsd } for logging.
 *
 * Strategy: batch into EMBED_BATCH_SIZE chunks for the Voyage call, then
 * fire WRITE_CONCURRENCY parallel PATCHes per batch. PostgREST's PATCH
 * with a single-id filter is the simplest path that avoids fighting
 * pgvector's text format through bulk upsert.
 */
export async function embedAndPersistJobs(jobs, { onProgress } = {}) {
  let embedded = 0;
  let failed = 0;
  let tokensSeen = 0;
  const writeQueue = [];

  for (let i = 0; i < jobs.length; i += EMBED_BATCH_SIZE) {
    const batch = jobs.slice(i, i + EMBED_BATCH_SIZE);
    const texts = batch.map(buildJobText);

    let vectors;
    try {
      vectors = await embedTexts(texts);
    } catch (e) {
      console.error(`embedding batch failed at offset ${i}: ${e.message}`);
      failed += batch.length;
      if (onProgress) onProgress({ embedded, failed, total: jobs.length });
      continue;
    }

    tokensSeen += texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0); // rough chars/4 estimate

    const now = new Date().toISOString();
    // Fire WRITE_CONCURRENCY parallel PATCHes, drain, repeat.
    for (let w = 0; w < batch.length; w += WRITE_CONCURRENCY) {
      const slice = batch.slice(w, w + WRITE_CONCURRENCY);
      const vecSlice = vectors.slice(w, w + WRITE_CONCURRENCY);
      await Promise.all(
        slice.map((row, idx) =>
          update(
            'jobs',
            { id: `eq.${row.id}` },
            {
              embedding: vectorToPg(vecSlice[idx]),
              embedding_model: EMBEDDING_MODEL,
              embedded_at: now,
            },
            { returning: 'minimal' },
          )
            .then(() => {
              embedded++;
            })
            .catch((e) => {
              console.error(`embedding write failed for job ${row.id}: ${e.message}`);
              failed++;
            }),
        ),
      );
    }

    if (onProgress) onProgress({ embedded, failed, total: jobs.length });
  }

  // Voyage's first 200M tokens are free (per the voyage-4 launch); beyond
  // that, check current pricing at https://docs.voyageai.com/docs/pricing.
  const costEstimateUsd = 0;
  return { embedded, failed, tokensSeen, costEstimateUsd };
}
