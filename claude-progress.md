# claude-progress.md

Session log for fyj_scanner. **Append new entries at the top.** Each entry: what was done, files touched, verified state, what's queued next. Keep it under one screen per entry — long-form context belongs in commit messages and `HOSTED_PLATFORM_PLAN.md`.

Verified state at the moment is also exposed by `./init.sh` and (live) by the dashboard queries — this file is the *human* tracker.

---

## 2026-06-11 (b) · FIX — RECENT SCANS showed 4 rows per sharded cycle

A live N=4 sharded run (f-109) wrote 4 `scans` rows for one cycle (23:19:32, shard_index 0-3), so the overview's RECENT SCANS listed 4 near-duplicate rows with mixed new-counts (one shard windowed = 571, the rest raw), and the by-source panel only saw shard 0.

**Fix — roll shards up into one logical cycle:**
- `scans.cycle_id` (new column): stamped by the scanner from `GITHUB_RUN_ID` (constant across matrix jobs), null for local/unsharded. Grouping key is `coalesce(cycle_id, id)`, so unsharded behaviour is unchanged. Backfilled the two historical sharded cycles (06-05 N=2, 06-11 N=4).
- `v_recent_scans` + `f_new_jobs_by_scan_source` now aggregate per cycle: probed/ok/err/closed summed, duration spans the cycle, active_after = last-finishing shard, and new_jobs counted once over the cycle's full window `[min(started), max(ended)]` (every job is inserted by exactly one shard inside that window). Hot path stays bounded (~30ms, 30 cycles).
- `src/scan.mjs` `openScan()` writes `cycle_id`.
- Left `v_scans` (the `/scans` "all scans" list + detail) per-shard on purpose — that page is the diagnostic drill-down. Could roll up later if desired.

**Verified on prod:** 23:19 cycle now one row — shard_count 4, probed 3,652, new 571 = by-source 571, closed 606, active 106,264. Unsharded cycles unchanged.

**Follow-up:** added a `reopened` column to RECENT SCANS (`v_recent_scans` + overview UI). Explains why active can rise when closed > new: `active_after = active_before + new + reopened − closed`. Derived from the active-count delta (not the raw counter), so it's sane (6–96/cycle) even for the older snapshot-bug rows. Reconciles exactly on every ok cycle.

---

## 2026-06-11 · FIX — dashboard "new jobs" mismatch (RECENT SCANS vs by-source)

**Symptom:** On the overview, NEW JOBS BY SOURCE per-scan totals (e.g. 107, 659) didn't match the RECENT SCANS "new" column (16,157, 16,414; one scan even 34,131) for the same scan.

**Root cause:** Two independent "new" metrics. RECENT SCANS read `scans.new_jobs` — the live per-scan counter (`src/scan.mjs` ~L375-383) that tallies every listed posting absent from the pre-scan *open-job* snapshot, which by design also re-counts **reopened** postings. When a batch of jobs is transiently closed and re-listed, it over-counts by 10–30k. Verified against prod: for those scans only ~100–700 postings had a fresh `first_seen_at`, and the active-index delta (new − closed) matched the `first_seen_at` count, not the raw counter. The by-source panel was already correct (`f_new_jobs_by_scan_source`, first_seen_at windows).

**Fix (schema + status-page, no scanner behavior change, no backfill):**
- `supabase/schema.sql`: new canonical `v_scans` view = `scans` 1:1 but with `new_jobs` recomputed as the first_seen_at-window count (same boundary calc as `f_new_jobs_by_scan_source`); raw counter preserved as `new_jobs_reported`. `v_recent_scans` rewritten to the same definition, kept self-contained + bounded to 30 rows (hot path, 30s auto-refresh; ~45ms regardless of scan-table size).
- `status-page`: overview sparkline now reads `v_recent_scans`; `/scans` list, scan detail, and trend charts read `v_scans`. All scan surfaces now agree by construction.

**Verified:** Applied both views to prod (project `fyj`/mwcpoaefmggapztkxakp). `v_recent_scans.new_jobs` == per-scan by-source total for every scan (310=310, 107=107, 659=659, 864=864…). EXPLAIN: overview path 45ms, subquery evaluated only for the 30 returned rows.

**Follow-up fix (same session):** the window was initially `[started_at, next ok scan)`, which made the *most-recent* ok scan's window run to infinity and swallow the next (still-running) scan's inserts — inflating the latest row (e.g. 4,250 vs a true 1,499) and breaking new − closed ≈ Δactive. Switched the window to each scan's OWN runtime `[started_at, ended_at]` in `f_new_jobs_by_scan_source`, `v_scans`, and `v_recent_scans` (jobs are only inserted while a scan probes, so this is exact and identical for back-to-back scans). Re-verified on prod: latest scan 1,499 across both panels, net new−closed now reconciles with the active delta (residuals = reopens). Also simplified the views (dropped the `lead()`/`ok_bounds` CTE).

**Queued next:** the *scanner* still writes the inflated raw counter (now only surfaced as `new_jobs_reported`). The underlying churn — ~16–34k jobs false-closed then reopened on some runs — is a close-sweep/provider-transient concern worth a separate look (likely providers returning short/empty listings → `close_unseen_jobs` closes, next scan reopens).

---

## 2026-06-05 · LAUNCH CHECKLIST — staffing (Product A) goes live tomorrow

Ordered next steps to operate the AI-first staffing firm. Owner in brackets; ✅=done this session.

**Must-do to launch (in order):**
1. **Merge PR #36** → relevance layer + all scan/dashboard fixes onto `main` (cron + live dashboard). [user — or me on request]
2. **Make matching real (the #1 blocker):** classify(LLM) → summarize → embed the **tech/target slice** first. Matchability **7.7% → ~95%**. ~$30, ~2h. **BLOCKED on `OPENAI_API_KEY`.** [me, once key provided] — f-115
3. **Lock down `/matches`** (public Vercel URL) with basic auth before client résumés go through it. [me, no key] — f-117
4. **QA:** 2–3 real client résumés through `/matches`, eyeball relevance. [together, after #2]

**Backbone — no key, can start now:**
5. **f-114 — parameterize relevance in search** (`target_only` default true + filters; shared `search_jobs` RPC). Keeps staffing unchanged; prerequisite for Product B. [me]

**Right after launch:**
6. **f-118 — daily enrichment workflow** (classify→summarize→embed), else new jobs go unmatchable within days (cron has SKIP_LLM_PASSES=1).
7. **f-116 — Jobs MCP server** (Product B) once f-114 + full-index embeddings land.

**Housekeeping:** rotate the Supabase service-role key + update the Actions secret. [user]

**Live readiness snapshot (2026-06-05):** 93,847 surfaced target jobs; only **7,249 embedded (7.7% matchable)** ← the blocker. 12,259 known-noise hidden; 58,080 still unclassified (need the --llm pass). Classifier + rules backfill (48,162 tagged), match-filtering, scan-ingest classification, dashboard auto-refresh fix, sharding (default N=1) all shipped & on the branch (PR #36).

**Tracker:** added f-117 (operator auth), f-118 (freshness) to `feature_list.json`; f-114/115/116 + product-a/product-b phases already there.

---

## 2026-06-05 · Product strategy: one DB, two lenses (recorded in the plan)

User reframed the product: don't delete blue-collar jobs — the same scanned index powers **two products via a filter lens**, not two datasets.
- **Product A — AI-first staffing firm** (near-term revenue): tech/IT lens (`is_target=true` / tech families); high-touch paid placements.
- **Product B — NL jobs search for AI agents & people** (platform): MCP/API over the *whole* index, any filter the caller wants (blue-collar included); usage-monetized.

**Commitments recorded** in `HOSTED_PLATFORM_PLAN.md` ("Product Strategy — one DB, two lenses") + `feature_list.json` (phases `product-a`/`product-b`; f-114/115/116):
1. Tag, don't delete (the f-113 relevance layer is the shared backbone).
2. **Reverse the "prune SR tenants" plan** — keep blue-collar tenants (Product B wants them); only disable genuinely dead (404/empty) tenants.
3. **Parameterize relevance in search** (`target_only`/`family`/filters), don't hardcode — supersedes the hardcoded `is_target is not false` now in `match_resume*` (f-114).
4. Shared backbone built once: full classification + embeddings (tech slice first to launch A, full index for B) + a hybrid NL→{filters+vector} `search_jobs` RPC.
5. Product B interface = a curated **MCP server** (+ REST), never raw DB access (f-116).

**Launch sequencing:** Product A first (classify + embed tech slice, `target_only=true`) → parameterize search (f-114) → embed full index + ship MCP (f-116). No code this entry — planning only.

---

## 2026-06-05 · f-113 job relevance layer (target-role classification)

**Product context (from the user):** this is an AI-first staffing agency whose customers are tech/IT professionals, knowledge-workers, senior/exec leaders, and students in those fields — NOT people in service/manual/retail/clinical roles. The index had a lot of noise (waiter, dishwasher, care assistant, automotive technician…), mostly from SmartRecruiters (seeded via generic keyword fan-out). So we now classify every job and surface only target roles. Classification is by ROLE, never employer industry.

**Shipped (decisions: tag/filter + prune SR tenants; hybrid rules+LLM):**
- `src/classify.mjs` — high-precision title→{family,is_target,seniority,confidence} rules. Validated on 105k live titles: **45.5% high-precision coverage** (33.9% target, 11.6% non-target); the ambiguous 54.5% → confidence:'low' for the LLM.
- Schema (`jobs.job_family/is_target/seniority/classified_at/classified_by` + partial index `jobs_target_active_idx`). `is_target` semantics: true=surface, false=hide, **NULL=surface (unclassified, not yet hidden)** — so an unclassified backlog never hides good jobs; only known-false is filtered.
- `scripts/backfill-classification.mjs` — rules pass (free) + `--llm` gpt-4o-mini pass for the ambiguous middle (grouped updates, ~few hundred PATCHes for the table). **Ran rules pass live: 48,162 jobs tagged.**
- `src/scan.mjs` — classifies NEW jobs at ingest (rules, inline; never clobbers an existing/LLM verdict); gates the description-fetch + embedding passes to `is_target is not false` so we stop spending on known-noise.
- Match RPCs (`match_resume`, `match_resume_candidates`) now filter `is_target is not false` → **12,259 known-noise jobs hidden from customers immediately**; 93,603 (target + unclassified) still surface.

**Live state:** known non-target=12,259 hidden; SR is the noisiest (5.6k target vs 5.6k non-target among classified, 23.6k still unclassified); Ashby/Lever/WaaS are ~all target. Migrations applied: `add_job_classification_columns`, `match_rpcs_filter_target_roles`.

**Next:** (1) run `backfill-classification.mjs --llm` with an OPENAI_API_KEY to resolve the 57.7k unclassified (~$6-12 one-time) — needed before SR pruning so we don't disable tenants with unclassified-but-target roles; (2) then prune SR tenants whose jobs are ~entirely non-target; (3) retarget discovery (SR/Workable/Workday keyword fan-out on professional roles) so we ingest relevant jobs in the first place.

---

## 2026-06-05 · f-109 scan sharding (capability built, default N=1)

Built matrix-parallel scan sharding — the documented next infra step, unblocked by f-108. **Default N=1, so production behaviour is unchanged**; flip by listing shards in the workflow matrix.

**How it works:** stored `companies.shard` bucket `[0,60)` (generated from md5(id), indexed). Shard *i* of *N* owns the contiguous range `[floor(i*60/N), floor((i+1)*60/N))`, which tiles `[0,60)` exactly for any N≤60 → shards are **disjoint and complete**. `scan.mjs` reads `SHARD_INDEX`/`SHARD_COUNT` and scopes the company load, the active-job snapshot (`jobs → companies!inner`, embedded `companies.and=(shard.gte.LO,shard.lt.HI)`), and the description pass to its slice; writes `scans.shard_index/shard_count`. Per-company `close_unseen_jobs` (f-108) means shards never touch each other's jobs — the safety property that makes parallelism correct.

**Decisions:** (1) per-provider rate-limit concurrency is **not** divided by N — ATS providers throttle per source-IP and each shard runs on its own runner IP, so N shards give ~N× aggregate throughput (the real win); the adaptive limiter backs a shard off if a provider turns out to be globally limited. (2) **one `scans` row per shard**, tagged `shard_index/shard_count`. (3) `f_new_jobs_by_scan_source` now windows on `shard_index=0` so a sharded cycle's siblings don't mis-bucket new-job counts (no-op at N=1).

**Workflow:** `strategy.matrix.shard` (default `[0]`); `SHARD_COUNT` derives from `strategy.job-total`, so adding shards to the matrix is the only change. `fail-fast: false` isolates a failed shard; per-shard artifact names.

**Verified (read-only):** N=4 partition disjoint AND complete — companies 898+921+887+957 = 3,663, jobs 25,860+25,107+25,138+29,634 = 105,739 (0 dupes), via the exact `selectAll` shapes `scan.mjs` uses. Migrations applied: `add_company_shard_and_scan_shard_columns`, `f_new_jobs_by_scan_source_shard_aware`.

**VERIFIED LIVE END-TO-END at N=2** (dispatched on branch; scans `5ffb7ec1` shard 0/2 + `2fa87d8a` shard 1/2): shards **ran in parallel** (17:21:32–17:23:44 ∥ 17:21:30–17:24:02); each probed ONLY its bucket range (0 out-of-range either side); **union of probed companies = 3,663 = total enabled** (disjoint+complete); **stale_among_healthy = 0** (no jobs missed → per-shard snapshots complete, close-sweep + new-count correct under sharding); active stable 105,737; new_jobs accurate (120+180=300); write_failed=0. Matrix reverted to default `[0]` (N=1) after the test.

**Next:** flip the matrix to `[0,1,2,3]` when company count grows (or to validate), then the discovery push (deepen SR → Workable → Workday) to land the volume.

---

## 2026-06-05 · ROOT-CAUSE: inflated new_jobs (selectAll pagination) + dashboard timeouts

User reported the dashboard erroring (`f_new_jobs_by_scan_source → 57014 statement timeout`, ACTIVE JOBS reading 0) and **~38k "new" jobs every scan while active stayed ~105k**. Two distinct bugs, both found and fixed.

**1. Inflated new_jobs — root cause: `selectAll` paginated with LIMIT/OFFSET and no stable ORDER BY** (`src/supabase-client.mjs`). Reproduced live: the active-job snapshot read returned 105,780 rows but only **68,882 unique** `(company_id, external_id)` — ~37k duplicates, so ~37k *distinct* open jobs were missing from the snapshot. Those missing jobs were counted "new" every scan (and their descriptions re-sent → write amplification). LIMIT/OFFSET without a total ORDER BY is not stable on a large table — pages drift, duplicating some rows and skipping others; it worsened as `jobs` grew. Confirmed via per-scan audit: last scan reported `new=38,433` but only `2,323` rows were actually inserted (closed counter was always accurate — it's server-side).
   - **Fix:** rewrote `selectAll` to use **keyset/cursor pagination** on a unique key (`id` by default) — `order=id.asc` + `id=gt.<cursor>`. Stable *and* O(1) per page (no growing OFFSET scan), which also matters at the 1M target. Verified: snapshot now returns 105,780 rows = 105,780 unique. All callers hit `jobs`/`companies` (uuid `id`); embedded-resource + `maxRows` paths retested green.
   - Takes effect for cron scans **only after this PR merges**; until then the deployed scanner keeps miscounting (cosmetic — active set is correct).

**2. Dashboard timeouts (DB-side, fixed live):**
   - `mv_jobs_totals_by_source` was **empty** → ACTIVE JOBS 0 / "no scans". Cause: `f_refresh_totals_by_source` uses `REFRESH ... CONCURRENTLY`, which *errors on a never-populated MV*, so it failed every scan and the MV stayed empty. Repopulated it (plain refresh) and **hardened the function** to fall back to a plain refresh on error (migration applied). Active total back to 105,780.
   - `f_new_jobs_by_scan_source` timed out at **12.7s** (>8s authenticator → 57014). It range-joins jobs by `first_seen_at` and heap-fetched ~57k wide (embedding-bearing) rows just to read `company_id`. **Fix:** covering index `jobs(first_seen_at, company_id)` + `count(j.*)`→`count(*)` → index-only scan, `Heap Fetches: 0`, **95 ms** (134× faster). Migrations applied; `vacuum analyze jobs` run.

All four DB migrations applied to prod (`jobs_first_seen_company_idx`, refresh fallback, `count(*)` fn, plus the MV repopulate). Branch `claude/immediate-next-steps-AE9N4` (PR #34). Code change (`selectAll`) needs merge to fix the cron's new-count.

---

## 2026-06-05 · Post-merge: deploy verified + write-failure guardrails (PR #34)

After #33 merged, verified the fix in the real CI environment and added guardrails so this class of silent failure can't recur.

**Deploy verified** — dispatched `scan.yml` on `main` (scan `0ca86904`, Actions runner): `db_write`/PGRST102 failures **= 0**, `companies_error = 0` (the 152 greenhouse HTTP-503s in the prior local run were container-IP-only), `stale_among_healthy = 0`, active stable at **105,877**.

**Guardrails (PR #34, draft, branch `claude/immediate-next-steps-AE9N4`):**
- `scans.companies_write_failed` first-class metric + `totals` counter (migration applied) — the blind spot that hid the freeze (probe-ok-but-write-failed counts in neither ok nor error).
- Fail-fast: scan marked `failed` + process exits non-zero (Actions red) when >5% of probed companies (and >25 absolute) fail their write. The PGRST102 freeze (~31%) would have tripped this on day 1.
- Zombie-scan reaper at startup (`running` >45min → `failed`); reaped 28 existing zombies.
- Dashboard query 6b — freeze detector (write-failure rate + zombie-open jobs).

**Thaw reconciliation (healthy, one-time):** `total_jobs` 117,308 → 130,351 (**+13,043 genuinely-new** rows that accumulated during the 19-day freeze), `closed` 11.6k → 24,474 (**+~12.9k genuinely-gone**), active flat. The per-scan `new_jobs` *counter* reads high (~40k) during this reconciliation because it also counts churn/reopens; the underlying table moved by ~13k, the real backlog clearing. **Watch the next scheduled cron (06:17 UTC): `new_jobs` should fall back to small numbers.** If it stays ~40k, there's a new-count/external-id churn issue to investigate separately (does not affect the active set, which is correct and stable).

---

## 2026-06-05 · CRITICAL upsert bug fix (PGRST102) + server-side close-sweep (f-112, f-108)

Started on the documented #1 next step (server-side close-sweep) and, while validating it against live prod, **uncovered an active P0 data-integrity bug** that was silently freezing most of the index.

**The bug (f-112) — found via live audit, fixed:**
- **1,139 companies** (incl. SpaceX, OpenAI, Databricks, Carvana, DoorDash, Anduril) failed their *entire* per-company jobs upsert **every scan** with `db_write: 400 PGRST102 "All object keys must match"`. Result: **62,182 active jobs (59% of the index)** frozen — `last_seen_at` never refreshed, no new postings ingested — since **2026-05-17 22:31** (~19 days).
- **Root cause:** PostgREST requires every object in a bulk upsert array to share one key set. The description hash-skip optimisation (landed 2026-05-17) attaches `description`/`description_hash`/`description_fetched_at` only to rows whose text *changed*. Any company with a mix of changed + unchanged postings in one batch → heterogeneous keys → 400 → whole-company write fails. Big boards (≥1 changed posting every scan) failed every time. The code fails *safe* (early-returns before the close-sweep), so jobs froze rather than being closed — which is exactly why they showed up as `stale_open == total_open`.
- **Fix** (`src/scan.mjs` `probeOne`): bucket `jobRows` by sorted key signature and upsert each homogeneous group separately. Any group failure still early-returns before the close-sweep (never close on a partial write). Self-healing — the next successful scan re-stamps these boards and closes whatever the providers no longer list.

**Server-side close-sweep (f-108) — the planned next step, landed in the same path:**
- New idempotent RPC `public.close_unseen_jobs(company_id, scan_start)` (`supabase/schema.sql`, migration `add_close_unseen_jobs_rpc` **applied to prod**): `UPDATE jobs SET closed_at=now() WHERE company_id=$1 AND closed_at IS NULL AND last_seen_at < $scan_start`.
- `src/scan.mjs` captures `SCAN_START_ISO` before any upsert and calls the RPC per successfully-probed company, replacing the client-side diff + per-company external_id IN-list PATCH. Idempotent, per-company → **shard-safe** (the prerequisite for f-109 matrix sharding). The in-Node active snapshot is still read, but now only for the description hash-skip + new-job counting; fully dropping it is coupled to the COPY/bulk-write work (f-110).

**Verified (live prod `mwcpoaefmggapztkxakp`, read-only + non-destructive):**
- Scope of bug confirmed: 1,139 failing companies, 62,182 stale-open jobs, first occurrence 2026-05-17.
- Close-sweep **equivalence proven**: across all **2,524** companies whose write succeeded last scan, **0** open jobs predate `scan_start` → the watermark sweep closes exactly what the old diff did (no over-closing). The 62k stale rows belong solely to the PGRST102 victims, protected by the early-return.
- `close_unseen_jobs('<fake-uuid>', now())` → `0` (function runs, non-destructive). `node --check src/scan.mjs` passes.

**NOT yet verified:** a full live scan has not run from this session (no `.env`/secrets in the cloud container). Correctness is established by the equivalence proof + syntax check + applied migration, but the headline numbers (PGRST102 errors → 0, active count correcting upward) must be confirmed on the **first scheduled scan after merge**. Don't tick the clean-state checklist as "scan green" until then.

Branch `claude/immediate-next-steps-AE9N4`. The migration is already live in prod, so the code is safe to merge (RPC exists before the scan that calls it).

**VERIFIED LIVE — ran the fixed scanner against prod** (`npm run scan`, scan `f1a2b319`, 169s, 3,663 companies):
- **PGRST102 `db_write` failures: 1,314 → 0** (the immediately-prior old-code cron scan had 1,314; mine had 0). `any_dbwrite_failures = 0`, `companies_dbwrite_fail = 0`.
- **The 19-day freeze thawed:** `new=40,684 / closed=10,214`; **stale-open jobs 64,698 → 10,024**. The remaining 10,024 are 100% accounted for by companies not successfully probed this run (9,630 in HTTP-503 errored boards + 394 in disabled boards) — **0 stale among the 3,511 companies that wrote successfully**, which is the close-sweep correctness invariant.
- Marquee boards refreshed: bayada/carvana/spacex/veeva/openai all `last_seen` ~05:0x, `still_stale=0`. (Databricks alone stayed frozen — it drew a transient greenhouse 503 this run; recovers next probe.)
- `err=152` were all transient **HTTP 503** (greenhouse 151 + SR 1) from this container's IP; `newly_autodisabled=0`.
- A transient DB compute restart (`57P03`) hit right at the scan's tail, so the process's own `closeScan`/totals-refresh writes were lost — I closed the `running` scan row manually with the real totals and re-ran `f_refresh_totals_by_source()` once the DB recovered (~3 min).

**One caveat to flag:** the deployed cron still runs the OLD code until PR #33 merges, so the next scheduled scan will re-freeze the mixed-description boards (no data harm — they just go stale again). **Merging #33 is what makes the fix permanent.**

---

## 2026-06-05 · Architecture efficiency review for 1M-scale (analysis, no code yet)

Full read of `scan.mjs` + `schema.sql` + a live size check. The design is sound for ~100k jobs but has several **O(total jobs)/O(total companies)-per-scan** operations that break at 10×. Measured now: jobs **117k total / 105k active**, table **670 MB = 90 MB heap + 581 MB indexes** (6.5× — index bloat from per-scan UPDATE churn); probe_results 182k rows. 1M active ≈ **25–40k companies, ~6–7 GB jobs table, ~160k probe_results/day**.

**Bottlenecks, ranked (file:line → why it breaks → fix):**
1. **Global active-job snapshot** `scan.mjs:111` — `selectAll` pulls *every* active job into a Node Map each scan (~1,000 REST round trips at 1M, big memory). → **Move close-sweep server-side**: upsert with `last_seen_at=scan_start`, then `UPDATE jobs SET closed_at=now() WHERE company_id=$1 AND closed_at IS NULL AND last_seen_at < $scan_start`. Drops the snapshot entirely. *Prerequisite for everything below.*
2. **Single serial 30-min Actions job** (`.github/workflows/scan.yml`, `concurrency: scan`) — 40k companies ≈ 90+ min. → **Matrix-shard** by `hashtext(id) % N`; close-sweep is per-company so shards are naturally non-overlapping once #1 lands. Biggest throughput unlock.
3. **Per-row PostgREST writes** (description pass `scan.mjs:460`, upserts/closes) saturate the pooler (known 504 cascade). → **Direct transaction-pooled connection (port 6543) + `COPY` to temp table + one `INSERT…ON CONFLICT`/`UPDATE…FROM`** for bulk paths.
4. **Write amplification / index bloat** — every scan UPDATEs `last_seen_at` on every active row; `jobs_active_idx (company_id,last_seen_at desc)` makes those updates non-HOT → bloat. → drop/rethink that index, `fillfactor=80`, aggressive autovacuum on `jobs`, and **partition `jobs`** (active vs archived / monthly) since churn → 5–10M rows/yr.
5. **Per-scan full-table side jobs** — MV refresh `f_refresh_totals_by_source()` (`scan.mjs:616`) full-counts all jobs every run; active-count `HEAD count=exact` (`scan.mjs:566`); embedding pass `selectAll`s all null-embedding rows (`scan.mjs:534`). → incremental MV from scan deltas, `reltuples` estimate, bounded embedding page.
6. **probe_results unbounded** (f-904) — 160k/day at scale. → partition by month + drop old, or persist only non-ok + aggregates.
7. **HNSW at 1M** — match RPC post-filters `closed_at is null` after traversal; index ~6 GB. → **null embedding on close** (extend the description-change trigger to `closed_at`), consider partial HNSW `WHERE closed_at IS NULL`.

**Already right (keep):** description hash-skip, batched probe_results + company-reset PATCH, dashboard MV, HNSW over IVFFlat, partial pending-work indexes.

**Recommended order:** (1) server-side close-sweep → (2) matrix sharding → (3) direct-conn bulk writes/COPY → (4) jobs index/vacuum/partition + (6) probe_results partition → (5) incremental MV/estimated counts → (7) embed-on-close + partial HNSW. **Do #1–#2 BEFORE turning on Workday/SR-deepening**, or the first big scan blows the 30-min job. Suggested feature IDs when starting: f-108 close-sweep, f-109 sharding, f-110 bulk-writes, f-111 partitioning.

---

## 2026-06-05 · Session wrap + path-to-1M roadmap (read this first if you're new)

**Where we are now** (verified live, prod `mwcpoaefmggapztkxakp`):

| Metric | Value |
|---|---|
| Companies total / enabled | 5,165 / 3,664 |
| Active jobs | **105,706** (was ~70.5k at session start) |
| Active with description | 104,512 (98.9%) |
| Active with compensation | 12,581 |
| Active with remote | 42,964 |
| Per-source active | Greenhouse 47k · SmartRecruiters 35k · Ashby 10k · Lever 8.7k · workatastartup 4.9k |

All this session's work is on branch `claude/wizardly-mendel-BrW6a` / **PR #31** (draft). Entries below have the detail; index:
- **f-101** — Greenhouse 404 recovery (`src/recover-greenhouse-slugs.mjs`). Real recoverable pattern is cross-ATS migration, not slug-drift. 65 companies reclaimed.
- **f-102** — SmartRecruiters discovery via its public `sr-jobs/search` API (`seed/scrape-smartrecruiters.mjs`, `seed/lib.mjs`, `seed/scrape-github.mjs`). SR tenants 18 → 561.
- **Job links + enrichment** — SR url fix (was the API URL), description-cap raise + infinite-loop fix, Ashby comp-extraction fix, SR detail enrichment (`scripts/backfill-enrichment.mjs`, `fetchDetail`/`fetchJobPosting` in providers).

**⚠️ Open chores**: rotate the Supabase service-role key (shared in chat this session) + update the GH Actions secret; run `scrape-github` with a `GITHUB_TOKEN` to finish f-102's GitHub path.

### Path to 1M+ jobs (evidence-backed roadmap — discovery is the easy part, scan infra is the hard part)

Live-probed 2026-06-05. The jobs exist; getting them is a discovery + adapter problem:

**Discovery levers, ranked by yield/effort:**
1. **Deepen SmartRecruiters** — `sr-jobs/search?limit=1` reports **totalFound = 344,499**. We have 35k. Just harvest the API we already built more deeply (more keywords + geo/offset fan-out). 35k → ~300k. *Lowest effort.*
2. **Workable adapter** — `jobs.workable.com/api/v1/jobs?query=…` is **public, 200, paginated** (`nextPageToken`, `totalSize` 16k+ for "engineer"). Same "read the ATS's own index" pattern as SR; gives jobs *and* company discovery. Was wrongly deferred (f-902 said "no public API"). +100k. *Re-open f-902.*
3. **Workday adapter (f-104)** — verified `myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` POST works: NVIDIA 2,000 jobs, Red Hat 293. Per-tenant (tenant,dc,site) config is the work; discover tenants from HN/GitHub/Wayback `myworkdayjobs.com` URLs + curated list. +300–500k.
4. **Deepen Greenhouse/Lever/Ashby** — `scrape-github.mjs` (needs `GITHUB_TOKEN`) + existing `seed/scrape-wayback.mjs` CDX corpus. +150–250k.
5. **Long-tail adapters** — Recruitee, Teamtailor, Personio, JazzHR, BreezyHR, iCIMS. +100k.

SR + Workable + Workday alone clear 1M.

**The real bottleneck — scan infra (must land alongside discovery, or 1M is a one-time dump not a maintainable index):**
- **Shard the scan**: 1M ≈ 25–40k companies; the single 30-min Actions job (3,664 companies / ~8 min today) won't scale 10×. Split across parallel matrix jobs by ATS or company-hash. Blocked on ↓.
- **Server-side close-sweep**: today the scan loads *every* active job into Node (`selectAll`) to diff — a memory/time wall at 1M, and the reason the `concurrency: scan` group forbids parallel runs (double-close). Move to SQL-side "close jobs not seen this run, per company" → unblocks sharding.
- **Pooler saturation** (known 504/statement-timeout cascade): batch writes harder / `COPY` / direct transaction-pooled connection for bulk instead of the REST path.
- **Cost/storage**: 1M embeddings ≈ 6 GB vector + HNSW, ~$20–30 one-time embed; size the Supabase tier deliberately. SR/Workday/Workable need per-job detail fetches (hours at scale → accept eventual consistency).

**Recommended sequence**: (1) deepen SR + ship Workable → ~450k, low risk; (2) Workday → 1M+; (3) in parallel, server-side close-sweep + scan-sharding (the unlock). Consider promoting these into `feature_list.json` as f-106 (deepen-SR), f-107 (Workable), f-108 (scan-sharding/close-sweep) when starting.

---

## 2026-06-04 · Job links + field enrichment (SR url fix, desc-cap fix, comp/remote/dept)

Follow-on to the f-101/f-102 coverage work — making the newly-expanded SmartRecruiters rows actually usable.

**Bugs fixed**

- **SR job url pointed at the API, not the apply page** (`src/providers.mjs`). Listing's `ref` is `api.smartrecruiters.com/...` (renders as raw JSON). The listing has no applyUrl/postingUrl, so construct `jobs.smartrecruiters.com/{identifier}/{id}` (verified 200; the `careers.*` host 302s the bare id to the company landing page). Backfilled all **35,216** existing SR rows in prod; spot-checks resolve 200.
- **Description pass looped forever** (`scripts/backfill-descriptions.mjs`, `src/scan.mjs`). Candidate query filtered `description is null` but not `description_fetched_at`, so postings the provider returns with no description text were re-selected every page — the backfill `while`-loop never terminated (74k "attempted" vs a 34k backlog, churning ~148 persistent-null rows for hours). Added `description_fetched_at is null`. Verified: backfill now exits in 2s once drained.
- **Ashby comp_min/max always null** (`src/providers.mjs`). Read `salaryComp.value.*` but the numbers live directly on the component (`salaryComp.minValue/maxValue/currencyCode`); `comp_text` worked (tierSummary) so the gap was silent. Fixed; verified 109/111 on a live board.

**Enhancements**

- **Description-fetch cap** raised 500 → 3,000 default, env-configurable, `=0` unbounded, and now paginates via `selectAll` (a single `select` silently capped at 1,000). Fits the cron's 30-min budget. `scripts/backfill-descriptions.mjs` now uses a limiter-governed worker pool (~3× faster).
- **SR detail extraction** (`src/providers.mjs`): `fetchDetail()` + limiter-aware `fetchJobPosting()` pull comp / remote (onsite·hybrid·remote) / department / employment_type / location from the per-job detail endpoint (the listing omits them). The scan's per-job pass now writes these for new detail-capable jobs (non-null only). `scripts/backfill-enrichment.mjs` (+ `npm run backfill-enrichment`) fills existing rows: `--ats=smartrecruiters` (detail, resumable via `remote is null`), `--ats=ashby|lever` (re-parse listing).

**Verified state (prod)**

- Ashby enrichment: **10,142 rows updated in 159s, 0 fail, 0% block** — comp_min now on **4,321 / 10,137** (rest publish none).
- SR detail enrichment: **done** — 32,148/32,150 updated, **2 failed, 0% block, 87 min** (first attempt was killed by a session boundary at row 8, no code error; restarted, resumable). Result: SR `remote` 2.7k → **24,537** (70%; the other ~10k postings carry no location at all, left null — honest), `comp_min` 5 → **2,968** (~8.5% publish salary), `department` 22.8k, `employment_type` 34.8k.
- Data availability ceilings (honest): Greenhouse exposes neither comp nor employment_type structurally (skipped per decision); Lever comp only where the source provides it (~13%, already extracted).

**Next**: confirm the SR enrichment finished (re-run `npm run backfill-enrichment -- --ats=smartrecruiters` if the container recycled — it resumes). Same service-role-key rotation reminder stands.

---

## 2026-06-04 · f-102 slug-pool expansion — SmartRecruiters 18 → 561 tenants

**Goal**: grow scan coverage by expanding the slug pool. SmartRecruiters was the badly under-seeded source (15 slugs).

**What changed**

- `seed/lib.mjs` (new) — shared slug-discovery helpers: per-ATS host regexes (lifted from scrape-hn), the RESERVED path-segment set, `extractSlugs()`, and a non-destructive `mergeIntoSlugFile()` (union; sum hits, max latestYear). The other scrapers now reuse this.
- `seed/scrape-smartrecruiters.mjs` (new, `npm run scrape-smartrecruiters`) — **discovers SR slugs via SR's own public job-search API** (`jobs.smartrecruiters.com/sr-jobs/search`), fanning across ~50 role/industry keywords. Each result's `company.identifier` *is* the postings-API slug, and every returned slug has live postings today (self-verifying). `--load` upserts discovered SR companies straight into Supabase (additive, SR-only, preserves `enabled`).
- `seed/scrape-github.mjs` (new, `npm run scrape-github`) — GH/Lever/Ashby/SR slug harvest from GitHub. Token-gated code-search (high-yield, needs `GITHUB_TOKEN`) + an auth-free curated-raw fallback. **Not run** (no token this session; grep.app is now behind a security checkpoint so there's no auth-free GitHub index to lean on).

**Verified (live, prod `mwcpoaefmggapztkxakp`)**

- Discovery run: SR slug file **15 → 558 (+543)** in 45s. Sample probe of 25 random discovered slugs: **24 live + jobs, 1 empty, 0 fail, 1,777 jobs, 0% block-rate** (~71 jobs/tenant — SR tenants are big enterprises).
- `--load` upsert: SR companies in DB **18 → 561 enabled**; companies total **4,622 → 5,165**. All SR rows enabled, none disabled.
- Deliberately did NOT run build-seeds/load-companies: that re-INSERTs every greenhouse/lever/ashby slug from the slug files, which would resurrect the 65 dead Greenhouse rows f-101 just rewrote to another ATS. SR was loaded in isolation to avoid that regression.

**Next**: next scan folds the 543 new SR tenants into the jobs index (potentially tens of thousands of jobs before dedup). Run `scrape-github` with a `GITHUB_TOKEN` for the GH/Lever/Ashby corpus. Same service-role-key rotation reminder as below still stands.

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
