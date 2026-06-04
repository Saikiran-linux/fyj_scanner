-- fyj_scanner schema
-- Paste into Supabase SQL editor and run. Idempotent.

create extension if not exists "pgcrypto";
create extension if not exists vector;

-- ── pgrst_watch: auto-reload PostgREST schema cache on DDL ─────────
-- PostgREST caches the table/column/function list in memory on startup.
-- When a column is added via raw `alter table` (which every migration
-- below does), the cache stays stale and PostgREST SILENTLY DROPS the
-- unknown column from incoming JSON bodies — upserts return 200 but the
-- new field never persists. We've been bitten by this twice (the
-- comp/remote columns and the description_summary columns).
--
-- This event trigger fires `NOTIFY pgrst, 'reload schema'` after every
-- DDL command, which PostgREST listens for and uses to invalidate its
-- cache. Standard PostgREST-recommended pattern ("the pgrst_watch
-- trigger" in their docs). Microsecond overhead per DDL, zero overhead
-- at query time.
--
-- DEFINED FIRST so that all subsequent `alter table` / `create function`
-- statements in this file already have an active watcher.
create or replace function public.pgrst_watch_ddl() returns event_trigger
language plpgsql
as $$
begin
  notify pgrst, 'reload schema';
end;
$$;

-- Event triggers don't support OR REPLACE, hence the drop-then-create.
drop event trigger if exists pgrst_watch;
create event trigger pgrst_watch
  on ddl_command_end
  execute procedure public.pgrst_watch_ddl();

-- ── companies ──────────────────────────────────────────────────────
-- One row per ATS tenant we scan. Slug + ats together are the natural key.
-- enabled=false means the scanner skips it (manual disable, or auto after
-- consecutive_errors >= 5).

create table if not exists public.companies (
  id                    uuid primary key default gen_random_uuid(),
  ats                   text not null check (ats in ('greenhouse','ashby','lever','smartrecruiters','workatastartup')),
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
-- Drives the Jobs page "active, newest first" listing. The general
-- jobs_first_seen_idx above can't skip closed rows so the planner ends up
-- scanning thousands of closed rows to fill a 50-row LIMIT.
create index if not exists jobs_active_first_seen_idx on public.jobs (first_seen_at desc) where closed_at is null;

-- ── job descriptions ───────────────────────────────────────────────
-- Plain-text job description, populated by the scanner (for providers where
-- it ships in the listing response) or by a separate per-job fetch pass.
-- Stored as text rather than in `raw` jsonb so the embedder can read it
-- cheaply without unpacking the full provider payload.
--
-- When a description is written, the row's embedding is nulled at the same
-- time so the next embedding pass re-embeds with description included.

alter table public.jobs add column if not exists description text;
alter table public.jobs add column if not exists description_fetched_at timestamptz;
-- md5 of the description text. The scanner pre-fetches this with every active
-- job at scan-start and skips the `description` field in its per-company
-- upsert when the incoming text hashes to the same value. Avoids re-sending
-- multi-KB description bodies on every scan when nothing changed — that was
-- the dominant write-volume cost on the jobs table.
alter table public.jobs add column if not exists description_hash text;

-- Lets the backfill / scan-time description pass find candidates fast.
create index if not exists jobs_description_pending_idx
  on public.jobs (company_id)
  where description is null and closed_at is null;

-- ── compensation / remote / source timestamps ──────────────────────
-- Structured fields the providers expose but we weren't capturing. The
-- intent is twofold: surface them in the UI today, and feed them into the
-- embedding text in a later pass so resume-matching has more signal than
-- just title + location.
--
-- comp_min/max/currency/interval are populated when the provider ships
-- structured comp (Ashby compensationTiers, Lever salaryRange). comp_text
-- always holds whatever free-text summary the provider shipped, so the UI
-- can fall back to it when the structured fields are null.
--
-- remote is normalised to {'remote','hybrid','onsite'} from each provider's
-- own flag (Lever workplaceType, Ashby isRemote, etc.).
--
-- source_* timestamps are the provider's own published/updated stamps —
-- distinct from our first_seen_at/last_seen_at (which track *our*
-- observation cadence).
alter table public.jobs add column if not exists comp_min            numeric;
alter table public.jobs add column if not exists comp_max            numeric;
alter table public.jobs add column if not exists comp_currency       text;
alter table public.jobs add column if not exists comp_interval       text;
alter table public.jobs add column if not exists comp_text           text;
alter table public.jobs add column if not exists remote              text;
alter table public.jobs add column if not exists source_updated_at   timestamptz;
alter table public.jobs add column if not exists source_published_at timestamptz;

-- ── description_summary ────────────────────────────────────────────
-- LLM-extracted structured precis of the job posting, populated by
-- src/summarize.mjs (gpt-4o-mini). The raw description is ~5KB of mostly
-- "About Us / mission / EEO" prose for the first ~500 chars; embedding
-- it directly meant the 1500-char window often missed the actual role
-- details. The summary is a 4-line `Role / Skills / Experience /
-- Industry` blob — dense signal optimised for resume matching.
--
-- buildJobText() reads description_summary in preference to description
-- when present, so once a row is summarised the embedding sees the
-- structured precis instead of the raw prose.
--
-- Per-scan generation is capped (SCAN_SUMMARY_CAP, default 1000) to
-- bound API spend; one-shot backfill via scripts/backfill-summaries.mjs.
alter table public.jobs add column if not exists description_summary       text;
alter table public.jobs add column if not exists description_summary_model text;
alter table public.jobs add column if not exists description_summary_at    timestamptz;

create index if not exists jobs_description_summary_pending_idx
  on public.jobs (company_id)
  where description_summary is null
    and description is not null
    and closed_at is null;

-- ── job embeddings ─────────────────────────────────────────────────
-- Populated by the scanner after upsert (and by scripts/backfill-embeddings.mjs
-- for existing rows). embedding_model is tracked so we can re-embed in batches
-- when swapping models without orphaning rows.

alter table public.jobs add column if not exists embedding vector(1536);
alter table public.jobs add column if not exists embedding_model text;
alter table public.jobs add column if not exists embedded_at timestamptz;

-- HNSW for cosine similarity. Picked over IVFFlat because:
--   - Recall: ~98% vs IVFFlat's ~90% at the same query cost
--   - Latency: p99 ~5-20ms vs IVFFlat's ~30-100ms
--   - No retuning as the table grows. IVFFlat's `lists` parameter
--     wants to be ~sqrt(rows) — we'd have to REINDEX every time the
--     row count doubled. HNSW has no equivalent knob to drift.
--   - Same query syntax (`embedding <=> vector`); zero code change.
--
-- m=16 / ef_construction=64 are pgvector defaults — well-tuned for
-- 1536-dim OpenAI embeddings at our scale. Bump them if recall ever
-- looks low; they cost build time but not query time.
create index if not exists jobs_embedding_hnsw_idx
  on public.jobs using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ── resume matching RPCs ───────────────────────────────────────────
-- Symmetric resume↔jobs cosine search over the HNSW index. The resume is
-- embedded into the SAME 1536-dim space as jobs.embedding (see
-- scripts/embed-resume.mjs), so `embedding <=> resume_vec` is a true
-- cosine distance. Both functions are STABLE and read-only.
--
-- match_resume: the original, display-oriented result set (kept for the
-- existing scripts/call-match.mjs path). match_resume_candidates: adds the
-- job `id` and `description_summary` so a second-stage LLM reranker
-- (src/rerank.mjs) can score each candidate's fit. The reranker over-fetches
-- (match_count ~50) then trims to the final top-K, so this is the function
-- the production matcher calls.
create or replace function public.match_resume(resume_vec vector, match_count integer default 30)
returns table (
  cosine_sim numeric, title text, location text, company text, ats text,
  posted date, remote text, comp_min integer, comp_max integer,
  comp_currency text, url text
) language sql stable as $$
  select
    round((1 - (j.embedding <=> resume_vec))::numeric, 4) as cosine_sim,
    j.title, j.location, c.slug as company, c.ats,
    j.first_seen_at::date as posted, j.remote, j.comp_min, j.comp_max,
    j.comp_currency, j.url
  from public.jobs j
  join public.companies c on c.id = j.company_id
  where j.closed_at is null and j.embedding is not null
  order by j.embedding <=> resume_vec
  limit match_count;
$$;

-- plpgsql (not sql) so we can raise hnsw.ef_search: the HNSW index only
-- explores ef_search candidates (default 40), which silently caps a larger
-- `match_count` at 40 rows. The web matcher over-fetches a wide pool (e.g.
-- 250) and then filters by location in app code, so we lift ef_search to
-- match_count (bounded 40..1000) for THIS call only (set_config is_local=true).
create or replace function public.match_resume_candidates(resume_vec vector, match_count integer default 50)
returns table (
  id uuid, cosine_sim numeric, title text, description_summary text,
  location text, company text, ats text, posted date, remote text,
  comp_min integer, comp_max integer, comp_currency text, url text
) language plpgsql stable as $$
begin
  perform set_config('hnsw.ef_search', greatest(40, least(match_count, 1000))::text, true);
  return query
    select
      j.id,
      round((1 - (j.embedding <=> resume_vec))::numeric, 4) as cosine_sim,
      j.title, j.description_summary, j.location, c.slug as company, c.ats,
      j.first_seen_at::date as posted, j.remote,
      -- comp_min/comp_max are numeric in the table; cast to match the integer
      -- return columns (plpgsql RETURN QUERY is strict, unlike language sql).
      j.comp_min::integer, j.comp_max::integer,
      j.comp_currency, j.url
    from public.jobs j
    join public.companies c on c.id = j.company_id
    where j.closed_at is null and j.embedding is not null
    order by j.embedding <=> resume_vec
    limit match_count;
end;
$$;

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

-- When a job's description text changes, null its embedding so the next
-- embedding pass re-embeds with the new content. Identical-description
-- writes (the common case — scanner re-sends the same text every scan)
-- pass through untouched, so we don't burn re-embedding cost on every run.
create or replace function public.invalidate_embedding_on_description_change()
returns trigger as $$
begin
  -- When the description text changes, every derivative artifact has to
  -- be regenerated: the LLM-extracted summary (so it reflects the new
  -- description) AND the embedding (which would otherwise embed the
  -- stale summary). Done in one trigger to keep the invariant atomic —
  -- nothing else nulls these fields.
  if old.description is distinct from new.description then
    new.embedding := null;
    new.embedding_model := null;
    new.embedded_at := null;
    new.description_summary := null;
    new.description_summary_model := null;
    new.description_summary_at := null;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists jobs_invalidate_embedding_on_description_change on public.jobs;
create trigger jobs_invalidate_embedding_on_description_change
  before update on public.jobs
  for each row execute function public.invalidate_embedding_on_description_change();

-- ── clean_description: SQL mirror of src/html-to-text.mjs ──────────
-- One-shot backfill primitive used to scrub HTML / entity / whitespace
-- residue from already-stored descriptions. Doing it server-side beats
-- pulling 75k rows over the wire: a single `UPDATE jobs SET description =
-- clean_description(description) WHERE ...` finishes in batches of a few
-- seconds vs. a multi-hour PATCH loop.
--
-- The authoritative implementation is src/html-to-text.mjs (htmlToText +
-- normaliseWhitespace). This function mirrors the same steps so backfilled
-- rows look identical to freshly-scanned ones:
--   1. Pre-decode HTML entities (Greenhouse double-encodes its content
--      field — without this step the tag stripper finds nothing).
--   2. Drop script/style blocks.
--   3. Block-level closing tags → newline.
--   4. Strip remaining tags.
--   5. Second-pass entity decode (catches entities that were *inside* tags).
--   6. Strip numeric entities, markdown image refs (Ashby ships
--      `[https://...png]` as text), nbsp, ZW spaces, tabs.
--   7. Collapse whitespace: max one blank line, trim each line.
--
-- IMMUTABLE so the planner can use it inside WHERE clauses without
-- re-evaluating per row. The function is the source of truth for the
-- backfill; future writes always go through the JS path via the scanner.
create or replace function public.clean_description(input text)
returns text
language plpgsql
immutable
as $$
declare
  s text;
begin
  if input is null then return null; end if;
  s := input;

  -- pre-decode pass — &amp; LAST so `&amp;lt;` correctly resolves to `<`
  -- on the second pass below.
  s := replace(s, '&lt;',     '<');
  s := replace(s, '&gt;',     '>');
  s := replace(s, '&quot;',   '"');
  s := replace(s, '&apos;',   '''');
  s := replace(s, '&nbsp;',   ' ');
  s := replace(s, '&mdash;',  '—');
  s := replace(s, '&ndash;',  '–');
  s := replace(s, '&hellip;', '…');
  s := replace(s, '&rsquo;',  '’');
  s := replace(s, '&lsquo;',  '‘');
  s := replace(s, '&rdquo;',  '”');
  s := replace(s, '&ldquo;',  '“');
  s := replace(s, '&trade;',  '™');
  s := replace(s, '&copy;',   '©');
  s := replace(s, '&reg;',    '®');
  s := replace(s, '&amp;',    '&');

  s := regexp_replace(s, '<(script|style)[^>]*>.*?</\1>', ' ', 'gis');
  s := regexp_replace(s, '<\s*br\s*/?\s*>', E'\n', 'gi');
  s := regexp_replace(s, '</\s*(p|div|li|h[1-6]|tr|td|th|section|article)\s*>', E'\n', 'gi');
  s := regexp_replace(s, '<[^>]+>', '', 'g');

  -- second decode (entities that lived as visible text inside tags)
  s := replace(s, '&lt;',     '<');
  s := replace(s, '&gt;',     '>');
  s := replace(s, '&quot;',   '"');
  s := replace(s, '&apos;',   '''');
  s := replace(s, '&nbsp;',   ' ');
  s := replace(s, '&mdash;',  '—');
  s := replace(s, '&ndash;',  '–');
  s := replace(s, '&hellip;', '…');
  s := replace(s, '&rsquo;',  '’');
  s := replace(s, '&lsquo;',  '‘');
  s := replace(s, '&rdquo;',  '”');
  s := replace(s, '&ldquo;',  '“');
  s := replace(s, '&trade;',  '™');
  s := replace(s, '&copy;',   '©');
  s := replace(s, '&reg;',    '®');
  s := replace(s, '&amp;',    '&');

  -- Numeric entities — drop. Evaluating each match would need a plpgsql
  -- loop; the JS path on next-scan write handles these correctly.
  s := regexp_replace(s, '&#x[0-9a-fA-F]+;', ' ', 'g');
  s := regexp_replace(s, '&#[0-9]+;',        ' ', 'g');

  -- Stray markdown image refs (Ashby ships `[https://…png]` as text).
  s := regexp_replace(s, '\[image:[^\]]*\]',      ' ', 'gi');
  s := regexp_replace(s, '\[https?://[^\]]+\]',   ' ', 'g');

  -- Whitespace normalisation. nbsp (U+00A0) → regular space.
  s := replace(s, chr(160), ' ');
  s := regexp_replace(s, E'\r\n?', E'\n', 'g');
  s := regexp_replace(s, '[ \t]+', ' ', 'g');
  s := regexp_replace(s, E'[ \t]+\n', E'\n', 'g');
  s := regexp_replace(s, E'\n[ \t]+', E'\n', 'g');
  s := regexp_replace(s, E'\n{3,}', E'\n\n', 'g');

  return trim(both E' \t\n\r' from s);
end;
$$;

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

-- Per-source health over the last 24h — the SLA-monitoring view.
-- Target: block_rate_pct < 1.0 for every source on a rolling basis.
create or replace view public.v_source_health_24h as
select
  c.ats as source,
  count(pr.*)                                            as probes,
  count(pr.*) filter (where pr.schema_ok)                as ok,
  count(pr.*) filter (where pr.http_status in (403, 429)) as blocked,
  count(pr.*) filter (
    where not pr.schema_ok and pr.http_status not in (403, 429)
  ) as errored,
  case when count(pr.*) > 0
    then round(100.0 * count(pr.*) filter (where pr.http_status in (403, 429)) / count(pr.*), 2)
    else 0
  end as block_rate_pct,
  case when count(pr.*) > 0
    then round(100.0 * count(pr.*) filter (where pr.schema_ok) / count(pr.*), 2)
    else 0
  end as success_rate_pct,
  round(avg(pr.latency_ms)) as avg_latency_ms,
  round(percentile_cont(0.5) within group (order by pr.latency_ms))::int  as p50_latency_ms,
  round(percentile_cont(0.95) within group (order by pr.latency_ms))::int as p95_latency_ms
from public.probe_results pr
join public.companies c on c.id = pr.company_id
where pr.created_at > now() - interval '24 hours'
group by c.ats
order by c.ats;

-- Same shape, but for an arbitrary window. Useful for ad-hoc drilldown:
--   select * from f_source_health(interval '7 days');
create or replace function public.f_source_health(p_window interval)
returns table (
  source text,
  probes bigint,
  ok bigint,
  blocked bigint,
  errored bigint,
  block_rate_pct numeric,
  success_rate_pct numeric
) language sql stable as $$
  select
    c.ats,
    count(pr.*),
    count(pr.*) filter (where pr.schema_ok),
    count(pr.*) filter (where pr.http_status in (403, 429)),
    count(pr.*) filter (where not pr.schema_ok and pr.http_status not in (403, 429)),
    case when count(pr.*) > 0
      then round(100.0 * count(pr.*) filter (where pr.http_status in (403, 429)) / count(pr.*), 2)
      else 0
    end,
    case when count(pr.*) > 0
      then round(100.0 * count(pr.*) filter (where pr.schema_ok) / count(pr.*), 2)
      else 0
    end
  from public.probe_results pr
  join public.companies c on c.id = pr.company_id
  where pr.created_at > now() - p_window
  group by c.ats
  order by c.ats;
$$;

-- Per-scan, per-source new-jobs breakdown. A "new job" is one whose
-- first_seen_at falls inside the scan's window: [started_at, next_scan.started_at).
-- The lead() runs over all ok scans (not just recent) so the window for the
-- most-recent scan correctly extends to "now" (via 'infinity'::timestamptz).
-- Window-filtered after the fact so the boundary calc stays correct.
create or replace function public.f_new_jobs_by_scan_source(p_window interval default interval '7 days')
returns table (
  scan_id uuid,
  started_at timestamptz,
  ats text,
  new_jobs bigint
) language sql stable as $$
  with windowed as (
    select id, started_at,
      coalesce(
        lead(started_at) over (order by started_at),
        'infinity'::timestamptz
      ) as next_started_at
    from public.scans
    where status = 'ok'
  )
  select w.id, w.started_at, c.ats, count(j.*)::bigint
  from windowed w
  join public.jobs j
    on j.first_seen_at >= w.started_at
   and j.first_seen_at <  w.next_started_at
  join public.companies c on c.id = j.company_id
  where w.started_at > now() - p_window
  group by w.id, w.started_at, c.ats
  order by w.started_at desc, c.ats;
$$;

-- Lifetime + trailing-window totals per source. One row per ats, even if the
-- ats has zero jobs (left join from companies).
--
-- Previously a plain view, but the live aggregate reads the full jobs heap
-- (44MB / 76k rows) on cold cache, which exceeds authenticator's 8s
-- statement_timeout after a DB restart and trips the dashboard with a 500
-- (Postgres 57014). Pre-aggregating into a materialized view drops reads
-- from ~700ms hot / >8s cold to ~0.1ms.
--
-- Refresh cadence: driven by the scanner. scan.mjs calls
-- f_refresh_totals_by_source() after each successful run, which is the
-- only time the numbers actually change. No pg_cron dependency.
-- `if not exists` so the whole file is safe to re-run against an env
-- where the MV was already created (Postgres 9.5+; we're on 17). Updates
-- to the MV definition itself go via a migration that drops and recreates.
create materialized view if not exists public.mv_jobs_totals_by_source as
select
  c.ats as source,
  count(j.id)                                                                as total_jobs,
  count(j.id) filter (where j.closed_at is null)                             as active_jobs,
  count(j.id) filter (where j.first_seen_at > now() - interval '24 hours')   as new_24h,
  count(j.id) filter (where j.first_seen_at > now() - interval '7 days')     as new_7d,
  count(j.id) filter (where j.first_seen_at > now() - interval '30 days')    as new_30d
from public.companies c
left join public.jobs j on j.company_id = c.id
group by c.ats
order by c.ats;

-- REFRESH MATERIALIZED VIEW CONCURRENTLY requires a unique index.
-- Concurrent refresh avoids the AccessExclusive lock that would block the
-- dashboard mid-refresh.
create unique index if not exists mv_jobs_totals_by_source_source_idx
  on public.mv_jobs_totals_by_source (source);

-- Thin alias so existing callers (status page, scripts) need no change.
create or replace view public.v_jobs_totals_by_source as
  select * from public.mv_jobs_totals_by_source;

-- Refresh helper called from the scanner. Owner-run (security definer) with
-- an inflated statement_timeout — REFRESH on a cold cache can take 5–10s,
-- which exceeds authenticator's 8s default.
create or replace function public.f_refresh_totals_by_source()
returns void
language plpgsql
security definer
set search_path = public
set statement_timeout = '5min'
as $$
begin
  refresh materialized view concurrently public.mv_jobs_totals_by_source;
end
$$;

grant select on public.mv_jobs_totals_by_source to anon, authenticated, service_role;
grant execute on function public.f_refresh_totals_by_source() to service_role;

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

-- ── user_profiles ──────────────────────────────────────────────────
-- One row per authenticated user. Holds the parsed resume text + embedding
-- and the hard-filter preferences used by the "For You" and "Ask" search
-- modes. RLS is on: a user can only ever see/modify their own row.
--
-- resume_storage_path points to a file in the `resumes` Storage bucket
-- (see Storage policies below). The actual PDF is never read from SQL —
-- it's parsed and embedded by the process-resume edge function on upload.

create table if not exists public.user_profiles (
  user_id              uuid primary key references auth.users(id) on delete cascade,
  resume_text          text,
  resume_embedding     vector(1536),
  resume_storage_path  text,
  preferred_locations  text[],
  remote_ok            boolean not null default true,
  min_comp             integer,
  seniority            text check (seniority is null or seniority in ('junior','mid','senior','staff','principal')),
  updated_at           timestamptz not null default now()
);

create index if not exists user_profiles_embedding_idx
  on public.user_profiles using ivfflat (resume_embedding vector_cosine_ops)
  with (lists = 10);

drop trigger if exists user_profiles_updated_at on public.user_profiles;
create trigger user_profiles_updated_at before update on public.user_profiles
  for each row execute function public.touch_updated_at();

alter table public.user_profiles enable row level security;

drop policy if exists "own profile read"   on public.user_profiles;
drop policy if exists "own profile insert" on public.user_profiles;
drop policy if exists "own profile update" on public.user_profiles;
drop policy if exists "own profile delete" on public.user_profiles;

create policy "own profile read"   on public.user_profiles for select using (auth.uid() = user_id);
create policy "own profile insert" on public.user_profiles for insert with check (auth.uid() = user_id);
create policy "own profile update" on public.user_profiles for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own profile delete" on public.user_profiles for delete using (auth.uid() = user_id);

-- ── Storage policies for the `resumes` bucket ──────────────────────
-- Create the bucket first in Supabase Studio → Storage (private, no public
-- access). Then run these policies. Convention: each user's files live under
-- a folder named after their UUID, e.g. `resumes/{user_id}/resume.pdf`.
-- The `(storage.foldername(name))[1]` extracts the first path segment.

drop policy if exists "resumes: own folder read"   on storage.objects;
drop policy if exists "resumes: own folder insert" on storage.objects;
drop policy if exists "resumes: own folder update" on storage.objects;
drop policy if exists "resumes: own folder delete" on storage.objects;

create policy "resumes: own folder read" on storage.objects
  for select using (
    bucket_id = 'resumes'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "resumes: own folder insert" on storage.objects
  for insert with check (
    bucket_id = 'resumes'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "resumes: own folder update" on storage.objects
  for update using (
    bucket_id = 'resumes'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "resumes: own folder delete" on storage.objects
  for delete using (
    bucket_id = 'resumes'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
