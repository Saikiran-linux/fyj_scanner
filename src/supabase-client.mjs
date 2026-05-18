/**
 * Lightweight Supabase PostgREST client.
 *
 * Why no SDK? @supabase/supabase-js pulls in node-fetch shims and realtime
 * code we don't use. Bare fetch + the documented PostgREST URL shape is
 * ~50 lines and lets us tune behavior (batched upserts, prefer headers).
 */

const URL_ENV = 'SUPABASE_URL';
const KEY_ENV = 'SUPABASE_SERVICE_ROLE_KEY';

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v.replace(/\/+$/, '');
}

const BASE = () => `${env(URL_ENV)}/rest/v1`;
const HEADERS = () => ({
  apikey: env(KEY_ENV),
  Authorization: `Bearer ${env(KEY_ENV)}`,
  'Content-Type': 'application/json',
});

// Hard ceiling on a single Supabase HTTP call. Without this, a hung PostgREST
// request (we've observed pooler 504s after sustained write load) keeps the
// caller's worker tied up indefinitely — one stalled request cascades into
// the rest of the worker pool sitting idle. 20s comfortably covers the
// slowest legitimate call we make (the active-jobs snapshot pagination); raise
// via SUPABASE_FETCH_TIMEOUT_MS if you start seeing spurious aborts.
const FETCH_TIMEOUT_MS = Number(process.env.SUPABASE_FETCH_TIMEOUT_MS || 20_000);

async function request(method, path, { body, prefer, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${BASE()}${path}${qs}`;
  const headers = { ...HEADERS() };
  if (prefer) headers.Prefer = prefer;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Supabase ${method} ${path} → timeout after ${FETCH_TIMEOUT_MS}ms`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Supabase ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function select(table, query = {}) {
  return request('GET', `/${table}`, { query });
}

/**
 * Paginated select that walks past Supabase/PostgREST's default `max-rows`
 * cap (1,000). Use this whenever the result set could be larger than 1k —
 * a bare select() truncates silently. Pass `pageSize` to override the chunk
 * size; defaults to 1,000 which is the upstream cap.
 */
export async function selectAll(table, query = {}, { pageSize = 1000 } = {}) {
  const all = [];
  let offset = 0;
  // PostgREST honours `limit` and `offset` query params; the server still
  // applies its own max-rows ceiling per request, so we paginate.
  while (true) {
    const page = await request('GET', `/${table}`, {
      query: { ...query, limit: String(pageSize), offset: String(offset) },
    });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }
  return all;
}

export async function insert(table, rows, { returning = 'representation' } = {}) {
  return request('POST', `/${table}`, {
    body: rows,
    prefer: `return=${returning}`,
  });
}

// Upsert via PostgREST's on_conflict + merge-duplicates Prefer header.
export async function upsert(table, rows, onConflict, { returning = 'representation' } = {}) {
  return request('POST', `/${table}`, {
    body: rows,
    prefer: `resolution=merge-duplicates,return=${returning}`,
    query: { on_conflict: onConflict },
  });
}

export async function update(table, filter, patch, { returning = 'representation' } = {}) {
  return request('PATCH', `/${table}`, {
    body: patch,
    query: filter,
    prefer: `return=${returning}`,
  });
}

export async function rpc(fn, args = {}) {
  return request('POST', `/rpc/${fn}`, { body: args });
}
