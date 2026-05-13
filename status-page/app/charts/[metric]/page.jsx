import Link from 'next/link';
import { notFound } from 'next/navigation';
import { pgSelect } from '../../../lib/supabase';
import InteractiveChart from '../../../components/InteractiveChart';
import { Th, Td, fmtTs } from '../../../components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const METRICS = {
  'active-jobs': {
    title: 'Active jobs over time',
    subtitle: 'rows with closed_at is null, sampled at the end of each successful scan',
    kind: 'line',
    color: 'rgb(52,211,153)',
    target: 50_000,
    field: 'active_jobs_after',
    yLabel: 'active jobs',
  },
  'new-jobs': {
    title: 'New jobs per scan',
    subtitle: 'rows where first_seen_at landed during the scan window',
    kind: 'bars',
    color: 'rgb(96,165,250)',
    target: null,
    field: 'new_jobs',
    yLabel: 'new this scan',
  },
  'closed-jobs': {
    title: 'Closed jobs per scan',
    subtitle: 'previously-active jobs that vanished from the ATS response',
    kind: 'bars',
    color: 'rgb(244,114,182)',
    target: null,
    field: 'closed_jobs',
    yLabel: 'closed this scan',
  },
};

const RANGES = {
  '30': { label: 'last 30 scans', limit: 30 },
  '60': { label: 'last 60 scans', limit: 60 },
  '100': { label: 'last 100 scans', limit: 100 },
  '200': { label: 'last 200 scans', limit: 200 },
};

export default async function ChartPage({ params, searchParams }) {
  const { metric } = await params;
  const sp = (await searchParams) || {};
  if (!METRICS[metric]) return notFound();
  const spec = METRICS[metric];
  const rangeKey = RANGES[sp.n] ? sp.n : '30';
  const range = RANGES[rangeKey];

  let scans = [];
  let error = null;
  try {
    scans = await pgSelect('scans', {
      select: `id,started_at,${spec.field}`,
      status: 'eq.ok',
      order: 'started_at.desc',
      limit: String(range.limit),
    });
  } catch (e) {
    error = e.message;
  }

  // PostgREST returns desc; reverse to oldest → newest for the chart.
  const ordered = [...scans].reverse();
  const points = ordered.map((s) => ({
    ts: s.started_at,
    value: Number(s[spec.field]) || 0,
  }));

  const values = points.map((p) => p.value);
  const min = values.length ? Math.min(...values) : 0;
  const max = values.length ? Math.max(...values) : 0;
  const avg = values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  const latest = values.length ? values[values.length - 1] : 0;
  const prev = values.length > 1 ? values[values.length - 2] : null;
  const delta = prev != null ? latest - prev : null;

  return (
    <main className="max-w-6xl mx-auto p-6 space-y-4">
      <header className="flex items-baseline justify-between">
        <div>
          <Link href="/" className="text-xs text-sky-300 hover:underline">← Overview</Link>
          <h1 className="text-xl font-semibold mt-1">{spec.title}</h1>
          <p className="text-xs text-zinc-500 mt-1">{spec.subtitle}</p>
        </div>
        <div className="inline-flex border border-zinc-800 rounded overflow-hidden text-xs">
          {Object.entries(RANGES).map(([k, r]) => (
            <Link
              key={k}
              href={`/charts/${metric}?n=${k}`}
              className={`px-3 py-1.5 ${k === rangeKey ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'}`}
            >
              {r.label}
            </Link>
          ))}
        </div>
      </header>

      <nav className="flex gap-2 text-xs">
        {Object.entries(METRICS).map(([k, m]) => (
          <Link
            key={k}
            href={`/charts/${k}?n=${rangeKey}`}
            className={`px-3 py-1.5 rounded ${k === metric ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-900 border border-zinc-800'}`}
          >
            {m.title.split(' ')[0]} {m.title.split(' ')[1]}
          </Link>
        ))}
      </nav>

      {error && (
        <div className="border border-red-700 bg-red-950/40 text-red-200 rounded p-3 text-sm">
          <strong>Query failed:</strong> {error}
        </div>
      )}

      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <Stat label="Latest">{latest.toLocaleString()}</Stat>
        <Stat label="Change vs prev" tone={delta == null ? 'zinc' : delta >= 0 ? 'green' : 'red'}>
          {delta == null ? '—' : `${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`}
        </Stat>
        <Stat label="Average">{avg.toLocaleString()}</Stat>
        <Stat label="Min">{min.toLocaleString()}</Stat>
        <Stat label="Max">{max.toLocaleString()}</Stat>
      </section>

      <section className="border border-zinc-800 rounded p-4">
        <InteractiveChart
          points={points}
          kind={spec.kind}
          target={spec.target}
          color={spec.color}
          yLabel={spec.yLabel}
          height={360}
        />
        <p className="text-xs text-zinc-600 mt-2">Hover the chart to see exact values per scan.</p>
      </section>

      <section>
        <div className="text-xs uppercase tracking-wide text-zinc-400 mb-2">Underlying data</div>
        <div className="border border-zinc-800 rounded overflow-x-auto max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-zinc-500 text-left bg-zinc-900/60 sticky top-0">
              <tr>
                <Th>started (UTC)</Th>
                <Th className="text-right">{spec.yLabel}</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {[...ordered].reverse().map((s) => (
                <tr key={s.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                  <Td className="font-mono text-zinc-300">{fmtTs(s.started_at, { withSeconds: true })}</Td>
                  <Td className="text-right">{Number(s[spec.field] || 0).toLocaleString()}</Td>
                  <Td><Link href={`/scans/${s.id}`} className="text-sky-300 hover:underline text-xs">detail →</Link></Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Stat({ label, children, tone = 'zinc' }) {
  const colors = {
    zinc: 'text-zinc-100',
    green: 'text-emerald-400',
    red: 'text-red-400',
  };
  return (
    <div className="border border-zinc-800 rounded p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-lg mt-1 font-semibold ${colors[tone] || colors.zinc}`}>{children}</div>
    </div>
  );
}
