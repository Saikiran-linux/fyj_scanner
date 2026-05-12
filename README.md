# fyj_scanner

Daily multi-tenant ATS scanner. Hits Greenhouse / Ashby / Lever / SmartRecruiters public APIs across ~2,500 companies, stores jobs in Supabase, tracks each job's lifecycle (new → seen → closed), and records per-scan and per-source metrics for monitoring.

Origin: this is the productionised version of the viability test in [`../fyj_scanner_test`](../fyj_scanner_test). Viability report: 75% schema-OK and 69% active across the 4 supported providers, ~13k live jobs surfaced from 500 probes — extrapolates to ~45-55k from 2,500.

## SLA targets

The scanner is designed and instrumented to hit these targets in steady state:

| # | Target | How it's measured | Where to check |
|---|---|---|---|
| 1 | **< 1% block rate** per source, sustained | `v_source_health_24h.block_rate_pct` | Dashboard query 0a |
| 2 | **≥ 50,000 unique active jobs** across all sources | `count(*) from v_unique_active_jobs` | Dashboard query 0b |
| 3 | **< 6h** since last successful scan, per source | `max(scans.ended_at) per ats` | Dashboard query 0c |

If any of these go red, dashboard queries 0a/0b/0c surface it directly. The adaptive rate limiter in [src/rate-limiter.mjs](src/rate-limiter.mjs) actively defends target #1 by halving concurrency and doubling inter-request gap whenever rolling block-rate exceeds 5% on any single provider.

## Architecture

```
GitHub Actions cron (2×/day)
        │
        ▼
   src/scan.mjs ─── reads enabled companies from Supabase
        │      ─── probes each ATS API (concurrency 20)
        │      ─── upserts jobs, closes vanished jobs
        │      ─── writes scans + probe_results rows
        ▼
   Supabase (Postgres)
        │
        ▼
   Supabase Studio dashboard (queries in supabase/dashboard-queries.sql)
```

## First-time setup

### 1. Create the database schema

In Supabase Studio → SQL Editor, open a new query, paste the contents of [`supabase/schema.sql`](supabase/schema.sql), and run. Idempotent — safe to re-run.

### 2. Add GitHub Actions secrets

In this repo's settings (Settings → Secrets and variables → Actions), add:

- `SUPABASE_URL` — your project's URL, e.g. `https://abc123.supabase.co`
- `SUPABASE_SERVICE_ROLE_KEY` — the service-role secret (or new `sb_secret_...` key)

### 3. Load the initial 500 companies

Locally, once:

```powershell
# Windows: needed because Norton intercepts Node's TLS on this machine
$env:NODE_EXTRA_CA_CERTS = "C:\Users\saiar\.career-ops\norton-root.pem"
$env:SUPABASE_URL = "https://your-project.supabase.co"
$env:SUPABASE_SERVICE_ROLE_KEY = "sb_secret_..."

node seed/build-seeds.mjs    # produces data/seeds.json from slug pool
node src/seed-companies.mjs  # uploads to Supabase
```

### 4. Trigger a first scan manually

Either:

- **In the GitHub Actions UI**: Actions → "scan" workflow → "Run workflow", or
- **Locally**: `node src/scan.mjs` with the same env vars set.

A first scan takes ~30s for 500 companies and seeds the `jobs` table with whatever is currently active.

After this, the cron at `0 */6 * * *` UTC (every 6h) runs automatically.

## Dashboard

Open [`supabase/dashboard-queries.sql`](supabase/dashboard-queries.sql) in Supabase Studio → SQL Editor. Each query is independently runnable; save the useful ones as snippets.

| Query | What it answers |
|---|---|
| 1 | Most recent scan summary |
| 2 | Last 14 scans (success / failure / job-count trend) |
| 3 | New jobs in the last 24h |
| 4 | New jobs per day, 14-day trend |
| 5 | Top 20 active employers right now |
| 6 | Companies failing 3+ scans in a row |
| 7 | Auto-disabled companies (need review) |
| 8 | 7-day per-company success rate |
| 9 | Active-jobs delta vs previous scan (anomaly detection) |
| 10 | Title search across active jobs |
| 11 | Closed-job daily volume (confirms close detection) |

## Job lifecycle

Every job has three timestamps:

- `first_seen_at` — first scan that returned this `external_id`
- `last_seen_at` — most recent scan that returned it
- `closed_at` — first scan in which the ATS *successfully responded* without listing it. Failed scans never close jobs.

A job is "active" iff `closed_at is null`. Reopens are supported: if a closed job's `external_id` reappears, `closed_at` is cleared.

## Deduplication

Jobs are deduped at two levels:

| Level | Mechanism | What it catches |
|---|---|---|
| **Exact** | `unique (company_id, external_id)` on `jobs` | Same posting seen across scans — upsert just updates `last_seen_at` |
| **Within-company role** | `fingerprint` column + `v_unique_active_jobs` view | "Software Engineer, Remote" closed and re-listed with a new `external_id` |

The fingerprint is `md5(normalize(title) + '|' + normalize(location))` where `normalize` lowercases and collapses whitespace. It's computed by the scanner ([src/fingerprint.mjs](src/fingerprint.mjs)) and stored on each job row. Two postings at the same company with the same title and location collapse to one in `v_unique_active_jobs` — the *earliest* `first_seen_at` wins.

To change the fingerprint algorithm (e.g. include department, strip job codes), bump `FINGERPRINT_VERSION` in `fingerprint.mjs` and edit the function. Old rows keep their old fingerprints until they're touched by a scan — dedup simply won't fire across the version boundary, which is the safe behavior.

Both the raw and deduped views are kept:

- **`v_jobs_last_24h`** / **`v_active_jobs`** — every posting, useful for forensics
- **`v_unique_active_jobs`** — one row per (company, role) — what to query for "what's actually open right now"
- **`v_duplicate_postings`** — audit view; lists fingerprints with >1 active posting per company

Cross-company deduplication (parent + subsidiary, RPO cross-posting) is **not** handled. That requires entity resolution on company names and a `company_group` table — defer until you actually see it as a problem in the data.

## Rate limiting and block-rate defense

The scanner uses per-source budgets, not a global concurrency setting:

| Provider | Default concurrency | Min interval between requests |
|---|---|---|
| greenhouse | 10 | 0 ms |
| ashby | 3 | 200 ms |
| lever | 5 | 100 ms |
| smartrecruiters | 3 | 100 ms |

These defaults were tuned from the viability run (Ashby was 14% blocked at 20-way uniform concurrency; Greenhouse was 0%). The limiter then **adapts at runtime**:

- Rolling 20-request block-rate **> 5%** → halve concurrency, double interval, log to console
- Rolling block-rate **< 1%** after adapting → step back toward defaults (one increment per window) to avoid oscillation
- Floor: concurrency 1, interval 50 ms. Ceiling: concurrency 20, interval 0 ms.

The limiter also honours `Retry-After` on HTTP 429 (sleeps up to 30 s before the next attempt at that provider).

After each scan, the limiter snapshot is persisted to `scans.notes` (e.g. `greenhouse: 870/883 ok, 0.0% blocked, conc=10`) so historical blocking can be queried by parsing the column.

## Per-company error handling

Each probe failure increments `companies.consecutive_errors`. On `>= 5`, the company is auto-disabled. Re-enable manually:

```sql
update companies set enabled = true, consecutive_errors = 0
where ats = 'greenhouse' and slug = 'example-co';
```

A successful probe resets the counter and clears `last_error`.

## Re-seeding (adding more companies)

The slug pool in `data/slugs-*.json` was scraped from Hacker News' "Who's Hiring" comments via the Algolia API. To refresh it:

```powershell
node seed/scrape-hn.mjs   # ~30s, queries HN Algolia
node seed/build-seeds.mjs # re-allocates 500 across the 4 providers
node src/seed-companies.mjs  # upserts; existing rows keep their enabled flag
```

To raise the target above 500: `$env:TARGET_SIZE = "1000"; node seed/build-seeds.mjs`. You'll need more slugs than we currently have for Lever/SmartRecruiters to scale much beyond 600.

## Operations runbook

**Active-jobs total dropped sharply** → check query 9. If it's <-25%, look at query 6 — likely a provider-wide hiccup (e.g. Greenhouse 5xx). Re-run the scan; the close-job sweep won't fire on failed companies.

**A company is in the disabled list but should be active** → check `last_error`. If `HTTP 404`, the slug is stale (company moved boards or rebranded). Find the new slug manually, then update:

```sql
update companies set slug = 'new-slug', probe_url = 'https://...', enabled = true, consecutive_errors = 0
where id = '<uuid>';
```

**Want to add a one-off company** →

```sql
insert into companies (ats, slug, careers_url, probe_url)
values ('greenhouse', 'example', 'https://job-boards.greenhouse.io/example',
        'https://boards-api.greenhouse.io/v1/boards/example/jobs');
```

The next scan picks it up.

## Why these 4 providers (no Workable)?

Workable's public endpoints all require a CSRF/referer header — no usable JSON API. Supporting it means an HTML-scrape adapter (Playwright dep, fragile to layout changes). Excluded from v1; can be added later if specific Workable companies become high-priority.

See [`../fyj_scanner_test/REPORT.md`](../fyj_scanner_test/REPORT.md) for the full viability data backing this decision.

## File map

```
.github/workflows/scan.yml   GitHub Actions cron + manual trigger
supabase/schema.sql          Tables, views, indexes, triggers
supabase/dashboard-queries.sql  Saved queries for Supabase Studio
src/scan.mjs                 Production scanner
src/seed-companies.mjs       One-shot loader (seeds.json → companies)
src/providers.mjs            ATS adapters (4 providers)
src/supabase-client.mjs      Bare PostgREST client (no SDK dep)
seed/scrape-hn.mjs           Scrape HN Algolia for slugs (refresh)
seed/build-seeds.mjs         Build seeds.json from slug pool
data/slugs-*.json            Per-ATS slug pool (committed)
data/seeds.json              Generated; the 500 companies to load
```
