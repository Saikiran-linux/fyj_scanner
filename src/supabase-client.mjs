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

async function request(method, path, { body, prefer, query } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : '';
  const url = `${BASE()}${path}${qs}`;
  const headers = { ...HEADERS() };
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
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
