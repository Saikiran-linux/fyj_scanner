# fyj_scanner — TODO

Forward-looking work. Done items live in git history, not here.

Format: `[priority] title — why · what it touches`

Priorities:
- **P0** — blocks first useful week of operation
- **P1** — clear value, do after we have ≥7 days of data
- **P2** — speculative; revisit only if the data shows we need it
- **DEFERRED** — explicitly decided not to do; reasoning recorded so we don't relitigate

---

## Bootstrap (must finish before cron is useful)

- [ ] **[P0] Run `schema.sql` in Supabase Studio** — creates 4 tables + 4 views + indexes
- [ ] **[P0] Add `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` to GitHub Actions secrets** — `Settings → Secrets and variables → Actions`
- [ ] **[P0] Run `node src/seed-companies.mjs` once locally** — uploads the 500-row seed list to `companies`
- [ ] **[P0] Trigger first manual scan** — GitHub Actions UI → "scan" → Run workflow. Verifies end-to-end DB writes before cron takes over.
- [ ] **[P0] Save the 12 queries in [`supabase/dashboard-queries.sql`](supabase/dashboard-queries.sql) as Supabase Studio snippets** — so the dashboard is one click away

## Reliability (first week)

- [ ] **[P1] Greenhouse 404 recovery** — 132 of 254 Greenhouse seeds 404'd in the viability run because the slug drifted (`notion` → maybe `notion-labs`?). Add a one-shot script that tries 2-3 slug variations and rewrites the row if a variant succeeds. · `src/recover-greenhouse-slugs.mjs` (new)
- [ ] **[P1] Re-seed more aggressively** — scrape more sources to grow the pool beyond HN (LinkedIn careers pages, AngelList/Wellfound, the YC company list). Today's 1,380-slug pool caps us around ~600 supported companies. · `seed/scrape-*.mjs` (new sources)
- [ ] **[P1] Document operator checklist for first 7 days** — what to look at in the dashboard each day, what's normal vs alarming · `docs/operations.md` (new)
- [ ] **[P2] Per-provider concurrency caps** — Ashby p95 is 3.5s; running 20-wide hammers them. Stagger by provider once we see whether they rate-limit. · `src/scan.mjs`

## Coverage (after we know what's missing)

- [ ] **[P1] Workday adapter** — biggest unsupported ATS by enterprise share. JSON API exists at `/wday/cxs/{tenant}/{site}/jobs` but requires tenant+site pair, which doesn't follow a uniform URL pattern. · `src/providers.mjs` + new slug source
- [ ] **[P2] Workable HTML-scrape adapter** — recovers ~70 of the 104 Workable companies we dropped. Adds Playwright dep and HTML-layout fragility. Only worth it if specific Workable companies become high-priority. · `src/providers.mjs` + new dep
- [ ] **[P2] BambooHR / JazzHR / Personio / Recruitee adapters** — long tail; each adds ~20-50 companies. Add when we see the slug pool surface them. · `src/providers.mjs`

## Deduplication (decide after seeing real noise)

- [x] ~~Within-company dedup (same role, new external_id)~~ — done via `fingerprint` + `v_unique_active_jobs`
- [ ] **[P2] Cross-company dedup** — parent/subsidiary, RPO cross-posting. Needs `company_group` table + name-resolution. Trigger to actually build: query 5 (top active employers) shows obvious dupes after week 1. · new table + view, name-norm logic
- [ ] **[P2] Tune fingerprint** — if `v_duplicate_postings` (query 11) shows many false positives, consider including department; if many false negatives (close-and-relist not collapsing), strip job-code suffixes like `(R4637)`, `[REMOTE]`. Bump `FINGERPRINT_VERSION`. · `src/fingerprint.mjs`

## Filtering & notifications (week 2+)

- [ ] **[P1] Title filter at query time, not scan time** — store everything, filter in SQL views. Decide which positive/negative keywords belong. · `supabase/schema.sql` (new view) + `supabase/dashboard-queries.sql`
- [ ] **[P2] Notification on new matching jobs** — once a title filter exists, fire a Slack/Discord webhook when `v_unique_active_jobs ∩ filter` gets new rows since last alert. · new `src/notify.mjs` + workflow
- [ ] **[P2] Salary parsing** — Ashby returns `includeCompensation=true` already; Greenhouse/Lever sometimes embed it in `description`. Parse into structured `salary_min` / `salary_max` / `currency` columns for filtering. · `src/providers.mjs` + schema

## Cost & ops monitoring (low priority unless something explodes)

- [ ] **[P2] DB row-count watchdog** — Supabase free tier is 500MB. Once `jobs` grows past ~200k rows, alert. · query in `dashboard-queries.sql`
- [ ] **[P2] GitHub Actions minute budget** — free tier is 2,000 min/mo for private repos; current ~1 min/run × 60 runs/mo = ~60 min, no risk. Revisit if cadence increases. · no action yet
- [ ] **[P2] Vacuum old probe_results** — at 2 scans/day × 500 companies = 1,000 rows/day = 365k/year. Keep last 90 days, archive the rest. Trigger when `probe_results` > 500k rows. · new cron / SQL function

## DEFERRED — decided not to do

- **Workable in v1** — no public JSON API; needs HTML scrape (Playwright dep + fragile). Excluded after viability test showed 0/104 success. Revisit only if a high-value Workable company shows up.
- **Wayback CDX as slug source** — returns 503/504 on every wildcard query for high-volume hosts. HN Algolia is the replacement; `seed/scrape-wayback.mjs` stays in the test repo for reference.
- **Title filtering at scan time** — would force everyone to share the same filter and lose data. Filter at query time instead.
- **Cross-company dedup** — defer until we see it in the data. Adding entity resolution prematurely is expensive and easy to get wrong.
