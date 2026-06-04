# claude-progress.md

Session log for fyj_scanner. **Append new entries at the top.** Each entry: what was done, files touched, verified state, what's queued next. Keep it under one screen per entry — long-form context belongs in commit messages and `HOSTED_PLATFORM_PLAN.md`.

Verified state at the moment is also exposed by `./init.sh` and (live) by the dashboard queries — this file is the *human* tracker.

---

## 2026-06-04 · f-101 Greenhouse 404 recovery — coverage reclaim (cross-ATS + slug-drift)

**Goal**: reclaim the 518 Greenhouse companies sitting `enabled=false` with a `404` last_error — coverage we already discovered but can no longer reach.

**What changed**

- New `src/recover-greenhouse-slugs.mjs` (+ `npm run recover-greenhouse`). Per disabled+404 Greenhouse company it tries, highest-confidence first: (1) re-verify the current slug → re-enable in place; (2) **cross-ATS** — probe Ashby/Lever/SR with the *same* slug (ATS migration) → rewrite `ats`+`slug`; (3) 2–3 same-ATS slug variants (suffix append/strip, hyphen collapse) → rewrite `slug`. First live, non-empty board wins. Never overwrites an `(ats,slug)` another row owns; supports `--dry-run`, `--limit`, `--include-all`, `--no-cross-ats`, `--no-variants`; writes `data/recover-greenhouse-report.json` for audit.

**Key finding (empirical, live 40-row sample)**: the f-101 premise ("slug drift, e.g. `notion`→`notion-labs`") is **wrong for this pool** — `notion-labs` 404s too, and suffix-variants recovered **0/40**. The real recoverable pattern is **cross-ATS migration: 6/40 (15%)**, all Greenhouse→Ashby (Strava, Osmo, Mutiny, Fig, LatchBio, Benevity — live companies that switched ATS). Across 518 disabled rows that projects to ~75 companies / ~1k jobs reclaimed. The other ~85% are mostly dead/acquired companies — correctly left disabled rather than mis-pointed.

**Verified — RAN LIVE against prod `mwcpoaefmggapztkxakp`**:
- Dry-run (830s, 0% block-rate on every source): 65 cross-ATS recoveries (58 ashby · 4 lever · 3 SR), 807 jobs, median 9/co; 0 variant, 0 reactivate, 453 unresolved, 61 skipped (already covered). Top hits all live companies — Skydio 114, BetterUp 39, Lambda 38, Thumbtack 32, Strava 24, Patreon 20.
- Live run (exit 0): **65 companies re-enabled**. Confirmed via SQL: gh disabled-404 **518 → 453**; the 65 rows now `enabled=true` with fresh `last_success_at`; Skydio/Strava/BetterUp/Lambda/Patreon all `ats=ashby`. **Collision guard held in prod**: `greenhouse/notion` left disabled because `ashby/notion` already existed — no dup.
- `data/recover-greenhouse-report.json` is gitignored (per-run audit artifact, like a log).

**Note**: the Supabase service-role key was pasted in chat this session — **rotate it** (and update GitHub Actions secrets), per CLAUDE.md hard-rule #1.

**Next**: `npm run scan` to pull the 65 reclaimed boards into the jobs index (~+800 active jobs). Then f-102 (slug-pool expansion: GitHub README scrape + SmartRecruiters bootstrap).

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

**Reranker — IMPLEMENTED** (this session, after approval). Two-stage retrieve-then-rerank now in the production matching path:

- `src/rerank.mjs` — pointwise `gpt-4o-mini` fit-score reranker; bounded concurrency, retry/backoff, **non-fatal** (falls back to cosine order on failure or when `RERANK_ENABLED=0`).
- `src/match-resume.mjs` — `matchResume()`: stage-1 cosine over-fetch (`MATCH_CANDIDATES`=50) via new RPC → stage-2 rerank → top-K (`MATCH_TOPK`=20).
- `supabase/schema.sql` + applied migration `add_match_resume_candidates_rpc`: formalised the previously-untracked `match_resume` and added `match_resume_candidates` (returns `id` + `description_summary` so the reranker can score). Idempotent `create or replace`.
- `scripts/embed-resume.mjs` now also writes `scripts/_resume.txt`; `scripts/call-match.mjs` drives the two-stage flow; `npm run match` added.
- **Verified**: new RPC self-matches at cosine 1.0 and returns id+summary (live, service key); rerank module unit-tested (reorders by fit, graceful partial-failure, cosine fallback) via stubbed fetch. NOT verified live end-to-end — the shared temporary OpenAI key 401'd mid-session (rotated/expired); rerank logic is identical to the already-validated bake-off harness.

**Resume-matcher UI — IMPLEMENTED in the dashboard** (`status-page/`, Next.js). New **`/matches`** page: drag-drop a PDF résumé (parsed in-browser via pdf.js), `POST /api/match` runs résumé→JD precis→embed→two-stage matcher and renders ranked results with fit score + apply links. Self-contained `status-page/lib/match.js` (the app deploys to Vercel with root=`status-page`, so it can't import repo `src/` — keep the two in sync). Nav tab + README + `.env.example` (`OPENAI_API_KEY`) updated. `next build` green; live-tested `/matches` (200) and `/api/match` (reranked top-15 in ~7s). The earlier standalone `src/web-server.mjs` + `public/index.html` were removed in favour of this.

**Location filter** (added to `/matches`): "Location contains" + Workplace (remote/hybrid/onsite) controls. Applied by over-fetching a wider cosine pool (≈250) and filtering in app code before rerank. Required fixing the **HNSW `ef_search` cap** — the index only explores `ef_search` (default 40) candidates, silently capping `limit 250` at 40, so `match_resume_candidates` is now plpgsql and raises `ef_search` to `match_count` via `set_config(...,is_local=true)` (migration `match_resume_candidates_raise_ef_search` + comp_min/max `::integer` cast fix). Verified: US filter over-fetches 241, returns US-only top-15.

**Next**

- Live smoke `npm run match` once a valid `OPENAI_API_KEY` is in `.env`.
- Optional: lexical/hybrid retrieval feed (rec. #2 in the benchmark doc) to raise stage-1 recall.
- Rotate the Supabase service-role + OpenAI keys shared during this session (OpenAI one already appears rotated).

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
