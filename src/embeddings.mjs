/**
 * OpenAI embeddings client + helpers for the resume-matching feature.
 *
 * The scanner and the backfill script both pull rows lacking embeddings
 * and run them through this module. Embedding failures are non-fatal —
 * the caller logs and moves on; the next pass will retry.
 *
 * Model: text-embedding-3-small (1536 dims, ~$0.02 per 1M tokens).
 * A typical job (title + department + location) is ~30-60 tokens, so
 * the whole jobs table is well under $1 to embed.
 */

import { update } from './supabase-client.mjs';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const EMBEDDING_DIM = 1536;
// OpenAI accepts up to 2048 inputs per request; 100 is a safe batch that
// keeps individual requests fast and limits the blast radius of a failure.
export const EMBED_BATCH_SIZE = 100;
// Parallel PATCHes when writing embeddings back. PostgREST handles this
// fine; tune up if you hit rate limits on the Supabase side.
const WRITE_CONCURRENCY = 10;

export function isEnabled() {
  return Boolean(process.env.OPENAI_API_KEY);
}

// Truncate descriptions to ~1500 chars (~375 tokens) to keep embedding
// costs predictable and stay well under the 8191-token input limit. The
// first ~1500 chars of a job description carry the bulk of the semantic
// signal (role + responsibilities); boilerplate like benefits and EEO
// statements lives further down and would mostly add noise.
const DESCRIPTION_CHAR_LIMIT = 1500;

/**
 * Build the text we embed for a job row. Kept deterministic so the same
 * row always produces the same input — important if we ever want to detect
 * "content changed, re-embed."
 */
export function buildJobText(job) {
  const parts = [job.title || ''];
  if (job.department) parts.push(`Department: ${job.department}`);
  if (job.location) parts.push(`Location: ${job.location}`);
  if (job.description) {
    const trimmed = job.description.length > DESCRIPTION_CHAR_LIMIT
      ? job.description.slice(0, DESCRIPTION_CHAR_LIMIT) + '…'
      : job.description;
    parts.push(trimmed);
  }
  return parts.join('\n\n');
}

/**
 * Call OpenAI's embeddings API for a batch of texts. Throws on non-2xx.
 * Returns an array of vectors in the same order as the input.
 */
export async function embedTexts(texts) {
  if (!texts.length) return [];
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  // OpenAI guarantees data.data[i].index matches input order, but we sort
  // explicitly to be safe across SDK versions.
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
 * Strategy: batch into EMBED_BATCH_SIZE chunks for the OpenAI call, then
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
    // Fire WRITE_CONCURRENCY PATCHes in parallel, drain, repeat.
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

  // text-embedding-3-small is $0.02 per 1M tokens
  const costEstimateUsd = (tokensSeen / 1_000_000) * 0.02;
  return { embedded, failed, tokensSeen, costEstimateUsd };
}
