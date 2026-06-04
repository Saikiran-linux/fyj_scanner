# JD ↔ Resume matching — deep method bake-off

**Date:** 2026-06-04 · **Harness:** [`scripts/matching-bench.mjs`](../scripts/matching-bench.mjs) · **Branch:** `claude/abtesting-hOFRM`

Goal: find the *best* method for matching a user's resume against the embedded job index — searching the whole design space, **not** anchored to the variants tried earlier in the session — and quantify the gap vs (a) the current production path and (b) the proposed reranker sketch.

## Methodology (and how bias was controlled)

- **Corpus:** 1,000 active jobs with both `description` and `description_summary` (Supabase `mwcpoaefmggapztkxakp`).
- **Generalisation:** evaluated over **3 diverse resumes** — Data/AI engineer (the real one), Frontend engineer, DevOps/SRE — metrics averaged across them. (2 of the 3 are realistic synthetic personas to test that conclusions aren't resume-specific.)
- **No pool bias:** each resume's candidate pool is the **union of top-15 from four different retrievers** (dense-summary, dense-fulldesc, lexical, field-chunk) → 32–45 candidates/resume. Every method then *ranks this identical fixed pool*, so the comparison is apples-to-apples ranking quality on a hard candidate set (all candidates are already plausible).
- **Independent oracle:** relevance is the mean of **two strong judges, gpt-5.1 + gpt-5.2**, both stronger than and distinct from every reranker under test. **Inter-judge Spearman = 0.879** over 111 pairs → the oracle is reliable, not two models disagreeing.
- **Honest caveat:** an LLM reranker graded by an LLM oracle is favoured *by construction* (both are "ask a model for fit"). So we crown two winners: best overall, and best **retrieval-only** method (the cheap, no-LLM-at-query-time path). The retrieval-only methods compete on a more neutral footing.

## Results (averaged over 3 resumes)

| Rank | Method | NDCG@10 | meanFit@10 | recall@10 | Spearman | Type |
|---|---|---|---|---|---|---|
| 1 | **RR-4.1** — pointwise rerank, gpt-4.1 | 0.983 | 83.5 | 73% | 0.691 | LLM rerank |
| 2 | **RR-mini** — pointwise rerank, gpt-4o-mini | 0.982 | **84.0** | **80%** | **0.782** | LLM rerank |
| 3 | HYDE — embed LLM "ideal candidate" from JD | 0.928 | 78.8 | 50% | 0.593 | retrieval |
| 4 | LEXICAL — skill-keyword overlap | 0.927 | 79.4 | 47% | 0.541 | retrieval |
| 5 | LARGE — dense summary, 3-large | 0.926 | 79.0 | 50% | 0.391 | retrieval |
| 6 | HYBRID — RRF(dense-small, lexical) | 0.920 | 78.3 | 53% | 0.497 | retrieval |
| 7 | FEATURE — weighted(cosine, skills, seniority) | 0.920 | 78.4 | 50% | 0.493 | retrieval |
| 8 | LISTWISE — listwise rank, gpt-4.1 | 0.906 | 77.6 | 40% | 0.479 | LLM rerank |
| 9 | FIELD — field-level summary chunking | 0.902 | 77.3 | 53% | 0.582 | retrieval |
| 10 | **PROD — dense summary, 3-small (current)** | 0.863 | 72.6 | 43% | 0.248 | retrieval |

## What this says

### 1. The pointwise LLM reranker is the best method — and the cheap model wins
RR-mini and RR-4.1 are tied at the top and clearly ahead of everything else. **Crucially, the cheap `gpt-4o-mini` reranker is as good or better than `gpt-4.1`**: equal NDCG (0.982 vs 0.983, noise), but *higher* meanFit@10 (84.0 vs 83.5), *higher* recall@10 (80% vs 73%), *higher* Spearman (0.78 vs 0.69). This **reverses** the earlier single-resume reranker test (which favoured gpt-4.1) — under 3 resumes + an ensemble oracle the gap vanishes. Practical verdict: **deploy the pointwise reranker on `gpt-4o-mini`** (~13× cheaper than gpt-4.1 for equal quality).

### 2. The reranker sketch was the right architecture
"Best overall" *is* the sketch (dense retrieve → pointwise LLM fit-score rerank). Nothing in the wider design space beat it. The only refinement vs the sketch: use `gpt-4o-mini`, not `gpt-4.1`.

### 3. Current production (PROD) is dead last
Dense cosine over the 3-small summary embedding ranks **worst of all 10** on this hard pool (NDCG 0.863, Spearman 0.248 — its ordering barely tracks fit). Every alternative beats it, including dumb keyword overlap. Headline gap: **best vs production = +10.9 meanFit@10 and +30 pts recall@10.**

### 4. Surprises among retrieval-only methods (the less-biased comparison)
- **HyDE wins the retrieval-only track** (generate an "ideal candidate" from each JD, embed *that*, match) — but it costs an LLM generation per job at index time, same cost class as summaries.
- **Plain LEXICAL skill-overlap is the #2 retrieval method and has the single highest meanFit@10 of any non-LLM method (79.4).** Skill-token matching carries enormous signal that pure dense embeddings under-use — a strong argument for adding lexical/hybrid retrieval to *feed* the reranker.
- **3-large (LARGE) clearly beats 3-small (PROD)** here (fit 79.0 vs 72.6), softening the earlier "not worth it" call — though its full-ranking Spearman is poor (0.39), so the win is top-10-only and the reranker dwarfs the model choice either way.
- **Negative results:** field-chunking (#9) and listwise reranking (#8) both **underperformed** — field-chunking's earlier "promising at n=600" did not survive the broader eval, and listwise (ranking 30–45 items in one prompt) is markedly worse than pointwise scoring. Drop both.

## Recommendations

1. **Build the pointwise reranker on `gpt-4o-mini`** (the validated sketch architecture). Biggest single win: +10.9 meanFit@10, +30 pts recall over today. Query-time only (~$0.0002/candidate), graceful cosine fallback.
2. **Improve the retrieval *feed* with lexical/hybrid skill matching** — the reranker can only reorder what retrieval surfaces, and lexical overlap is nearly free and surprisingly strong. (Hybrid RRF here used the weak 3-small dense arm; pairing lexical with a stronger dense arm is worth a follow-up.)
3. **Do not** invest in field-chunking or listwise reranking. 3-large is optional and low-priority next to reranking.

## Caveats

- Oracle is an LLM ensemble (reliable at ρ=0.879, but still a proxy for true human fit); LLM rerankers are structurally favoured by it.
- 3 resumes, pools of 32–45; `recall@10` is recall *within the shared pool*, not from the full 70k index — true end-to-end recall depends on stage-1 retrieval, which is exactly why recommendation #2 matters.
- Feature-fusion / hybrid weights were set by hand, not tuned.

Raw numbers: `scripts/_bench-results.json` (gitignored; regenerate with `node --env-file=.env scripts/matching-bench.mjs`).
