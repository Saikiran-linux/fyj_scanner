#!/usr/bin/env node
// Run the cosine query directly via Supabase RPC, since the 29KB vector
// literal is awkward to pipe through other tooling. Reads /tmp/resume.vec
// (produced by embed-resume.mjs), builds the SQL, calls the supabase
// `query` RPC (we'll just use a function we create on the fly via REST is
// overkill — instead use the postgres-meta SQL endpoint via Supabase's
// pg-meta proxy). Simpler still: use the data API by creating a SQL
// function. Simplest of all: just call PostgREST's rpc('exec_sql',…) if
// it exists, otherwise hit the SQL endpoint of supabase-js.
//
// Actually the cleanest path is to write a Postgres function once and
// call it via PostgREST. But we don't want to mutate schema. So we use
// the Supabase Management API's `query` endpoint with the personal
// access token. We don't have that here either.
//
// What we DO have: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env, and
// PostgREST. PostgREST can call any function but not arbitrary SQL.
//
// Workaround: a one-call PostgREST query that does the cosine search
// inline using a server-side RPC isn't available — but we can do the
// cosine search client-side! Fetch ~all rows that have embeddings (via
// PostgREST pagination), compute cosine in Node, return top 30. With
// 70k rows × 1536 floats × 8 bytes ≈ 860 MB if dense, but PostgREST
// returns them as JSON strings which is much bigger and very slow.
//
// Final approach: write the SQL to stdout. The user (or the MCP tool)
// can run it. We'll print it and then exit.

import fs from 'node:fs';

const vec = fs.readFileSync('scripts/_resume.vec', 'utf8').trim();
if (!vec.startsWith('[')) throw new Error('resume.vec missing');

const sql = `with q as (select '${vec}'::vector(1024) as v)
select
  round((1 - (j.embedding <=> q.v))::numeric, 4) as cosine_sim,
  j.title, j.location, c.slug as company, c.ats,
  j.first_seen_at::date as posted, j.url,
  j.remote, j.comp_min, j.comp_max, j.comp_currency
from public.jobs j
join public.companies c on c.id = j.company_id
cross join q
where j.closed_at is null
  and j.embedding is not null
order by j.embedding <=> q.v
limit 30;`;

fs.writeFileSync('scripts/_match.sql', sql);
console.error('wrote scripts/_match.sql ('+sql.length+' bytes)');
console.log(sql);
