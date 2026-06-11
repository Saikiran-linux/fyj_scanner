-- f-119 step 3 (part 2): stop storing job description text in the jobs heap.
-- Apply ONLY when no scan is running (it rewrites every job row and swaps the
-- description triggers). Readers were already pointed at v_jobs_enriched
-- (migration 0002 + code), so they read description from job_descriptions and
-- don't depend on jobs.description being populated.
--
-- Net effect: descriptions live solely in job_descriptions; jobs.description
-- is emptied and kept empty by a BEFORE trigger that diverts any future write
-- into job_descriptions. The column is left in place (now ~0 storage) so the
-- scanner's upsert payload needs no change; dropping it outright would require
-- editing the PGRST102-sensitive batched upsert and is deferred.

set statement_timeout = 0;

-- 1) Embedding/summary invalidation must key off description_hash, not the
--    description text (which no longer lives on jobs). The scanner writes a
--    fresh description_hash whenever the text changes, so this is the correct
--    change signal.
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

-- 2) Flip the description sync from AFTER-copy to BEFORE-divert: route the text
--    into job_descriptions and NULL the heap copy so jobs never stores it.
create or replace function public.sync_job_description() returns trigger
language plpgsql as $$
begin
  if new.description is not null then
    insert into public.job_descriptions (job_id, company_id, description, updated_at)
    values (new.id, new.company_id, new.description, now())
    on conflict (job_id) do update
      set description = excluded.description,
          company_id  = excluded.company_id,
          updated_at  = now();
    new.description := null;   -- keep the text out of the hot jobs heap
  end if;
  return new;
end;
$$;

drop trigger if exists jobs_sync_description on public.jobs;
create trigger jobs_sync_description
  before insert or update of description on public.jobs
  for each row execute function public.sync_job_description();

-- 3) Backstop: make sure job_descriptions has every current jobs.description
--    before we drop the heap copies (touches only any out-of-sync rows).
insert into public.job_descriptions (job_id, company_id, description, updated_at)
select j.id, j.company_id, j.description, now()
from public.jobs j
where j.description is not null
  and not exists (
    select 1 from public.job_descriptions jd
    where jd.job_id = j.id and jd.description = j.description
  )
on conflict (job_id) do update
  set description = excluded.description,
      company_id  = excluded.company_id,
      updated_at  = now();

-- 4) Empty the heap copies. Sets description=null only (NOT description_hash),
--    so the invalidation trigger sees no hash change and embeddings are kept.
update public.jobs set description = null where description is not null;

-- 5) Reclaim the dead TOAST. VACUUM cannot run inside a transaction block; if
--    this migration is wrapped, run it separately:  vacuum (analyze) public.jobs;
vacuum (analyze) public.jobs;
