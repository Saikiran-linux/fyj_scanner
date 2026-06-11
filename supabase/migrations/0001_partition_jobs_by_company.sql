-- One-time migration: convert public.jobs into a 16-way HASH-partitioned
-- table keyed on company_id.
--
-- Why hash(company_id): Postgres requires every unique/PK constraint on a
-- partitioned table to include the partition key. The scanner upserts with
-- ON CONFLICT (company_id, external_id) (src/scan.mjs), so the partition key
-- MUST be a subset of that constraint. company_id is the only viable choice;
-- it also (a) keeps dedup exact — all of a company's rows live in one
-- partition, so per-partition uniqueness == global uniqueness — and (b) never
-- changes for a row, so closing a job never moves it between partitions.
--
-- Postgres cannot convert a table to partitioned in place, so this builds a
-- new partitioned table, copies every row under an ACCESS EXCLUSIVE lock (no
-- lost writes from a concurrent scan), then atomically swaps names and
-- recreates EXACTLY the live dependents (indexes, both triggers, the six
-- jobs-dependent views, the totals materialized view + alias + grants).
-- Definitions were captured from the live database, not schema.sql, because
-- prod had drifted (jobs_sync_description trigger, v_scans, the jobs-aware
-- v_recent_scans). The whole thing is ONE transaction: any error rolls the
-- entire migration back and leaves jobs untouched.
--
-- Index/constraint names collide with the live table while it still exists, so
-- the new table is created with auto-generated constraint names and the
-- secondary indexes are built AFTER the old table is dropped (which frees the
-- canonical names); the PK/unique indexes are then renamed to canonical.
--
-- Idempotency note: this is a one-shot. Re-running after a successful apply
-- would simply re-partition the (already partitioned) table — wasteful but
-- not corrupting. Verify pg_partitioned_table before re-running.
--
-- statement_timeout MUST be cleared on the SESSION before the DO block: the
-- timeout is latched when the top-level statement (the DO) starts, so setting
-- it from inside the block is too late (the ~120s copy gets cancelled). This
-- line has to run as its own statement in the same connection as the DO.
set statement_timeout = 0;

do $$
declare i int;
begin
  lock table public.jobs in access exclusive mode;         -- block the scanner for the swap window

  -- 1) partitioned parent. Constraints are left UNNAMED (auto: jobs_new_pkey,
  --    jobs_new_company_id_external_id_key) to avoid colliding with the live
  --    jobs constraints; renamed to canonical below after the swap.
  create table public.jobs_new (
    id                        uuid not null default gen_random_uuid(),
    company_id                uuid not null references public.companies(id) on delete cascade,
    external_id               text not null,
    title                     text not null,
    location                  text,
    url                       text,
    department                text,
    employment_type           text,
    first_seen_at             timestamptz not null default now(),
    last_seen_at              timestamptz not null default now(),
    closed_at                 timestamptz,
    fingerprint               text,
    embedding                 vector(1536),
    embedding_model           text,
    embedded_at               timestamptz,
    description               text,
    description_fetched_at     timestamptz,
    description_hash          text,
    comp_min                  numeric,
    comp_max                  numeric,
    comp_currency             text,
    comp_interval             text,
    comp_text                 text,
    remote                    text,
    source_updated_at         timestamptz,
    source_published_at       timestamptz,
    description_summary       text,
    description_summary_model  text,
    description_summary_at     timestamptz,
    job_family                text,
    is_target                 boolean,
    seniority                 text,
    classified_at             timestamptz,
    classified_by             text,
    primary key (id, company_id),
    unique (company_id, external_id)
  ) partition by hash (company_id);

  for i in 0..15 loop
    execute format(
      'create table public.jobs_p%1$s partition of public.jobs_new for values with (modulus 16, remainder %1$s)',
      i);
  end loop;

  -- 2) copy every row (consistent snapshot under the lock)
  insert into public.jobs_new (
    id, company_id, external_id, title, location, url, department, employment_type,
    first_seen_at, last_seen_at, closed_at, fingerprint,
    embedding, embedding_model, embedded_at,
    description, description_fetched_at, description_hash,
    comp_min, comp_max, comp_currency, comp_interval, comp_text,
    remote, source_updated_at, source_published_at,
    description_summary, description_summary_model, description_summary_at,
    job_family, is_target, seniority, classified_at, classified_by)
  select
    id, company_id, external_id, title, location, url, department, employment_type,
    first_seen_at, last_seen_at, closed_at, fingerprint,
    embedding, embedding_model, embedded_at,
    description, description_fetched_at, description_hash,
    comp_min, comp_max, comp_currency, comp_interval, comp_text,
    remote, source_updated_at, source_published_at,
    description_summary, description_summary_model, description_summary_at,
    job_family, is_target, seniority, classified_at, classified_by
  from public.jobs;

  -- 3) swap. CASCADE drops the dependent views + MV (recreated below) and the
  --    old indexes (freeing their names); the trigger FUNCTIONS are not
  --    table-dependent and survive.
  drop table public.jobs cascade;
  alter table public.jobs_new rename to jobs;
  alter index public.jobs_new_pkey rename to jobs_pkey;
  alter index public.jobs_new_company_id_external_id_key rename to jobs_company_id_external_id_key;

  -- 4) indexes, now with canonical names (old jobs is gone). Build after the
  --    bulk copy so the load isn't slowed maintaining them. Propagate to every
  --    partition.
  create index jobs_company_idx                  on public.jobs (company_id);
  create index jobs_first_seen_idx               on public.jobs (first_seen_at desc);
  create index jobs_first_seen_company_idx       on public.jobs (first_seen_at, company_id);
  create index jobs_active_idx                   on public.jobs (company_id, last_seen_at desc) where closed_at is null;
  create index jobs_title_trgm_idx               on public.jobs using gin (title gin_trgm_ops);
  create index jobs_fingerprint_idx              on public.jobs (company_id, fingerprint) where closed_at is null;
  create index jobs_active_first_seen_idx        on public.jobs (first_seen_at desc) where closed_at is null;
  create index jobs_description_pending_idx      on public.jobs (company_id) where description is null and closed_at is null;
  create index jobs_description_summary_pending_idx on public.jobs (company_id)
    where description_summary is null and description is not null and closed_at is null;
  create index jobs_target_active_idx            on public.jobs (job_family) where closed_at is null and is_target is not false;
  create index jobs_embedding_hnsw_idx           on public.jobs using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

  -- 5) grants (Supabase default: full privileges to the API roles)
  grant all on public.jobs to anon, authenticated, service_role;

  -- 6) triggers (functions survived the drop)
  create trigger jobs_invalidate_embedding_on_description_change
    before update on public.jobs
    for each row execute function public.invalidate_embedding_on_description_change();
  create trigger jobs_sync_description
    after insert or update of description on public.jobs
    for each row execute function public.sync_job_description();

  -- 7) dependent views (verbatim live definitions)
  create view public.v_active_jobs as
    select j.id, c.ats, c.slug as company, j.external_id, j.title, j.location, j.url,
           j.fingerprint, j.first_seen_at, j.last_seen_at
    from public.jobs j join public.companies c on c.id = j.company_id
    where j.closed_at is null;

  create view public.v_unique_active_jobs as
    select distinct on (j.company_id, j.fingerprint)
           j.id, c.ats, c.slug as company, j.external_id, j.title, j.location, j.url,
           j.department, j.employment_type, j.fingerprint, j.first_seen_at, j.last_seen_at
    from public.jobs j join public.companies c on c.id = j.company_id
    where j.closed_at is null
    order by j.company_id, j.fingerprint, j.first_seen_at;

  create view public.v_jobs_last_24h as
    select j.id, c.ats, c.slug as company, j.title, j.location, j.url, j.first_seen_at
    from public.jobs j join public.companies c on c.id = j.company_id
    where j.first_seen_at > (now() - interval '24 hours') and j.closed_at is null
    order by j.first_seen_at desc;

  create view public.v_duplicate_postings as
    select c.ats, c.slug as company, j.fingerprint, count(*) as posting_count,
           array_agg(j.title order by j.first_seen_at) as titles,
           array_agg(j.external_id order by j.first_seen_at) as external_ids,
           min(j.first_seen_at) as earliest_seen, max(j.last_seen_at) as latest_seen
    from public.jobs j join public.companies c on c.id = j.company_id
    where j.closed_at is null
    group by c.ats, c.slug, j.fingerprint
    having count(*) > 1
    order by count(*) desc;

  create view public.v_recent_scans as
    with ok_bounds as (
      select scans.id, scans.started_at,
             coalesce(lead(scans.started_at) over (order by scans.started_at), 'infinity'::timestamptz) as next_started_at
      from public.scans where scans.status = 'ok' and scans.shard_index = 0
    ), recent as (
      select scans.id, scans.started_at, scans.ended_at, scans.status, scans.companies_probed,
             scans.companies_ok, scans.companies_error, scans.new_jobs, scans.closed_jobs,
             scans.active_jobs_after, scans.notes, scans.companies_write_failed, scans.shard_index, scans.shard_count
      from public.scans order by scans.started_at desc limit 30
    )
    select id, started_at, ended_at, extract(epoch from ended_at - started_at)::integer as duration_s,
           status, companies_probed, companies_ok, companies_error,
           coalesce(case when status = 'ok' and shard_index = 0 then
             (select count(*) from ok_bounds b join public.jobs j
                on j.first_seen_at >= b.started_at and j.first_seen_at < b.next_started_at
              where b.id = r.id)
             else null::bigint end, new_jobs::bigint)::integer as new_jobs,
           closed_jobs, active_jobs_after, new_jobs as new_jobs_reported
    from recent r order by started_at desc;

  create view public.v_scans as
    with ok_bounds as (
      select scans.id, scans.started_at,
             coalesce(lead(scans.started_at) over (order by scans.started_at), 'infinity'::timestamptz) as next_started_at
      from public.scans where scans.status = 'ok' and scans.shard_index = 0
    )
    select id, started_at, ended_at, status, companies_probed, companies_ok, companies_error,
           coalesce(case when status = 'ok' and shard_index = 0 then
             (select count(*) from ok_bounds b join public.jobs j
                on j.first_seen_at >= b.started_at and j.first_seen_at < b.next_started_at
              where b.id = s.id)
             else null::bigint end, new_jobs::bigint)::integer as new_jobs,
           closed_jobs, active_jobs_after, notes, companies_write_failed, shard_index, shard_count,
           new_jobs as new_jobs_reported
    from public.scans s;

  -- 8) totals materialized view + alias view + grant
  create materialized view public.mv_jobs_totals_by_source as
    select c.ats as source,
           count(j.id) as total_jobs,
           count(j.id) filter (where j.closed_at is null) as active_jobs,
           count(j.id) filter (where j.first_seen_at > (now() - interval '24 hours')) as new_24h,
           count(j.id) filter (where j.first_seen_at > (now() - interval '7 days')) as new_7d,
           count(j.id) filter (where j.first_seen_at > (now() - interval '30 days')) as new_30d
    from public.companies c left join public.jobs j on j.company_id = c.id
    group by c.ats order by c.ats
    with data;
  create unique index mv_jobs_totals_by_source_source_idx on public.mv_jobs_totals_by_source (source);
  create view public.v_jobs_totals_by_source as
    select source, total_jobs, active_jobs, new_24h, new_7d, new_30d
    from public.mv_jobs_totals_by_source;
  grant select on public.mv_jobs_totals_by_source to anon, authenticated, service_role;
end $$;
