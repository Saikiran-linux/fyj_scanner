/**
 * Bare PostgREST helpers. Server-side only — never import from a Client
 * Component. The service-role key would leak.
 */

function env(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v.replace(/\/+$/, '');
}

function headers() {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

/** GET /rest/v1/<path>?<query>. Returns parsed JSON. */
export async function pgSelect(path, query = {}) {
  const url = env('SUPABASE_URL');
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${url}/rest/v1/${path}${qs ? `?${qs}` : ''}`, {
    headers: headers(),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Range-based paginated select. Uses the PostgREST `Range` header so we
 * also get an exact count back via `Content-Range`. Returns { rows, total }.
 */
export async function pgSelectRange(path, query = {}, { from = 0, to = 49 } = {}) {
  const url = env('SUPABASE_URL');
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${url}/rest/v1/${path}${qs ? `?${qs}` : ''}`, {
    headers: {
      ...headers(),
      Prefer: 'count=exact',
      Range: `${from}-${to}`,
      'Range-Unit': 'items',
    },
    cache: 'no-store',
  });
  // 206 = partial content; both ok.
  if (!res.ok && res.status !== 206) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase GET ${path} → ${res.status}: ${body.slice(0, 300)}`);
  }
  const cr = res.headers.get('content-range') || '';
  const total = Number(cr.split('/')[1]);
  const rows = await res.json().catch(() => []);
  return { rows: Array.isArray(rows) ? rows : [], total: Number.isFinite(total) ? total : (Array.isArray(rows) ? rows.length : 0) };
}

/**
 * HEAD-based exact count. Avoids transferring rows just to count them —
 * uses PostgREST's `count=exact` Prefer header and parses Content-Range.
 */
export async function pgCount(table, query = {}) {
  const url = env('SUPABASE_URL');
  const qs = new URLSearchParams({ ...query, select: 'id' }).toString();
  const res = await fetch(`${url}/rest/v1/${table}?${qs}`, {
    method: 'HEAD',
    headers: {
      ...headers(),
      Prefer: 'count=exact',
      Range: '0-0',
    },
    cache: 'no-store',
  });
  const cr = res.headers.get('content-range') || '';
  const total = Number(cr.split('/')[1]);
  return Number.isFinite(total) ? total : 0;
}

/** Call a PostgREST RPC (Postgres function exposed via /rpc/). */
export async function pgRpc(name, args = {}) {
  const url = env('SUPABASE_URL');
  const res = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...headers(), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase RPC ${name} → ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}
