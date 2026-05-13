import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pgSelect, pgSelectRange } from '../../../lib/supabase';
import { Th, Td, Empty, StatusDot, Badge, Pagination, fmtTs, relativeAgo } from '../../../components/ui';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;
const FILTERS = ['all', 'failed', 'blocked', 'slowest'];

export default async function ScanDetail({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const filter = FILTERS.includes(sp.filter) ? sp.filter : 'all';
  const page = Math.max(1, Number(sp.page) || 1);
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let scan = null;
  let probes = { rows: [], total: 0 };
  let errorBuckets = [];
  let error = null;

  try {
    const scanRows = await pgSelect('scans', { id: `eq.${id}`, limit: '1' });
    if (!scanRows[0]) return notFound();
    scan = scanRows[0];

    // probe_results with embedded company so we can show ats/slug per row.
    const baseQ = {
      select: 'id,http_status,schema_ok,error,latency_ms,job_count,created_at,company:companies(ats,slug)',
      scan_id: `eq.${id}`,
    };
    if (filter === 'failed') {
      baseQ.schema_ok = 'eq.false';
      baseQ.order = 'latency_ms.desc.nullslast';
    } else if (filter === 'blocked') {
      baseQ.http_status = 'in.(403,429)';
      baseQ.order = 'created_at.desc';
    } else if (filter === 'slowest') {
      baseQ.order = 'latency_ms.desc.nullslast';
    } else {
      baseQ.order = 'created_at.desc';
    }

    probes = await pgSelectRange('probe_results', baseQ, { from, to });

    // Error breakdown — group by error text on this scan's failures. PostgREST
    // can't GROUP BY in a single REST call, so we fetch all failures (up to
    // 1k) and bucket in JS.
    const fails = await pgSelect('probe_results', {
      select: 'error,http_status',
      scan_id: `eq.${id}`,
      schema_ok: 'eq.false',
      limit: '1000',
    });
    const buckets = new Map();
    for (const f of fails) {
      const key = (f.error || `HTTP ${f.http_status || '?'}`).split(':')[0].slice(0, 60);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    errorBuckets = [...buckets.entries()].map(([k, v]) => ({ key: k, count: v }))
      .sort((a, b) => b.count - a.count).slice(0, 12);
  } catch (e) {
    error = e.message;
  }

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <h1 className="text-xl font-semibold">Scan detail</h1>
          {scan && (
            <div className="text-xs text-zinc-500 mt-1">
              {fmtTs(scan.started_at, { withSeconds: true })} UTC · {relativeAgo(scan.started_at)} · <code className="text-zinc-600">{id.slice(0, 8)}</code>
            </div>
          )}
        </div>
        <Link href="/scans" className="text-xs text-sky-300 hover:underline">← all scans</Link>
      </header>

      {error && (
        <div className="border border-red-700 bg-red-950/40 text-red-200 rounded p-3 text-sm">
          <strong>Failed to load:</strong> {error}
        </div>
      )}

      {scan && (
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Status">
            <span className="flex items-center gap-2"><StatusDot status={scan.status} /> {scan.status}</span>
          </Stat>
          <Stat label="Duration">{scan.duration_s ?? durationOf(scan) ?? '—'}{(scan.duration_s ?? durationOf(scan)) != null && 's'}</Stat>
          <Stat label="Companies">{Number(scan.companies_probed ?? 0).toLocaleString()}</Stat>
          <Stat label="Ok / Err">
            <span className="text-emerald-400">{scan.companies_ok ?? 0}</span>
            <span className="text-zinc-500 mx-1">/</span>
            <span className="text-red-400">{scan.companies_error ?? 0}</span>
          </Stat>
          <Stat label="New jobs"><span className="text-emerald-400">{Number(scan.new_jobs ?? 0).toLocaleString()}</span></Stat>
          <Stat label="Closed jobs"><span className="text-pink-400">{Number(scan.closed_jobs ?? 0).toLocaleString()}</span></Stat>
          <Stat label="Active after">{scan.active_jobs_after?.toLocaleString() ?? '—'}</Stat>
          <Stat label="Started">{fmtTs(scan.started_at)}</Stat>
        </section>
      )}

      {scan?.notes && (
        <section className="border border-zinc-800 rounded p-3 text-sm">
          <div className="text-xs uppercase tracking-wide text-zinc-500 mb-1">Per-source notes</div>
          <code className="text-zinc-300 text-xs break-all">{scan.notes}</code>
        </section>
      )}

      <section>
        <div className="text-xs uppercase tracking-wide text-zinc-400 mb-2">Top error reasons in this scan</div>
        {errorBuckets.length === 0 ? (
          <div className="text-zinc-500 text-sm border border-zinc-800 rounded p-3">no failures recorded</div>
        ) : (
          <ul className="border border-zinc-800 rounded divide-y divide-zinc-800">
            {errorBuckets.map((b) => (
              <li key={b.key} className="flex justify-between px-3 py-2 text-sm">
                <code className="text-zinc-300 truncate max-w-[80%]">{b.key}</code>
                <span className="text-zinc-400">{b.count.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="text-xs uppercase tracking-wide text-zinc-400">Probe results · {filter}</h2>
          <div className="flex gap-1 text-xs">
            {FILTERS.map((f) => (
              <Link key={f} href={`/scans/${id}?filter=${f}`}
                className={`px-2 py-0.5 rounded ${filter === f ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'}`}>
                {f}
              </Link>
            ))}
          </div>
        </div>

        <div className="border border-zinc-800 rounded overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-500 text-left bg-zinc-900/60">
              <tr>
                <Th>company</Th>
                <Th>ats</Th>
                <Th className="text-right">http</Th>
                <Th className="text-right">latency</Th>
                <Th className="text-right">jobs</Th>
                <Th>schema ok</Th>
                <Th>error</Th>
              </tr>
            </thead>
            <tbody>
              {probes.rows.length === 0 ? (
                <Empty cols={7}>no probes match</Empty>
              ) : (
                probes.rows.map((p) => (
                  <tr key={p.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                    <Td>{p.company?.slug || '—'}</Td>
                    <Td><Badge tone="zinc">{p.company?.ats || '—'}</Badge></Td>
                    <Td className="text-right">{p.http_status ?? '—'}</Td>
                    <Td className="text-right">{p.latency_ms != null ? `${p.latency_ms}ms` : '—'}</Td>
                    <Td className="text-right">{p.job_count ?? '—'}</Td>
                    <Td>{p.schema_ok ? <Badge tone="green">yes</Badge> : <Badge tone="red">no</Badge>}</Td>
                    <Td className="max-w-md text-zinc-400 truncate text-xs" title={p.error}>{p.error || '—'}</Td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Pagination basePath={`/scans/${id}`} page={page} pageSize={PAGE_SIZE} total={probes.total} params={{ filter }} />
      </section>
    </main>
  );
}

function Stat({ label, children }) {
  return (
    <div className="border border-zinc-800 rounded p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className="text-lg mt-1 font-semibold">{children}</div>
    </div>
  );
}

function durationOf(scan) {
  if (scan.started_at && scan.ended_at) {
    return Math.round((new Date(scan.ended_at).getTime() - new Date(scan.started_at).getTime()) / 1000);
  }
  return null;
}
