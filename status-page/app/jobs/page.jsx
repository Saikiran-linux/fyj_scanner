import Link from 'next/link';
import { pgSelect, pgSelectRange } from '../../lib/supabase';
import { Th, Td, Empty, Pagination, Badge, fmtTs } from '../../components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 50;
const ATS_OPTIONS = ['', 'greenhouse', 'ashby', 'lever', 'smartrecruiters'];

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
  const select = 'id,title,location,url,first_seen_at,last_seen_at,closed_at,company:companies(ats,slug)';

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

  let rows = [];
  let total = 0;
  let error = null;
  try {
    const r = await pgSelectRange('jobs', query, { from, to });
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
              <Th>first seen</Th>
              <Th>status</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <Empty cols={7}>no jobs match</Empty>
            ) : (
              rows.map((j) => (
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
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination
        basePath="/jobs"
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        params={{ q, ats, active: activeOnly ? '' : '0' }}
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
