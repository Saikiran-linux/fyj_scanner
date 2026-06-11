-- Dashboard queries for fyj_scanner.
-- Save each as a "snippet" in Supabase Studio (SQL Editor → Save).
-- The views referenced here are created by schema.sql.

-- ─── SLA monitoring ────────────────────────────────────────────────
-- Hard targets:
--   1. block_rate_pct  < 1.0 sustained per source
--   2. unique_active_jobs ≥ 50,000 across all sources
--   3. last full scan completed within < 6h per source

-- 0a. SLA: block rate per source over last 24h.
-- RED if > 1.0%, AMBER if 0.5-1.0%, GREEN otherwise.
select
  source,
  probes,
  blocked,
  block_rate_pct,
  success_rate_pct,
  case
    when block_rate_pct > 1.0 then 'RED'
    when block_rate_pct > 0.5 then 'AMBER'
    else 'GREEN'
  end as block_sla
from v_source_health_24h;

-- 0b. SLA: total unique active jobs.
-- Target: ≥ 50,000.
select
  count(*) as unique_active_jobs,
  case when count(*) >= 50000 then 'GREEN' else 'RED' end as volume_sla
from v_unique_active_jobs;

-- 0c. SLA: most recent successful scan per source.
-- Target: < 6h ago.
select
  c.ats as source,
  max(s.ended_at) as last_success_at,
  extract(epoch from (now() - max(s.ended_at)))::int / 60 as minutes_since,
  case
    when max(s.ended_at) > now() - interval '6 hours' then 'GREEN'
    when max(s.ended_at) > now() - interval '12 hours' then 'AMBER'
    else 'RED'
  end as freshness_sla
from scans s
join probe_results pr on pr.scan_id = s.id
join companies c on c.id = pr.company_id
where s.status = 'ok' and pr.schema_ok
group by c.ats
order by c.ats;

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

-- ─── 6b. FREEZE DETECTOR: probe-ok-but-write-failed + stale-open ───
-- The signal that was missing when the PGRST102 bug (f-112) froze ~1.1k
-- companies for 19 days. Two complementary lenses:
--   (a) recent scans where companies were probed ok but their DB write
--       failed (companies_write_failed) — the scan now also fails-fast and
--       goes red above 5%, but this shows the trend.
--   (b) "zombie-open" jobs: still open, belong to an enabled company, yet
--       last_seen_at is far older than the most recent successful scan —
--       i.e. the company is being probed but its rows aren't refreshing.
-- Either being non-trivial and persistent means writes are silently failing.
select 'recent_scan_write_failures' as lens, started_at::text as k,
       companies_write_failed::text as v,
       round(100.0*companies_write_failed/nullif(companies_probed,0),1)||'%' as pct
from public.scans
where started_at > now() - interval '2 days' and status in ('ok','failed')
order by started_at desc
limit 10;

-- (b) zombie-open jobs per enabled company (run separately):
-- select c.ats, c.slug, count(*) as zombie_open,
--        to_char(max(j.last_seen_at),'MM-DD HH24:MI') as newest_last_seen
-- from public.jobs j
-- join public.companies c on c.id = j.company_id
-- where j.closed_at is null and c.enabled = true
--   and j.last_seen_at < (select max(started_at) from public.scans where status='ok') - interval '12 hours'
-- group by 1,2 order by zombie_open desc limit 50;

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
