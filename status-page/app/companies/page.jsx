import Link from 'next/link';
import { pgSelectRange } from '../../lib/supabase';
import { Th, Td, Empty, Pagination, Badge, fmtTs } from '../../components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 50;
const ATS_OPTIONS = ['', 'greenhouse', 'ashby', 'lever', 'smartrecruiters'];
const STATE_OPTIONS = ['', 'enabled', 'disabled', 'errored'];

export default async function CompaniesPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const q = (sp.q || '').trim();
  const ats = ATS_OPTIONS.includes(sp.ats) ? sp.ats : '';
  const state = STATE_OPTIONS.includes(sp.state) ? sp.state : '';
  const page = Math.max(1, Number(sp.page) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const query = {
    select: 'id,ats,slug,careers_url,enabled,consecutive_errors,last_success_at,last_error_at,last_error',
    order: 'consecutive_errors.desc,slug.asc',
  };
  if (q) query.slug = `ilike.*${q}*`;
  if (ats) query.ats = `eq.${ats}`;
  if (state === 'enabled') query.enabled = 'eq.true';
  else if (state === 'disabled') query.enabled = 'eq.false';
  else if (state === 'errored') query.consecutive_errors = 'gt.0';

  let rows = [];
  let total = 0;
  let error = null;
  try {
    const r = await pgSelectRange('companies', query, { from, to });
    rows = r.rows;
    total = r.total;
  } catch (e) {
    error = e.message;
  }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Companies</h1>
        <span className="text-xs text-zinc-500">{total.toLocaleString()} matching</span>
      </header>

      <form className="flex flex-wrap gap-2 items-end border border-zinc-800 rounded p-3" action="/companies" method="GET">
        <Field label="Slug contains">
          <input name="q" defaultValue={q} placeholder="e.g. anthropic"
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm w-56 focus:outline-none focus:border-sky-500" />
        </Field>
        <Field label="ATS">
          <select name="ats" defaultValue={ats}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-sky-500">
            <option value="">all</option>
            {ATS_OPTIONS.filter(Boolean).map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </Field>
        <Field label="State">
          <select name="state" defaultValue={state}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-sky-500">
            <option value="">all</option>
            <option value="enabled">enabled</option>
            <option value="disabled">disabled (auto)</option>
            <option value="errored">errored (≥1 fail)</option>
          </select>
        </Field>
        <div className="flex-1" />
        <button type="submit" className="bg-sky-600 hover:bg-sky-500 text-white text-sm px-3 py-1.5 rounded">Apply</button>
        <Link href="/companies" className="text-zinc-400 hover:text-zinc-100 text-sm px-3 py-1.5">Reset</Link>
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
              <Th>slug</Th>
              <Th>ats</Th>
              <Th>state</Th>
              <Th className="text-right">consec errors</Th>
              <Th>last success</Th>
              <Th>last error</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <Empty cols={7}>no companies match</Empty>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                  <Td className="font-medium text-zinc-100">{c.slug}</Td>
                  <Td><Badge tone="zinc">{c.ats}</Badge></Td>
                  <Td>
                    {c.enabled
                      ? c.consecutive_errors > 0
                        ? <Badge tone="yellow">enabled · errored</Badge>
                        : <Badge tone="green">enabled</Badge>
                      : <Badge tone="red">disabled</Badge>}
                  </Td>
                  <Td className={`text-right ${c.consecutive_errors >= 3 ? 'text-red-400' : c.consecutive_errors > 0 ? 'text-amber-400' : 'text-zinc-500'}`}>
                    {c.consecutive_errors}
                  </Td>
                  <Td className="text-zinc-400 text-xs whitespace-nowrap">{fmtTs(c.last_success_at)}</Td>
                  <Td className="text-zinc-400 text-xs max-w-[260px] truncate" title={c.last_error}>{c.last_error || '—'}</Td>
                  <Td>
                    <div className="flex gap-2 text-xs">
                      <Link href={`/jobs?ats=${c.ats}&q=&company=${c.slug}`} className="text-sky-300 hover:underline">jobs</Link>
                      {c.careers_url && <a href={c.careers_url} target="_blank" rel="noopener noreferrer" className="text-zinc-400 hover:text-zinc-100">careers ↗</a>}
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination basePath="/companies" page={page} pageSize={PAGE_SIZE} total={total} params={{ q, ats, state }} />
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
