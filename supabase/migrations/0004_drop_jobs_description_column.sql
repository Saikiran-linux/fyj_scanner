-- f-119 cleanup: drop the now-empty jobs.description column and retire the
-- divert trigger. Descriptions live solely in job_descriptions, written
-- directly by the scanner (src/scan.mjs) and backfill-descriptions.mjs.
--
-- ORDER OF OPERATIONS MATTERS — apply ONLY after the code that stops writing
-- jobs.description is deployed (merged to main + a scan cycle on the new code).
-- If applied while old scanner code is still live, that code's upsert sends a
-- `description` key; with the column gone PostgREST silently drops it and the
-- text is lost (the old code relied on the BEFORE-divert trigger that this
-- migration removes). New code writes job_descriptions directly, so once it's
-- deployed there is no writer of jobs.description left.
--
-- Single DO block (commits server-side past the 60s gateway; a multi-statement
-- version gets rolled back when the gateway abandons the connection). The
-- column drop is a catalog-only change (the column was already emptied by
-- migration 0003), so this is fast regardless of row count.

set statement_timeout = 0;

do $mig$
begin
  -- No code writes jobs.description anymore -> the divert trigger + its
  -- function are dead. (invalidate_embedding_on_description_change stays; it
  -- keys off description_hash, which lives on and is still written.)
  drop trigger if exists jobs_sync_description on public.jobs;
  drop function if exists public.sync_job_description();

  -- These partial indexes reference jobs.description in their predicate, so
  -- they must go before the column can be dropped; recreated below without it.
  drop index if exists public.jobs_description_pending_idx;
  drop index if exists public.jobs_description_summary_pending_idx;

  alter table public.jobs drop column if exists description;

  -- Fetch-pass candidate scan: never-attempted rows.
  create index jobs_description_pending_idx
    on public.jobs (company_id)
    where description_fetched_at is null and closed_at is null;
  -- Summary-pass candidate scan (joins job_descriptions via v_jobs_enriched to
  -- require description-present).
  create index jobs_description_summary_pending_idx
    on public.jobs (company_id)
    where description_summary is null and closed_at is null;
end
$mig$;
