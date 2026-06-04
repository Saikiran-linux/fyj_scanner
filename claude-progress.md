# claude-progress.md

Session log for fyj_scanner. **Append new entries at the top.** Each entry: what was done, files touched, verified state, what's queued next. Keep it under one screen per entry — long-form context belongs in commit messages and `HOSTED_PLATFORM_PLAN.md`.

Verified state at the moment is also exposed by `./init.sh` and (live) by the dashboard queries — this file is the *human* tracker.

---

## 2026-06-04 · Embedding-strategy A/B + reranker evaluation (test-only, nothing in prod path)

**What changed**

- Fixed a real bug in `selectAll` (`src/supabase-client.mjs`): it overwrote any caller `limit` with `pageSize` and paginated through *every* matching row, so `scripts/abembeddingtest.mjs` pulled all 9 286 active+summarised jobs instead of its 200-job sample (~46× the documented OpenAI cost). Added an optional `maxRows` cap (default `Infinity` → all other callers unchanged) and wired it in. Also added the previously-missing `npm run ab-test` script.
- Added two **test-only** harnesses (write nothing to Supabase, leave `src/embeddings.mjs` untouched): `scripts/embedding-experiments.mjs` (field-chunking vs 3-large vs baseline, LLM-as-judge) and `scripts/reranker-test.mjs` (non-circular reranker A/B with an independent gpt-5.1 judge).

**Findings** (resume = the Senior Data/AI Engineer in `embed-resume.mjs`; judge = LLM proxy, directional not ground truth)

| Lever | Verdict | Evidence |
|---|---|---|
| **Reranker** (cosine top-N → LLM fit-score reorder) | **Clear win — build it** | vs independent gpt-5.1 judge, meanFit@10 64.6 → **76.6** (gpt-4o-mini) → **78.5** (gpt-4.1); recall@10 40 % → 60 % → **80 %**; NDCG 0.83 → 0.97 → 0.99 |
| Better reranker model (gpt-4.1 vs gpt-4o-mini) | Marginally better; biggest gain is recall@10 (+20 pts). ~13× token cost but query-time only (~$0.03/match) | R2−R1: meanFit +1.9, NDCG +0.018 |
| `text-embedding-3-large` | **Not worth it** (robust across 200 & 600 samples) — NDCG ≈ baseline, 6.5× embed cost + 2× pgvector storage | judge NDCG 0.66 vs 0.64 |
| Field-level summary chunking (weighted) | **Promising, re-examine** — trailed baseline at n=200 but *led* at n=600 (NDCG 0.70 vs 0.64). `mean` aggregation is junk (dilutes) | needs multi-resume study before any decision |

**Verified state**: scripts run green against Supabase `mwcpoaefmggapztkxakp` with `OPENAI_API_KEY` set; sampling now correctly capped (`Got 200/400/600 jobs`). No schema or production-pipeline changes. Branch `claude/abtesting-hOFRM`, PR #28 (draft).

**Deep bake-off (added later same session — see [`docs/matching-benchmark.md`](docs/matching-benchmark.md))**: 10 methods × 3 diverse resumes, graded by an independent gpt-5.1+gpt-5.2 ensemble oracle (inter-judge ρ=0.879). Winner = **pointwise LLM rerank**, and the cheap `gpt-4o-mini` ties/beats `gpt-4.1` (fit 84.0 vs 83.5, recall 80% vs 73%) — **reverses** the earlier single-resume call that favoured gpt-4.1. Best vs current production: **+10.9 meanFit@10, +30 pts recall**. Current `PROD` (dense 3-small summary) ranked **last of 10**. Surprises: plain lexical skill-overlap is the strongest non-LLM method; HyDE wins the retrieval-only track; field-chunking and listwise rerank both **underperformed** (drop them).

**Next**

- On approval: implement the reranker per the design sketch — now refined to **`gpt-4o-mini` pointwise** (new `src/rerank.mjs`, two-stage retrieve-then-rerank in `match-resume.mjs`, query-time only, graceful cosine fallback). Consider a lexical/hybrid retrieval feed (rec. #2 in the benchmark doc). **Not started — awaiting go-ahead.**
- Rotate the Supabase service-role + OpenAI keys shared during this session.

---

## 2026-05-23 · Adopted the walking-labs harness layout

**What changed**

- Added the 8 canonical harness files: this `claude-progress.md`, `CLAUDE.md`, `init.sh`, `feature_list.json` (migrated from `TODO.md`), plus `docs/session-handoff.md`, `docs/clean-state-checklist.md`, `docs/evaluator-rubric.md`, `docs/quality-document.md`.
- Created `docs/architecture.excalidraw` with full A–G system diagram (top-level → scan layer → matching → multi-agent CV tailor → app layer → ERD → onboarding).
- Created `scripts/embed-resume.mjs` + `scripts/call-match.mjs` + `public.match_resume(vector, int)` RPC for symmetric resume↔jobs cosine matching. Verified end-to-end: resume embedded (437 tokens), RPC returned 30 matches in the 0.74–0.80 cosine range.

**Verified live state** (Supabase project `mwcpoaefmggapztkxakp` / `fyj`, queried 2026-05-23):

| Metric | Value |
|---|---|
| Companies total / enabled / disabled | 4,622 / 3,071 / 1,551 |
| Jobs total / active | 76,885 / 70,518 |
| Active with description | 59,872 (84.9 %) |
| Active with `description_summary` | 10,582 (15.0 %) |
| Active with `embedding` | 11,197 (15.9 %) |
| Unique active fingerprints | 66,526 (94.3 % dedup ratio) |
| Last OK scan | 2026-05-23 20:08:33 UTC |
| Scans last 7 days | 38 (4×/day cadence + retries) |

**Known gaps**

- Embedding coverage is only ~16 % of active jobs — the rest fall back to keyword/SQL matching. Cron has `SKIP_LLM_PASSES=1`; backfills are manual via `npm run backfill-summaries` + `npm run embed-backfill` with `OPENAI_API_KEY` set locally.
- `TODO.md` is now superseded by `feature_list.json` but kept in repo for one more session as a redirect. Delete it after the next merge.

**Next**

- Drain the summary/embedding backlog (~60 k jobs · est. $14, ~25 min).
- Phase-2 onward (Inngest, Clerk, Next.js app) — see `HOSTED_PLATFORM_PLAN.md` and `feature_list.json` items tagged `phase-2`+.

---

<!-- earlier entries go below; this file is append-up -->
