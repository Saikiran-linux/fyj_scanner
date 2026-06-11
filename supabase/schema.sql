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

-- Content hash (sha256) of the most recently archived raw ATS response for this
-- company. The scanner compares the incoming response's hash against this to
-- skip re-uploading an unchanged board to R2 (dedupe-on-change). See
-- archiveRawResponse() in src/scan.mjs and src/r2.mjs.
alter table public.companies add column if not exists last_raw_hash text;

-- Sharding key for matrix-parallel scans (f-109). A stable hash of the company
-- id into 60 buckets [0,60). The scan workflow can fan out into N parallel
-- shards (N ≤ 60); shard i owns the contiguous bucket range
-- [floor(i*60/N), floor((i+1)*60/N)), which tiles [0,60) exactly for any N, so
-- shards are disjoint and complete. Generated/stored (md5 is immutable) so the
-- bucket is fixed for a company's lifetime and both the company list and the
-- per-shard job snapshot can be filtered by a simple indexed range. Default
-- N=1 (one shard) selects the whole range and behaves identically to today.
alter table public.companies
  add column if not exists shard smallint
  generated always as (
    ((get_byte(decode(md5(id::text), 'hex'), 0) * 256
      + get_byte(decode(md5(id::text), 'hex'), 1)) % 60)
  ) stored;
create index if not exists companies_shard_idx on public.companies (shard) where enabled = true;

-- ── jobs ───────────────────────────────────────────────────────────
-- One row per (company, external_id). Never deleted. closed_at is set when
-- a job stops appearing in the ATS response (and the company's scan that
-- run succeeded — we don't close jobs when the whole scan failed).

create extension if not exists pg_trgm;

-- HASH-partitioned by company_id (16 ways). Postgres requires the partition
-- key to be part of every unique/PK constraint; the scanner upserts on
-- (company_id, external_id), so company_id is the only viable key — and it
-- keeps dedup exact (a company's rows all live in one partition) and never
-- moves a row between partitions (company_id is immutable). The PK is
-- therefore (id, company_id). Existing databases were converted in place by
-- supabase/migrations/0001_partition_jobs_by_company.sql; on a fresh database
-- this CREATE + the partition statements below build it directly.
create table if not exists public.jobs (
  id                uuid not null default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  external_id       text not null,
  title             text not null,
  location          text,
  url               text,
  department        text,
  employment_type   text,
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
  primary key (id, company_id),
  unique (company_id, external_id)
) partition by hash (company_id);

do $$
begin
  for i in 0..15 loop
    execute format(
      'create table if not exists public.jobs_p%1$s partition of public.jobs for values with (modulus 16, remainder %1$s)',
      i);
  end loop;
end $$;

create index if not exists jobs_company_idx on public.jobs (company_id);
create index if not exists jobs_first_seen_idx on public.jobs (first_seen_at desc);
-- Covering index for f_new_jobs_by_scan_source(): it range-joins jobs by
-- first_seen_at and needs only company_id alongside. With the first_seen-only
-- index above the planner heap-fetched every matched row (each carries the
-- ~6KB embedding vector) just to read company_id — ~57k wide fetches that
-- pushed the dashboard RPC past the 8s authenticator timeout (Postgres 57014).
-- (first_seen_at, company_id) lets that scan stay in the index.
create index if not exists jobs_first_seen_company_idx on public.jobs (first_seen_at, company_id);
create index if not exists jobs_active_idx on public.jobs (company_id, last_seen_at desc) where closed_at is null;
create index if not exists jobs_title_trgm_idx on public.jobs using gin (title gin_trgm_ops);
create index if not exists jobs_fingerprint_idx on public.jobs (company_id, fingerprint) where closed_at is null;
-- Drives the Jobs page "active, newest first" listing. The general
-- jobs_first_seen_idx above can't skip closed rows so the planner ends up
-- scanning thousands of closed rows to fill a 50-row LIMIT.
create index if not exists jobs_active_first_seen_idx on public.jobs (first_seen_at desc) where closed_at is null;

-- The `raw jsonb` column was declared but never populated (raw responses now
-- live in R2, archived per-company by the scanner — see raw_archive below).
-- Drop it on existing databases; harmless if already gone.
alter table public.jobs drop column if exists raw;

-- ── raw response archive ────────────────────────────────────────────
-- One row per DISTINCT raw ATS response we've stored, per company. The scanner
-- writes the gzipped response bytes to Cloudflare R2 (src/r2.mjs) and records a
-- pointer here. Content-addressed: the primary key is (company_id, sha256 of the
-- response bytes), so identical re-fetches dedupe to a single object/row and
-- only a CHANGED board adds a new version. This is the replay / audit /
-- analytics source — re-parsing reads r2_key back through provider.parse().
create table if not exists public.raw_archive (
  company_id    uuid not null references public.companies(id) on delete cascade,
  ats           text not null,
  content_hash  text not null,                       -- sha256 of the raw response bytes
  r2_key        text not null,                       -- object path in the R2 bucket
  bytes         integer,                             -- gzipped object size
  job_count     integer,                             -- jobs parsed from this response
  last_scan_id  uuid,                                -- most recent scan that saw this exact payload
  created_at    timestamptz not null default now(),  -- first time this version was archived
  last_seen_at  timestamptz not null default now(),  -- most recent time it was seen
  primary key (company_id, content_hash)
);
create index if not exists raw_archive_company_idx on public.raw_archive (company_id, last_seen_at desc);
create index if not exists raw_archive_ats_idx on public.raw_archive (ats, created_at desc);

-- ── server-side close-sweep (f-108) ─────────────────────────────────
-- Close every still-open job for ONE company that the current scan didn't
-- re-list. The scanner stamps last_seen_at on every job it sees this run
-- (always strictly later than the run's watermark), so any open row for the
-- company whose last_seen_at predates the watermark is one the ATS no longer
-- lists → close it.
--
-- This replaces the old client-side diff (load every active job into Node,
-- compute a set difference, then PATCH a potentially huge external_id IN-list
-- over REST). Keeping the sweep server-side and keyed on
-- (company_id, last_seen_at) means:
--   • no unbounded IN-list payload per company (the index jobs_active_idx
--     already covers exactly this predicate),
--   • it is idempotent — re-running closes nothing new,
--   • it touches only one company's rows, so a sharded scan that partitions
--     companies across parallel jobs can never double-close another shard's
--     jobs. That non-overlap is the prerequisite for matrix-sharding the
--     scan (f-109).
--
-- CALLER CONTRACT: invoke this ONLY for a company whose probe SUCCEEDED this
-- run, and pass the watermark captured BEFORE any upsert. Calling it for a
-- company that wasn't probed (or with now() as the watermark) would close
-- that company's entire active set, since none of its rows were re-stamped.
-- Returns the number of rows closed so the scanner can keep its totals.
create or replace function public.close_unseen_jobs(
  p_company_id uuid,
  p_scan_start timestamptz
) returns integer
language sql
as $$
  with closed as (
    update public.jobs
       set closed_at = now()
     where company_id = p_company_id
       and closed_at is null
       and last_seen_at < p_scan_start
    returning 1
  )
  select count(*)::integer from closed;
$$;

-- ── job descriptions ───────────────────────────────────────────────
-- Description metadata kept on jobs. The TEXT itself lives in job_descriptions
-- (below) — f-119: jobs never stores it. description_hash is an md5 of the
-- text, written by the scanner at fetch/upsert time; it drives both the skip
-- optimisation (write the text to job_descriptions only when the hash changes)
-- and the embedding-invalidation trigger. description_fetched_at records that a
-- per-job fetch was attempted (so persistent-null postings aren't re-fetched).
alter table public.jobs add column if not exists description_fetched_at timestamptz;
alter table public.jobs add column if not exists description_hash text;

-- Lets the per-job description fetch pass find never-attempted rows fast.
create index if not exists jobs_description_pending_idx
  on public.jobs (company_id)
  where description_fetched_at is null and closed_at is null;

-- job_descriptions is the canonical (and only) home for description text
-- (f-119): the multi-KB text is the TOAST-heavy part of a job row, so keeping
-- it out of the hot jobs table keeps scans/backups small. The scanner writes
-- this table directly (src/scan.mjs upsert + per-job fetch pass); readers go
-- through v_jobs_enriched (below). jobs has NO description column.
create table if not exists public.job_descriptions (
  job_id      uuid primary key,
  company_id  uuid not null,
  description text not null,
  updated_at  timestamptz not null default now()
);
create index if not exists job_descriptions_company_idx on public.job_descriptions (company_id);

-- Readers select from this instead of jobs so `description` resolves from
-- job_descriptions, decoupled from whether jobs.description is populated.
-- Column list mirrors jobs EXCEPT description (sourced from the join).
create or replace view public.v_jobs_enriched as
select
  j.id, j.company_id, j.external_id, j.title, j.location, j.url,
  j.department, j.employment_type,
  j.first_seen_at, j.last_seen_at, j.closed_at, j.fingerprint,
  j.embedding, j.embedding_model, j.embedded_at,
  j.description_fetched_at, j.description_hash,
  j.comp_min, j.comp_max, j.comp_currency, j.comp_interval, j.comp_text,
  j.remote, j.source_updated_at, j.source_published_at,
  j.description_summary, j.description_summary_model, j.description_summary_at,
  j.job_family, j.is_target, j.seniority, j.classified_at, j.classified_by,
  jd.description
from public.jobs j
left join public.job_descriptions jd on jd.job_id = j.id;
grant select on public.v_jobs_enriched to anon, authenticated, service_role;

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

-- Speeds the summary pass's candidate scan (it then joins job_descriptions via
-- v_jobs_enriched to require description-present). No description ref here —
-- the text isn't on jobs (f-119).
create index if not exists jobs_description_summary_pending_idx
  on public.jobs (company_id)
  where description_summary is null
    and closed_at is null;

-- ── job embeddings ─────────────────────────────────────────────────
-- Populated by the scanner after upsert (and by scripts/backfill-embeddings.mjs
-- for existing rows). embedding_model is tracked so we can re-embed in batches
-- when swapping models without orphaning rows.

alter table public.jobs add column if not exists embedding vector(1536);
alter table public.jobs add column if not exists embedding_model text;
alter table public.jobs add column if not exists embedded_at timestamptz;

-- ── job relevance classification (f-113) ───────────────────────────
-- Tags each job with a coarse role family + whether it's a "target" role for
-- our customer base (tech/IT professionals, knowledge-workers, senior/exec
-- leadership, students/interns in those fields) vs blue-collar/service/retail/
-- clinical roles they'd never pay us to find a job for. Classification is by
-- the ROLE, never the employer's industry. Populated by src/classify.mjs (free
-- high-precision rules) + gpt-4o-mini for the ambiguous middle, via
-- scripts/backfill-classification.mjs and the scan's per-job pass.
--
-- is_target semantics: true = surface to customers; false = hide (known noise);
-- NULL = not yet classified — treated as "maybe" and still surfaced, so an
-- unclassified backlog never hides good jobs. Only is_target=false is filtered
-- out of matching.
alter table public.jobs add column if not exists job_family    text;
alter table public.jobs add column if not exists is_target     boolean;
alter table public.jobs add column if not exists seniority     text;
alter table public.jobs add column if not exists classified_at timestamptz;
alter table public.jobs add column if not exists classified_by text;  -- 'rules' | 'llm'

-- Drives the "active, surfaceable jobs" filter used by matching + dashboards.
create index if not exists jobs_target_active_idx on public.jobs (job_family)
  where closed_at is null and is_target is not false;

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
  -- is_target is not false: surface target roles AND not-yet-classified ones,
  -- hide only known-noise (blue-collar/service/retail/clinical) per f-113.
  where j.closed_at is null and j.embedding is not null and j.is_target is not false
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
    -- is_target is not false: hide only known-noise; keep unclassified visible (f-113).
    where j.closed_at is null and j.embedding is not null and j.is_target is not false
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

-- Which shard of a matrix-parallel scan cycle wrote this row (f-109). A sharded
-- cycle produces shard_count rows (one per shard) sharing a near-identical
-- started_at; the dashboard groups a cycle by that. Default 0/1 = unsharded.
alter table public.scans add column if not exists shard_index integer not null default 0;
alter table public.scans add column if not exists shard_count integer not null default 1;

-- Probe succeeded (HTTP+schema ok) but the per-company DB upsert failed. This
-- is the blind spot that hid the PGRST102 freeze (f-112) for 19 days: such
-- companies count in neither companies_ok nor companies_error. Tracked as a
-- first-class metric so the dashboard freeze-detector (query 6b) and the scan's
-- own fail-fast guardrail can act on it.
alter table public.scans add column if not exists companies_write_failed integer default 0;

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

-- When a job's description text changes, null its embedding + summary so the
-- next enrichment passes regenerate them. Keyed off description_hash, not the
-- text itself: the text no longer lives on jobs (f-119 step 3 — it's diverted
-- to job_descriptions), but the scanner still stamps a fresh description_hash
-- whenever the text changes, so the hash is the durable change signal.
-- Identical-description writes leave the hash unchanged and pass through
-- untouched, so we don't burn re-embedding cost on every scan.
create or replace function public.invalidate_embedding_on_description_change()
returns trigger as $$
begin
  if old.description_hash is distinct from new.description_hash then
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

-- Canonical scans projection. Identical to the scans table EXCEPT `new_jobs`,
-- which we recompute as the first_seen_at-window count — the SAME definition the
-- "new jobs by source" panel uses (f_new_jobs_by_scan_source). Every dashboard
-- surface (overview, recent scans, all-scans list, scan detail, trend charts)
-- reads scan rows through this view so they can never disagree on "new".
--
-- Why not scans.new_jobs (the live per-scan counter)? It tallies every listed
-- posting absent from the pre-scan open-job snapshot, which by design also
-- re-counts *reopened* postings (closed, then re-listed by the ATS). When a batch
-- of jobs is transiently closed and reappears, the counter over-counts — we
-- observed single scans reporting 16k–34k "new" while the active index
-- (new − closed) barely moved and only ~100–700 postings had a fresh
-- first_seen_at. The window count is anchored to first_seen_at, a persisted fact,
-- so it stays truthful and matches the active-jobs delta. The raw counter is kept
-- as new_jobs_reported for ops debugging.
--
-- Window: the scan's OWN runtime [started_at, ended_at] — the same definition as
-- f_new_jobs_by_scan_source, so per-scan totals line up across panels. The
-- correlated count is index-backed (jobs_first_seen_company_idx) and only
-- evaluated for rows a query actually returns (PostgREST applies LIMIT/Range
-- before the select-list subquery runs), so paginated reads stay cheap. Columns
-- mirror scans 1:1 in order/type so `select *` callers and `create or replace`
-- are both unaffected; the derived new_jobs_reported is appended last.
create or replace view public.v_scans as
select
  s.id,
  s.started_at,
  s.ended_at,
  s.status,
  s.companies_probed,
  s.companies_ok,
  s.companies_error,
  coalesce(
    case when s.status = 'ok' and s.shard_index = 0 then (
      select count(*)
      from public.jobs j
      where j.first_seen_at >= s.started_at
        and j.first_seen_at <= s.ended_at
    ) end,
    s.new_jobs
  )::int as new_jobs,
  s.closed_jobs,
  s.active_jobs_after,
  s.notes,
  s.companies_write_failed,
  s.shard_index,
  s.shard_count,
  s.new_jobs as new_jobs_reported
from public.scans s;

-- The 30 most recent scans with a derived duration — same corrected new_jobs
-- definition as v_scans (runtime window [started_at, ended_at]), so the overview's
-- RECENT SCANS table and sparkline match the by-source panel. This is the
-- overview's hot path (auto-refreshes every 30s), so it is deliberately NOT a thin
-- wrapper over v_scans: it picks the 30 rows FIRST (the `recent` CTE) and only then
-- runs the windowed count, so the cost is fixed at 30 subquery evaluations
-- regardless of how large the scans table grows. (Reading through v_scans would
-- evaluate the subquery for every scan ever run.)
create or replace view public.v_recent_scans as
with recent as (
  select * from public.scans order by started_at desc limit 30
)
select
  r.id,
  r.started_at,
  r.ended_at,
  extract(epoch from (r.ended_at - r.started_at))::int as duration_s,
  r.status,
  r.companies_probed,
  r.companies_ok,
  r.companies_error,
  coalesce(
    case when r.status = 'ok' and r.shard_index = 0 then (
      select count(*)
      from public.jobs j
      where j.first_seen_at >= r.started_at
        and j.first_seen_at <= r.ended_at
    ) end,
    r.new_jobs
  )::int as new_jobs,
  r.closed_jobs,
  r.active_jobs_after,
  r.new_jobs as new_jobs_reported
from recent r
order by r.started_at desc;

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
-- first_seen_at falls inside the scan's OWN RUNTIME: [started_at, ended_at].
-- Jobs are only ever inserted while a scan is probing, so each posting is
-- attributed to exactly the scan that discovered it.
--
-- We deliberately do NOT window as [started_at, next_scan.started_at): that made
-- the most-recent ok scan's window run to "now"/infinity, so it swallowed every
-- job the *next, still-running* scan inserted before it flipped to ok — inflating
-- the latest row (observed 4,250 vs a true 1,499) and breaking new − closed ≈
-- Δactive. Runtime-bounding is exact for back-to-back scans (identical result)
-- and correct for the latest one.
create or replace function public.f_new_jobs_by_scan_source(p_window interval default interval '7 days')
returns table (
  scan_id uuid,
  started_at timestamptz,
  ats text,
  new_jobs bigint
) language sql stable as $$
  -- count(*) not count(j.*): the latter references the whole composite row,
  -- which stops the planner doing an index-only scan and makes it heap-fetch
  -- every matched (wide, embedding-bearing) row just to count it. count(*)
  -- needs only first_seen_at (range) + company_id (join), both covered by
  -- jobs_first_seen_company_idx.
  --
  -- shard_index = 0 only: a sharded cycle (f-109) writes shard_count rows; shard 0
  -- always runs and represents the cycle. Unsharded (the current deployment) it's
  -- a no-op since shard_index is always 0.
  select s.id, s.started_at, c.ats, count(*)::bigint
  from public.scans s
  join public.jobs j
    on j.first_seen_at >= s.started_at
   and j.first_seen_at <= s.ended_at
  join public.companies c on c.id = j.company_id
  where s.status = 'ok' and s.shard_index = 0
    and s.started_at > now() - p_window
  group by s.id, s.started_at, c.ats
  order by s.started_at desc, c.ats;
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
exception when others then
  -- REFRESH ... CONCURRENTLY errors when the MV has never been populated
  -- (e.g. created WITH NO DATA, or a failed initial load). When that happens
  -- the concurrent refresh fails on every scan and the MV stays EMPTY — which
  -- silently zeroed the whole dashboard (ACTIVE JOBS 0, "no scans"). Fall back
  -- to a plain refresh, which populates it and lets later concurrent refreshes
  -- work again.
  refresh materialized view public.mv_jobs_totals_by_source;
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
