-- f-119 step 3 (part 1, non-destructive): decouple description readers from
-- the jobs heap by sourcing the text from job_descriptions through a view.
--
-- v_jobs_enriched == jobs, but `description` comes from job_descriptions
-- (LEFT JOIN by job_id) instead of jobs.description. Readers (the scan
-- summary/embedding passes, backfill-summaries, backfill-embeddings) select
-- from this view, so they keep seeing a flat `description` field and stop
-- depending on whether jobs.description is populated. The column list mirrors
-- jobs EXCEPT description (which would otherwise collide), so the definition
-- stays valid after jobs.description is later emptied/dropped.
--
-- Safe to run during a live scan: creating a view takes no lock on jobs.

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
