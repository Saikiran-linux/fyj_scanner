/**
 * Production resume↔jobs matcher: two-stage retrieve-then-rerank.
 *
 *   Stage 1 (recall):    match_resume_candidates RPC — HNSW cosine search over
 *                        jobs.embedding, over-fetching `candidateCount` rows.
 *   Stage 2 (precision): src/rerank.mjs scores each candidate's fit with an LLM
 *                        and reorders, trimming to the final `topK`.
 *
 * Stage 2 is optional and non-fatal: when reranking is disabled (no key /
 * RERANK_ENABLED=0) or no resume text is supplied, we return the cosine top-K
 * unchanged. See docs/matching-benchmark.md for why this two-stage shape won
 * the method bake-off.
 *
 * Note: a NOT-runnable module — the embedding of the resume (and producing its
 * text form) happens upstream in scripts/embed-resume.mjs. Callers pass the
 * 1536-dim vector and, for reranking, the resume text.
 */

import { rpc } from './supabase-client.mjs';
import { rerankCandidates, isEnabled as rerankEnabled } from './rerank.mjs';

// Over-fetch this many cosine candidates before reranking. 50 is the bake-off
// pool size and comfortably covers the final top-K; bigger pools cost more
// rerank calls for diminishing recall.
export const MATCH_CANDIDATES = Number(process.env.MATCH_CANDIDATES || 50);
export const MATCH_TOPK = Number(process.env.MATCH_TOPK || 20);

/**
 * @param {object} args
 * @param {number[]} args.resumeVec     1536-dim resume embedding.
 * @param {string}  [args.resumeText]   Resume text for stage-2 rerank (omit to skip).
 * @param {number}  [args.topK]         Final result count (default MATCH_TOPK).
 * @param {number}  [args.candidateCount] Stage-1 over-fetch (default MATCH_CANDIDATES).
 * @param {boolean} [args.rerank=true]  Allow stage-2 rerank.
 * @returns {Promise<{candidates: object[], reranked: boolean, retrieved: number}>}
 */
export async function matchResume({ resumeVec, resumeText, topK = MATCH_TOPK, candidateCount = MATCH_CANDIDATES, rerank = true }) {
  if (!Array.isArray(resumeVec) || resumeVec.length !== 1536) {
    throw new Error(`matchResume: resumeVec must be a 1536-dim array (got ${resumeVec?.length})`);
  }

  // Stage 1 — cosine retrieval (RPC already orders by distance asc = best first).
  // supabase-client.request retries PGRST002 (schema-cache reload) for us.
  const candidates = await rpc('match_resume_candidates', { resume_vec: resumeVec, match_count: candidateCount });

  // Stage 2 — rerank, if enabled and we have resume text to score against.
  if (rerank && rerankEnabled() && resumeText) {
    const reranked = await rerankCandidates(resumeText, candidates, { topK });
    return { candidates: reranked, reranked: true, retrieved: candidates.length };
  }
  return { candidates: candidates.slice(0, topK), reranked: false, retrieved: candidates.length };
}
