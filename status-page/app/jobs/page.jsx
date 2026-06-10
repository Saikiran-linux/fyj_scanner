import Link from 'next/link';
import { pgSelect, pgSelectRange } from '../../lib/supabase';
import { Th, Td, Empty, Pagination, Badge, fmtTs } from '../../components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 50;
const ATS_OPTIONS = ['', 'greenhouse', 'ashby', 'lever', 'smartrecruiters', 'workatastartup'];

export default async function JobsPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const q = (sp.q || '').trim();
  const ats = ATS_OPTIONS.includes(sp.ats) ? sp.ats : '';
  const activeOnly = sp.active !== '0'; // default on
  const page = Math.max(1, Number(sp.page) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // We need company info per row. PostgREST embedded-resource syntax:
  //   select=...,company:companies(ats,slug)
  const select = 'id,title,location,url,first_seen_at,last_seen_at,closed_at,'
    + 'comp_min,comp_max,comp_currency,comp_interval,comp_text,'
    + 'remote,source_updated_at,source_published_at,'
    + 'company:companies(ats,slug)';

  const remoteFilter = ['remote', 'hybrid', 'onsite'].includes(sp.remote) ? sp.remote : '';
  const compOnly = sp.comp === '1';

  // Build filters.
  const query = { select, order: 'first_seen_at.desc' };
  if (activeOnly) query.closed_at = 'is.null';
  if (q) {
    // ilike search via PostgREST. `*` wildcards.
    query.title = `ilike.*${q}*`;
  }
  if (ats) {
    // Filter on embedded resource: companies.ats=eq.<ats>
    query['companies.ats'] = `eq.${ats}`;
    // Tell PostgREST to inner-join so non-matching rows are dropped.
    query.company = 'not.is.null';
  }
  if (remoteFilter) query.remote = `eq.${remoteFilter}`;
  if (compOnly) {
    // "has any comp signal" — either structured or free-text.
    query.or = '(comp_min.not.is.null,comp_text.not.is.null)';
  }

  let rows = [];
  let total = 0;
  let error = null;
  // Count strategy: the planner's row estimate for a `title ilike '%…%'` search
  // is wildly inaccurate (it estimates 10 for a result set of 4), which made the
  // header and pagination claim more rows than actually exist. A title search is
  // backed by the jobs_title_trgm_idx trigram index, so an EXACT count is both
  // accurate and cheap there. Reserve the planner estimate ('planned') for the
  // broad, near-full-table listing (no text search) — the only case whose exact
  // count risks the 8s statement_timeout.
  const countStrategy = q ? 'exact' : 'planned';
  try {
    const r = await pgSelectRange('jobs', query, { from, to, count: countStrategy });
    rows = r.rows;
    total = r.total;
    // ats filter on embedded resource doesn't drop parent rows by default;
    // we need to filter client-side too.
    if (ats) rows = rows.filter((r) => r.company?.ats === ats);
  } catch (e) {
    error = e.message;
  }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Jobs</h1>
        <span className="text-xs text-zinc-500">{total.toLocaleString()} matching · auto-refresh disabled (interactive page)</span>
      </header>

      <form className="flex flex-wrap gap-2 items-end border border-zinc-800 rounded p-3" action="/jobs" method="GET">
        <Field label="Title contains">
          <input name="q" defaultValue={q} placeholder="e.g. staff engineer"
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm w-64 focus:outline-none focus:border-sky-500" />
        </Field>
        <Field label="ATS">
          <select name="ats" defaultValue={ats}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-sky-500">
            <option value="">all</option>
            {ATS_OPTIONS.filter(Boolean).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="Active only">
          {/* Use hidden+checkbox trick: when unchecked, only hidden submits with value="0" */}
          <input type="hidden" name="active" value="0" />
          <input type="checkbox" name="active" value="1" defaultChecked={activeOnly}
            className="w-4 h-4 accent-sky-500" />
        </Field>
        <Field label="Remote">
          <select name="remote" defaultValue={remoteFilter}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-sky-500">
            <option value="">any</option>
            <option value="remote">remote</option>
            <option value="hybrid">hybrid</option>
            <option value="onsite">onsite</option>
          </select>
        </Field>
        <Field label="Comp listed">
          <input type="hidden" name="comp" value="0" />
          <input type="checkbox" name="comp" value="1" defaultChecked={compOnly}
            className="w-4 h-4 accent-sky-500" />
        </Field>
        <div className="flex-1" />
        <button type="submit" className="bg-sky-600 hover:bg-sky-500 text-white text-sm px-3 py-1.5 rounded">Apply</button>
        <Link href="/jobs" className="text-zinc-400 hover:text-zinc-100 text-sm px-3 py-1.5">Reset</Link>
      </form>

      {error && (
        <div className="border border-red-700 bg-red-950/40 text-red-200 rounded p-3 text-sm">
          <strong>Query failed:</strong> {error}
        </div>
      )}

      <div className="border border-zinc-800 rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-zinc-500 text-left bg-zinc-900/60">
            <tr>
              <Th>title</Th>
              <Th>company</Th>
              <Th>ats</Th>
              <Th>location</Th>
              <Th>remote</Th>
              <Th>comp</Th>
              <Th>posted</Th>
              <Th>first seen</Th>
              <Th>status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <Empty cols={10}>no jobs match</Empty>
            ) : (
              rows.map((j) => {
                const comp = formatComp(j);
                // Prefer the provider's own publish stamp; fall back to our
                // first-seen so the column is never blank.
                const postedIso = j.source_published_at || j.first_seen_at;
                return (
                  <tr key={j.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                    <Td className="max-w-xl">
                      <span className="text-zinc-100">{j.title}</span>
                    </Td>
                    <Td>
                      {j.company?.slug && (
                        <Link href={`/jobs?q=&ats=${j.company.ats}&company=${j.company.slug}`}
                              className="text-sky-300 hover:underline">{j.company.slug}</Link>
                      )}
                    </Td>
                    <Td><Badge tone="zinc">{j.company?.ats || '—'}</Badge></Td>
                    <Td className="text-zinc-400 max-w-[180px] truncate" title={j.location}>{j.location || '—'}</Td>
                    <Td>{j.remote ? <Badge tone={remoteTone(j.remote)}>{j.remote}</Badge> : <span className="text-zinc-600 text-xs">—</span>}</Td>
                    <Td className="text-zinc-300 text-xs whitespace-nowrap" title={j.comp_text || ''}>
                      {comp || <span className="text-zinc-600">—</span>}
                    </Td>
                    <Td className="text-zinc-400 text-xs whitespace-nowrap" title={j.source_published_at ? `provider: ${fmtTs(j.source_published_at)}` : 'no provider timestamp — using first-seen'}>
                      {fmtTs(postedIso)}
                      {!j.source_published_at && <span className="text-zinc-700 ml-1">~</span>}
                    </Td>
                    <Td className="text-zinc-400 text-xs whitespace-nowrap">{fmtTs(j.first_seen_at)}</Td>
                    <Td>
                      {j.closed_at
                        ? <Badge tone="red">closed</Badge>
                        : <Badge tone="green">active</Badge>}
                    </Td>
                    <Td>
                      {j.url && (
                        <a href={j.url} target="_blank" rel="noopener noreferrer" className="text-sky-300 hover:underline text-xs">open ↗</a>
                      )}
                    </Td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        basePath="/jobs"
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        params={{ q, ats, active: activeOnly ? '' : '0', remote: remoteFilter, comp: compOnly ? '1' : '' }}
      />
    </main>
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-zinc-500">{label}</span>
      {children}
    </label>
  );
}

// Compact "$160K – $220K" / "$160K /yr" / "USD 160,000 – 220,000" string.
// Falls back to comp_text (the provider's own free-text summary) when we
// failed to parse structured min/max. Returns '' for "no comp info" so the
// caller can render an em-dash placeholder.
function formatComp(j) {
  const hasStructured = j.comp_min != null || j.comp_max != null;
  if (!hasStructured) return j.comp_text || '';

  const fmt = (n) => {
    if (n == null) return '';
    if (n >= 1000) return `${Math.round(n / 1000)}K`;
    // Hourly rates and similar small values — show full.
    return String(Math.round(n));
  };
  const range = j.comp_min != null && j.comp_max != null && j.comp_min !== j.comp_max
    ? `${fmt(j.comp_min)} – ${fmt(j.comp_max)}`
    : fmt(j.comp_min ?? j.comp_max);

  // Currency symbol when we know it, else 3-letter code prefix.
  const symbols = { USD: '$', EUR: '€', GBP: '£', JPY: '¥' };
  const sym = symbols[j.comp_currency] || '';
  const prefix = sym || (j.comp_currency ? `${j.comp_currency} ` : '');

  const intervalSuffix = j.comp_interval && j.comp_interval !== 'year'
    ? ` /${j.comp_interval.slice(0, 2)}`
    : '';

  return `${prefix}${range}${intervalSuffix}`;
}

function remoteTone(remote) {
  if (remote === 'remote') return 'green';
  if (remote === 'hybrid') return 'blue';
  return 'zinc';
}
