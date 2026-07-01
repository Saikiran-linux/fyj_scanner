# Embedding / matching — implementation assessment + 1M-scale roadmap

> **Status:** assessment + roadmap. Captured 2026-06-12. Reads the current code against the
> retrieval design space; grounds every claim in the bake-off
> ([`matching-benchmark.md`](matching-benchmark.md), 2026-06-04) and live prod numbers.
> Companion to that benchmark (which ranked the methods) — this maps what's *built* vs *to build*.

## One-line verdict

We've done the hard, high-leverage parts — **LLM normalization** (both sides) and a **rigorous eval
harness** — better than most teams ever do, and the **two-stage reranker is validated as the best
method on our own data**. The gap is **not method sophistication**; it's **shipping the validated
pipeline to the live product** and **hardening retrieval (hybrid + SQL filters + quantization) for
the 1M index.** Production today is raw dense cosine over a barely-populated index — which the
benchmark ranks *dead last* of 10 methods.

## Scorecard — what's implemented

| Method | Status | Where |
|---|---|---|
| **1. LLM normalization to a shared representation** | ✅ **Done, both sides** (strongest move) | `summarize.mjs` 14-field `Key:value` precis per job; `embed-resume.mjs` renders the resume into the *same* JD schema → one distribution |
| 2. Asymmetric query/doc embeddings | ⚠️ Substituted, not adopted | `text-embedding-3-small` (symmetric); compensated via #1. Voyage/3-large benchmarked, not switched |
| **3. Hybrid dense + sparse + RRF** | ❌ Benchmarked, not shipped | Matching is dense-only. Bake-off: LEXICAL skill-overlap = #2 retrieval (meanFit 79.4); rec #2 = add it to *feed* the reranker. Trigram index is dashboard-only |
| 4. Field-level / multi-vector | ✅ Tested → correctly dropped | `FIELD` ranked #9 |
| **5. Two-stage retrieve → rerank** | ✅ **Done — the validated winner** | `match-resume.mjs` → `match_resume_candidates` (HNSW, over-fetch 50, `ef_search` lifted) → `rerank.mjs` pointwise LLM fit on gpt-4o-mini. **+10.9 meanFit@10, +30 pts recall@10** over dense-only |
| 6. Late interaction / ColBERT | ❌ Not done (correct — too heavy at scale) | — |
| 7. Fine-tuned embeddings on apply/hire data | ❌ Not yet (pre-launch, no signal) | The future moat; bootstrap labels with the gpt-5.1+5.2 judge ensemble (ρ=0.879) already built |
| 8. HyDE for NL queries | ❌ Benchmarked (won retrieval-only track), not shipped | Relevant to Product B NL search, not the resume path |
| **Hard filters in SQL, not vectors** | ⚠️ Partial | `is_target` + `closed_at` enforced; location filtered in app code. Seniority/comp/work-auth are *embedded as text, not predicates* — the "senior roles to a new grad" risk. Columns exist (`comp_min/max`, `remote`, seniority extractable) |
| **Labeled eval harness** | ✅ **Exemplary — the thing everyone skips** | `matching-bench.mjs` + `matching-benchmark.md`: 3 resumes, union-of-4-retrievers pool, 2-judge oracle, NDCG/meanFit/recall/Spearman, 10 methods, honest caveats |
| Filtered-ANN recall (pre/post-filter) | ✅ Already hit & mitigated | RPC lifts `hnsw.ef_search` (default-40 was truncating filtered results) |
| Churn / re-embed cost | ✅ Handled | `invalidate_embedding_on_description_change` re-embeds only changed rows |

**Reality check on "live":** only **9,091 of 106k active jobs are embedded**, and the reranker runs
via CLI (`call-match.mjs`), not the live `/matches` app. So production `meanFit` is the benchmark's
#10 (raw dense cosine over an ~9% index). **The single biggest accuracy win is shipping what's
already built, not inventing anything new.**

## Roadmap — adopt at 1M+ (priority order)

1. **Ship the reranker + embed the target-slice index** *(highest ROI, mostly built)*. +10.9 fit /
   +30 recall, query-time only (~$0.0002/candidate, never on the index). Blockers are operational:
   `OPENAI_API_KEY` in the app env + actually embedding the index. At 1M, embed the **target slice
   only** (`is_target=true`, ~35%) — don't embed blue-collar that's filtered out; keeps the vector
   index ~3× smaller. → **f-122**, depends on **f-115**.
2. **Hybrid lexical retrieval to *feed* the reranker** (our own bake-off rec #2). A reranker only
   reorders what stage-1 surfaces, and the dense arm is the weakest method tested. Add a
   `tsvector`/BM25 (or `skills[]` GIN) column, fuse with dense via RRF, pass the union to the
   reranker. Skill tokens (CUDA, LangGraph, FDA 510(k)) are exact and unforgiving — dense blurs
   them. One Postgres, no new infra. → **f-122**.
3. **Move hard constraints into SQL predicates** (correctness, not just speed): seniority band, comp
   floor, location radius, work-auth → `WHERE`, not embedded prose. Use pgvector 0.8 iterative index
   scan or partial indexes per `is_target`/seniority to keep filtered-ANN recall high. → **f-114**
   (parameterized search) extended.
4. **Quantize the vectors** — at ~1.45M embedded active jobs, `vector(1536)` + HNSW ≈ ~20 GB
   (forces big-RAM compute, see [`scale-50k-assessment.md`](scale-50k-assessment.md)). The two-stage
   design makes binary/`halfvec` retrieve → exact rerank free (precision recovered by the existing
   rerank pass): 4–32× memory cut. → **f-124**.
5. **Hot/cold split the vector index** — only active jobs need ANN; partial HNSW
   `WHERE closed_at IS NULL` (or pin active to a hot partition) so closed rows don't bloat it. →
   **f-124**.
6. **Lower priority:** swap dense arm to **3-large** (benchmark fit 79 vs 72.6, dwarfed by reranker
   — do after 1–2); **HyDE** only for Product B's NL path; **fine-tuning (f-7xx idea)** once
   apply→interview→hire signal accrues (bootstrap labels with the existing judge ensemble — the moat).
7. **True tens-of-millions** (beyond the 1M target): per [`scaling-architecture.md`](scaling-architecture.md),
   pgvectorscale (StreamingDiskANN) or Turbopuffer/Vespa. For 1–few M, stay on pgvector with
   quantization (#4) + hybrid (#2).

**Impact order (from the benchmark): normalization > rerank > hybrid > asymmetric model > base
model.** We've banked #1; ship #2 (rerank) and #3 (hybrid) next.
