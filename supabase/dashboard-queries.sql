-- Dashboard queries for fyj_scanner.
-- Save each as a "snippet" in Supabase Studio (SQL Editor → Save).
-- The views referenced here are created by schema.sql.

-- ─── 1. Today at a glance ──────────────────────────────────────────
-- Most recent scan + headline metrics.
select * from v_recent_scans limit 1;

-- ─── 2. Recent scans (rolling 14) ──────────────────────────────────
select * from v_recent_scans;

-- ─── 3. Jobs added in the last 24h (deduped) ──────────────────────
-- Pulls from v_unique_active_jobs so re-postings of the same role
-- (same title+location at same company) show up once.
select u.*
from v_unique_active_jobs u
where u.first_seen_at > now() - interval '24 hours'
order by u.first_seen_at desc;

-- ─── 3b. Jobs added in the last 24h (raw, with duplicates) ─────────
-- Use this if you want to see every posting, including re-listings.
select * from v_jobs_last_24h order by first_seen_at desc;

-- ─── 4. Jobs added per day, last 14 days ───────────────────────────
select
  date_trunc('day', first_seen_at)::date as day,
  count(*) as new_jobs,
  count(distinct company_id) as companies_with_new_jobs
from jobs
where first_seen_at > now() - interval '14 days'
group by 1
order by 1 desc;

-- ─── 5. Top 20 active employers right now ──────────────────────────
select
  c.ats,
  c.slug,
  count(*) as active_jobs
from jobs j
join companies c on c.id = j.company_id
where j.closed_at is null
group by c.ats, c.slug
order by active_jobs desc
limit 20;

-- ─── 6. Health: companies failing 3+ scans in a row ────────────────
select
  ats, slug, consecutive_errors, last_error_at, last_error, enabled
from companies
where consecutive_errors >= 3
order by consecutive_errors desc, last_error_at desc;

-- ─── 7. Auto-disabled companies (need review) ──────────────────────
select
  ats, slug, consecutive_errors, last_error_at, last_error
from companies
where enabled = false
order by last_error_at desc nulls last;

-- ─── 8. Company 7-day health (success rate per company) ────────────
select * from v_company_health
where probes_7d > 0
order by success_rate_7d_pct asc nulls last, probes_7d desc
limit 50;

-- ─── 9. Anomaly: active-jobs delta between two most recent scans ───
-- If the delta is sharply negative, a provider probably had a partial outage.
with recent as (
  select active_jobs_after, started_at,
         lag(active_jobs_after) over (order by started_at) as prev_active
  from scans
  where status = 'ok'
  order by started_at desc
  limit 2
)
select
  started_at,
  active_jobs_after,
  prev_active,
  (active_jobs_after - prev_active) as delta,
  case when prev_active > 0
    then round(100.0 * (active_jobs_after - prev_active) / prev_active, 1)
    else null
  end as delta_pct
from recent
where prev_active is not null;

-- ─── 10. Title search (for spot-checking job content) ──────────────
-- Replace 'machine learning' with your query.
select
  j.first_seen_at,
  c.ats,
  c.slug,
  j.title,
  j.location,
  j.url
from jobs j
join companies c on c.id = j.company_id
where j.closed_at is null
  and j.title ilike '%machine learning%'
order by j.first_seen_at desc
limit 50;

-- ─── 11. Duplicate postings (same role, new IDs at same company) ──
-- Audits the dedup: top duplicate clusters within a company.
-- If "posting_count" is 2-3 it's normal (close/re-list cycle). If
-- 10+, the company is re-listing aggressively or the fingerprint is
-- too loose (drop department, change location handling).
select * from v_duplicate_postings limit 50;

-- ─── 12. Closed jobs in last 7d ────────────────────────────────────
-- Useful sanity check: confirms close-detection is firing.
select
  date_trunc('day', closed_at)::date as day,
  count(*) as closed
from jobs
where closed_at > now() - interval '7 days'
group by 1
order by 1 desc;
