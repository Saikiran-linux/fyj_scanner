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
