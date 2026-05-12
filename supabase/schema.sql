-- fyj_scanner schema
-- Paste into Supabase SQL editor and run. Idempotent.

create extension if not exists "pgcrypto";

-- ── companies ──────────────────────────────────────────────────────
-- One row per ATS tenant we scan. Slug + ats together are the natural key.
-- enabled=false means the scanner skips it (manual disable, or auto after
-- consecutive_errors >= 5).

create table if not exists public.companies (
  id                    uuid primary key default gen_random_uuid(),
  ats                   text not null check (ats in ('greenhouse','ashby','lever','smartrecruiters')),
  slug                  text not null,
  careers_url           text not null,
  probe_url             text not null,
  enabled               boolean not null default true,
  consecutive_errors    integer not null default 0,
  last_success_at       timestamptz,
  last_error_at         timestamptz,
  last_error            text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (ats, slug)
);

create index if not exists companies_enabled_idx on public.companies (enabled) where enabled = true;
create index if not exists companies_ats_idx on public.companies (ats);

-- ── jobs ───────────────────────────────────────────────────────────
-- One row per (company, external_id). Never deleted. closed_at is set when
-- a job stops appearing in the ATS response (and the company's scan that
-- run succeeded — we don't close jobs when the whole scan failed).

create extension if not exists pg_trgm;

create table if not exists public.jobs (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  external_id       text not null,
  title             text not null,
  location          text,
  url               text,
  department        text,
  employment_type   text,
  raw               jsonb,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  closed_at         timestamptz,
  -- Fingerprint of (lowercased title + location, whitespace-collapsed), set
  -- by the scanner at upsert time. Lets v_unique_active_jobs dedup the
  -- "same role, new posting ID" case (job closes and gets re-listed).
  -- Computed in app (not a generated column) so the algorithm can evolve
  -- without a DB migration — bump it and old rows just won't dedup against
  -- new ones until they're re-scanned.
  fingerprint       text,
  unique (company_id, external_id)
);

create index if not exists jobs_company_idx on public.jobs (company_id);
create index if not exists jobs_first_seen_idx on public.jobs (first_seen_at desc);
create index if not exists jobs_active_idx on public.jobs (company_id, last_seen_at desc) where closed_at is null;
create index if not exists jobs_title_trgm_idx on public.jobs using gin (title gin_trgm_ops);
create index if not exists jobs_fingerprint_idx on public.jobs (company_id, fingerprint) where closed_at is null;

-- ── scans ──────────────────────────────────────────────────────────
-- One row per scheduler invocation. Summary stats only — per-company detail
-- lives in probe_results.

create table if not exists public.scans (
  id                  uuid primary key default gen_random_uuid(),
  started_at          timestamptz not null default now(),
  ended_at            timestamptz,
  status              text not null default 'running' check (status in ('running','ok','failed')),
  companies_probed    integer default 0,
  companies_ok        integer default 0,
  companies_error     integer default 0,
  new_jobs            integer default 0,
  closed_jobs         integer default 0,
  active_jobs_after   integer default 0,
  notes               text
);

create index if not exists scans_started_idx on public.scans (started_at desc);

-- ── probe_results ──────────────────────────────────────────────────
-- One row per (scan, company). Used for monitoring and per-company history.

create table if not exists public.probe_results (
  id            bigserial primary key,
  scan_id       uuid not null references public.scans(id) on delete cascade,
  company_id    uuid not null references public.companies(id) on delete cascade,
  http_status   integer,
  schema_ok     boolean not null default false,
  error         text,
  latency_ms    integer,
  job_count     integer,
  created_at    timestamptz not null default now()
);

create index if not exists probe_results_scan_idx on public.probe_results (scan_id);
create index if not exists probe_results_company_idx on public.probe_results (company_id, created_at desc);

-- ── triggers ───────────────────────────────────────────────────────

create or replace function public.touch_updated_at() returns trigger as $$
begin
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists companies_updated_at on public.companies;
create trigger companies_updated_at before update on public.companies
  for each row execute function public.touch_updated_at();

-- ── views ──────────────────────────────────────────────────────────

create or replace view public.v_company_health as
select
  c.id,
  c.ats,
  c.slug,
  c.enabled,
  c.consecutive_errors,
  count(pr.*) filter (where pr.created_at > now() - interval '7 days')         as probes_7d,
  count(pr.*) filter (where pr.created_at > now() - interval '7 days' and pr.schema_ok) as ok_7d,
  case when count(pr.*) filter (where pr.created_at > now() - interval '7 days') = 0
    then null
    else round(
      100.0 * count(pr.*) filter (where pr.created_at > now() - interval '7 days' and pr.schema_ok)
      / count(pr.*) filter (where pr.created_at > now() - interval '7 days'),
      1
    )
  end as success_rate_7d_pct,
  c.last_success_at,
  c.last_error_at,
  c.last_error
from public.companies c
left join public.probe_results pr on pr.company_id = c.id
group by c.id;

create or replace view public.v_recent_scans as
select
  s.id,
  s.started_at,
  s.ended_at,
  extract(epoch from (s.ended_at - s.started_at))::int as duration_s,
  s.status,
  s.companies_probed,
  s.companies_ok,
  s.companies_error,
  s.new_jobs,
  s.closed_jobs,
  s.active_jobs_after
from public.scans s
order by s.started_at desc
limit 30;

create or replace view public.v_jobs_last_24h as
select
  j.id,
  c.ats,
  c.slug as company,
  j.title,
  j.location,
  j.url,
  j.first_seen_at
from public.jobs j
join public.companies c on c.id = j.company_id
where j.first_seen_at > now() - interval '24 hours'
  and j.closed_at is null
order by j.first_seen_at desc;

create or replace view public.v_active_jobs as
select
  j.id,
  c.ats,
  c.slug as company,
  j.external_id,
  j.title,
  j.location,
  j.url,
  j.fingerprint,
  j.first_seen_at,
  j.last_seen_at
from public.jobs j
join public.companies c on c.id = j.company_id
where j.closed_at is null;

-- One row per (company, fingerprint) — the *earliest* active posting wins.
-- Use this whenever you want a deduplicated view of "real" open roles, e.g.
-- "Software Engineer, Remote" at Anthropic shows once even if it's been
-- closed and re-listed under three different external IDs.
create or replace view public.v_unique_active_jobs as
select distinct on (j.company_id, j.fingerprint)
  j.id,
  c.ats,
  c.slug as company,
  j.external_id,
  j.title,
  j.location,
  j.url,
  j.department,
  j.employment_type,
  j.fingerprint,
  j.first_seen_at,
  j.last_seen_at
from public.jobs j
join public.companies c on c.id = j.company_id
where j.closed_at is null
order by j.company_id, j.fingerprint, j.first_seen_at asc;

-- Inspect duplicates: postings that share a fingerprint within a company.
-- If this view is consistently noisy, consider tightening the fingerprint
-- (e.g. include department) or loosening it (drop location).
create or replace view public.v_duplicate_postings as
select
  c.ats,
  c.slug as company,
  j.fingerprint,
  count(*) as posting_count,
  array_agg(j.title order by j.first_seen_at)         as titles,
  array_agg(j.external_id order by j.first_seen_at)   as external_ids,
  min(j.first_seen_at) as earliest_seen,
  max(j.last_seen_at)  as latest_seen
from public.jobs j
join public.companies c on c.id = j.company_id
where j.closed_at is null
group by c.ats, c.slug, j.fingerprint
having count(*) > 1
order by count(*) desc;
