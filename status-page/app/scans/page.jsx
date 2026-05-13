import Link from 'next/link';
import { pgSelectRange } from '../../lib/supabase';
import { Th, Td, Empty, Pagination, StatusDot, fmtTs, relativeAgo } from '../../components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const PAGE_SIZE = 30;

export default async function ScansPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const status = ['ok', 'failed', 'running'].includes(sp.status) ? sp.status : '';
  const page = Math.max(1, Number(sp.page) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  const query = {
    select: '*',
    order: 'started_at.desc',
  };
  if (status) query.status = `eq.${status}`;

  let rows = [];
  let total = 0;
  let error = null;
  try {
    const r = await pgSelectRange('scans', query, { from, to });
    rows = r.rows;
    total = r.total;
  } catch (e) {
    error = e.message;
  }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Scans</h1>
        <span className="text-xs text-zinc-500">{total.toLocaleString()} runs total</span>
      </header>

      <div className="flex gap-2 text-sm">
        <FilterLink href="/scans" active={!status}>all</FilterLink>
        <FilterLink href="/scans?status=ok" active={status === 'ok'}>ok</FilterLink>
        <FilterLink href="/scans?status=failed" active={status === 'failed'}>failed</FilterLink>
        <FilterLink href="/scans?status=running" active={status === 'running'}>running</FilterLink>
      </div>

      {error && (
        <div className="border border-red-700 bg-red-950/40 text-red-200 rounded p-3 text-sm">
          <strong>Query failed:</strong> {error}
        </div>
      )}

      <div className="border border-zinc-800 rounded overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-zinc-500 text-left bg-zinc-900/60">
            <tr>
              <Th>started (UTC)</Th>
              <Th>status</Th>
              <Th className="text-right">dur</Th>
              <Th className="text-right">probed</Th>
              <Th className="text-right">ok/err</Th>
              <Th className="text-right">new</Th>
              <Th className="text-right">closed</Th>
              <Th className="text-right">active after</Th>
              <Th></Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <Empty cols={9}>no scans</Empty>
            ) : (
              rows.map((s) => (
                <tr key={s.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                  <Td>
                    <span className="text-zinc-300">{fmtTs(s.started_at, { withSeconds: true })}</span>
                    <span className="text-zinc-600 text-xs ml-2">({relativeAgo(s.started_at)})</span>
                  </Td>
                  <Td><StatusDot status={s.status} /> <span className="text-zinc-400 ml-1">{s.status}</span></Td>
                  <Td className="text-right">{durationS(s) ?? '—'}{durationS(s) != null && 's'}</Td>
                  <Td className="text-right">{Number(s.companies_probed ?? 0).toLocaleString()}</Td>
                  <Td className="text-right">{s.companies_ok}/{s.companies_error}</Td>
                  <Td className="text-right text-emerald-400">{Number(s.new_jobs ?? 0).toLocaleString()}</Td>
                  <Td className="text-right text-pink-400">{Number(s.closed_jobs ?? 0).toLocaleString()}</Td>
                  <Td className="text-right">{s.active_jobs_after?.toLocaleString() ?? '—'}</Td>
                  <Td><Link href={`/scans/${s.id}`} className="text-sky-300 hover:underline text-xs">detail →</Link></Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <Pagination basePath="/scans" page={page} pageSize={PAGE_SIZE} total={total} params={{ status }} />
    </main>
  );
}

function FilterLink({ href, active, children }) {
  return (
    <Link
      href={href}
      className={`px-3 py-1 rounded text-sm ${active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'}`}
    >
      {children}
    </Link>
  );
}

function durationS(s) {
  if (s.duration_s != null) return s.duration_s;
  if (s.started_at && s.ended_at) {
    return Math.round((new Date(s.ended_at).getTime() - new Date(s.started_at).getTime()) / 1000);
  }
  return null;
}
