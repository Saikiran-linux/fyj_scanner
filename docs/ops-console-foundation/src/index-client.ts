/**
 * Read-only client for the fyj job index (Supabase Postgres, owned by the
 * `fyj_scanner` repo). This is the ONLY coupling between the two systems. The
 * ops-console never writes the index.
 *
 * Backed by the `search_jobs`/`get_job` RPCs (f-132 / f-114) exposed over HTTPS
 * (PostgREST-style). Keep this contract additive/backward-compatible so the two
 * repos deploy independently.
 */

export interface JobFilters {
  targetOnly?: boolean;
  families?: string[];
  seniority?: string[];
  remote?: boolean;
  compFloor?: number;
  /** ISO timestamp — only jobs first seen after this (incremental matching). */
  since?: string;
  limit?: number;
}

export interface JobMatch {
  jobId: string;
  companyId: string;
  score: number;
}

export interface JobDetail {
  jobId: string;
  companyId: string;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  description: string | null;
}

function headers(env: Env): HeadersInit {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${env.FYJ_INDEX_KEY}`,
    apikey: env.FYJ_INDEX_KEY,
  };
}

/** Vector + filter search against the index. Returns ranked job refs. */
export async function searchJobs(
  env: Env,
  embedding: number[],
  filters: JobFilters,
): Promise<JobMatch[]> {
  const res = await fetch(`${env.FYJ_INDEX_URL}/rest/v1/rpc/search_jobs`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ query_vec: embedding, filters }),
  });
  if (!res.ok) {
    throw new Error(`search_jobs ${res.status}: ${await res.text()}`);
  }
  const rows = (await res.json()) as Array<{ job_id: string; company_id: string; score: number }>;
  return rows.map((r) => ({ jobId: r.job_id, companyId: r.company_id, score: r.score }));
}

/** Hydrate one job's detail for display. Cache in KV (JOB_CACHE) by job id. */
export async function getJob(
  env: Env,
  jobId: string,
  companyId: string,
): Promise<JobDetail | null> {
  const cacheKey = `job:${jobId}`;
  const cached = await env.JOB_CACHE.get<JobDetail>(cacheKey, "json");
  if (cached) return cached;

  const res = await fetch(`${env.FYJ_INDEX_URL}/rest/v1/rpc/get_job`, {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ p_job_id: jobId, p_company_id: companyId }),
  });
  if (!res.ok) throw new Error(`get_job ${res.status}: ${await res.text()}`);
  const row = (await res.json()) as JobDetail | null;
  if (row) await env.JOB_CACHE.put(cacheKey, JSON.stringify(row), { expirationTtl: 86_400 });
  return row;
}
