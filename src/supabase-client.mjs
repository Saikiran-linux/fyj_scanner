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

// Retry policy for transient PostgREST / pooler errors. The motivating case is
// PGRST002 ("schema cache not loaded — retrying") on the very first request
// after the Supabase project wakes up: a single 503 there crashed the entire
// scan workflow before any work started. We also retry 502/504 (pooler hiccup)
// and AbortError/network errors (transient connection loss). 4xx are never
// retried — those are caller bugs and a retry won't help.
const MAX_ATTEMPTS = Number(process.env.SUPABASE_MAX_ATTEMPTS || 4);
const RETRY_BASE_MS = Number(process.env.SUPABASE_RETRY_BASE_MS || 500);

function isRetriableStatus(status) {
  // 5xx in general — Postgres / PostgREST / pooler all surface transient
  // problems this way. 501 is excluded (genuinely "not implemented").
  return status >= 500 && status !== 501;
}

function isRetriableError(err) {
  if (!err) return false;
  // AbortError comes from our own timeout wrapper.
  if (err.name === 'AbortError') return true;
  // Node's undici fetch wraps connection errors in a TypeError("fetch failed")
  // with the real cause on .cause (ECONNRESET, ENOTFOUND, UND_ERR_SOCKET, …).
  if (err.name === 'TypeError') return true;
  const code = err.code || err.cause?.code;
  if (code && /^(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR_SOCKET)$/.test(code)) {
    return true;
  }
  return false;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function request(method, path, opts = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await requestOnce(method, path, opts);
    } catch (e) {
      lastErr = e;
      // Parse "→ NNN:" out of the message thrown by requestOnce for HTTP errors.
      const m = /→ (\d{3}):/.exec(e.message || '');
      const status = m ? Number(m[1]) : null;
      const retriable = (status != null && isRetriableStatus(status)) || isRetriableError(e) || /→ timeout after/.test(e.message || '');
      if (!retriable || attempt === MAX_ATTEMPTS) throw e;
      // Exponential backoff with full jitter: 0..base, 0..2*base, 0..4*base, …
      const cap = RETRY_BASE_MS * 2 ** (attempt - 1);
      const delay = Math.floor(Math.random() * cap);
      console.warn(`Supabase ${method} ${path} attempt ${attempt}/${MAX_ATTEMPTS} failed (${e.message.slice(0, 120)}); retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function requestOnce(method, path, { body, prefer, query } = {}) {
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
 *
 * Pagination is **keyset (cursor) on a unique ordered column** (default the
 * primary key `id`), NOT limit/offset. This matters for correctness, not just
 * speed: `LIMIT/OFFSET` without a *total* `ORDER BY` is not stable on a large
 * table — PostgreSQL may return rows in a different physical order between the
 * (many) page requests, so some rows come back on two pages and others are
 * skipped entirely. That silently corrupted the scanner's active-job snapshot
 * (it returned the right row COUNT but ~35% duplicates and ~35% missing rows),
 * which made every scan miscount tens of thousands of already-open jobs as
 * "new" and re-send their descriptions. Seeking past the last id we saw
 * (`id=gt.<cursor>` + `order=id.asc`) is both stable and O(1) per page (no
 * growing OFFSET scan) — important as `jobs` heads toward 1M rows.
 *
 * Assumes the target table has a unique, sortable `keyColumn` and that the
 * caller does not itself filter/order on that column (true for every caller
 * here — they hit `jobs`/`companies`, both keyed on a uuid `id`). Override via
 * the `keyColumn` option if that ever changes.
 */
export async function selectAll(table, query = {}, { pageSize = 1000, maxRows = Infinity, keyColumn = 'id' } = {}) {
  const all = [];
  // Make sure the cursor column comes back in the rows so we can read the next
  // cursor; append it if the caller narrowed `select` and left it out.
  let select = query.select;
  if (keyColumn && typeof select === 'string') {
    const cols = select.split(',').map((s) => s.trim());
    if (!cols.includes(keyColumn) && !cols.includes('*')) select = `${select},${keyColumn}`;
  }
  let cursor = null;
  while (all.length < maxRows) {
    const want = Math.min(pageSize, maxRows - all.length);
    const q = {
      ...query,
      ...(select ? { select } : {}),
      order: `${keyColumn}.asc`,
      limit: String(want),
    };
    if (cursor != null) q[keyColumn] = `gt.${cursor}`;
    const page = await request('GET', `/${table}`, { query: q });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    cursor = page[page.length - 1][keyColumn];
    if (page.length < want) break;
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
