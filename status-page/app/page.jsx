import Link from 'next/link';
import { pgSelect, pgCount, pgRpc } from '../lib/supabase';
import { Sla, Sparkline, Bars, StatusDot, Th, Td, Empty, RangePills, fmtTs, relativeAgo } from '../components/ui';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ACTIVE_JOB_SLA = 50_000;
const BLOCK_RATE_SLA_PCT = 1.0;
const SCAN_FRESHNESS_SLA_HOURS = 6;

const RANGE_TO_INTERVAL = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export default async function Page({ searchParams }) {
  const params = await searchParams;
  const range = ['24h', '7d', '30d'].includes(params?.range) ? params.range : '24h';
  const interval = RANGE_TO_INTERVAL[range];

  let sourceHealth = [];
  let recentScans = [];
  let lastScan = [];
  let activeJobs = 0;
  let activeJobsToday = 0;
  let jobsLast7d = [];
  let error = null;

  try {
    [sourceHealth, recentScans, lastScan, activeJobs, activeJobsToday, jobsLast7d] = await Promise.all([
      pgRpc('f_source_health', { p_window: interval }),
      pgSelect('v_recent_scans', { select: '*', limit: '30' }),
      pgSelect('scans', { select: 'ended_at', status: 'eq.ok', order: 'ended_at.desc', limit: '1' }),
      pgCount('jobs', { closed_at: 'is.null' }),
      pgCount('jobs', { first_seen_at: `gte.${isoMinus(24 * 3600)}` }),
      pgSelect('scans', {
        select: 'started_at,new_jobs,closed_jobs,active_jobs_after',
        status: 'eq.ok',
        order: 'started_at.desc',
        limit: '30',
      }),
    ]);
  } catch (e) {
    error = e.message;
  }

  const lastScanIso = lastScan?.[0]?.ended_at ?? null;
  const lastScanAgoH = lastScanIso ? (Date.now() - new Date(lastScanIso).getTime()) / 3_600_000 : null;
  const worstBlockRate = Math.max(0, ...sourceHealth.map((s) => Number(s.block_rate_pct) || 0));

  const sla1Ok = worstBlockRate < BLOCK_RATE_SLA_PCT;
  const sla2Ok = activeJobs >= ACTIVE_JOB_SLA;
  const sla3Ok = lastScanAgoH !== null && lastScanAgoH < SCAN_FRESHNESS_SLA_HOURS;

  // Sparklines: oldest → newest.
  const reversedScans = [...jobsLast7d].reverse();
  const activeSeries = reversedScans.map((s) => Number(s.active_jobs_after) || 0);
  const newSeries = reversedScans.map((s) => Number(s.new_jobs) || 0);
  const closedSeries = reversedScans.map((s) => Number(s.closed_jobs) || 0);
  const seriesLabels = reversedScans.map((s) => fmtTs(s.started_at).slice(5, 10));

  return (
    <>
      <meta httpEquiv="refresh" content="30" />
      <main className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="flex justify-between items-baseline">
          <div>
            <h1 className="text-xl font-semibold">Overview</h1>
            <div className="text-xs text-zinc-500 mt-1">auto-refresh 30s · rendered {fmtTs(new Date().toISOString(), { withSeconds: true })} UTC</div>
          </div>
          <RangePills basePath="/" current={range} />
        </header>

        {error && (
          <div className="border border-red-700 bg-red-950/40 text-red-200 rounded p-3 text-sm">
            <strong>Failed to load:</strong> {error}
          </div>
        )}

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <Sla
            label="Block rate"
            target={`< ${BLOCK_RATE_SLA_PCT}%`}
            value={`${worstBlockRate.toFixed(2)}%`}
            ok={sla1Ok}
            note={`worst source over last ${range}`}
          />
          <Sla
            label="Active jobs"
            target={`≥ ${ACTIVE_JOB_SLA.toLocaleString()}`}
            value={activeJobs.toLocaleString()}
            ok={sla2Ok}
            note={`+${activeJobsToday.toLocaleString()} new in last 24h`}
          />
          <Sla
            label="Last scan"
            target={`< ${SCAN_FRESHNESS_SLA_HOURS}h ago`}
            value={lastScanAgoH === null ? '—' : `${lastScanAgoH.toFixed(1)}h`}
            ok={sla3Ok}
            note={lastScanIso ? `${fmtTs(lastScanIso, { withSeconds: true })} UTC` : 'no successful scans yet'}
          />
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-xs uppercase tracking-wide text-zinc-400">Per-source health · last {range}</h2>
            <span className="text-xs text-zinc-600">click a row to drill into recent scans</span>
          </div>
          <div className="border border-zinc-800 rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500 text-left bg-zinc-900/60">
                <tr>
                  <Th>source</Th>
                  <Th className="text-right">probes</Th>
                  <Th className="text-right">ok</Th>
                  <Th className="text-right">blocked</Th>
                  <Th className="text-right">errored</Th>
                  <Th className="text-right">block %</Th>
                  <Th className="text-right">success %</Th>
                </tr>
              </thead>
              <tbody>
                {sourceHealth.length === 0 ? (
                  <Empty cols={7}>no probes in this window</Empty>
                ) : (
                  sourceHealth.map((s) => (
                    <tr key={s.source} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                      <Td>
                        <Link href={`/companies?ats=${s.source}`} className="text-sky-300 hover:underline">{s.source}</Link>
                      </Td>
                      <Td className="text-right">{Number(s.probes).toLocaleString()}</Td>
                      <Td className="text-right">{Number(s.ok).toLocaleString()}</Td>
                      <Td className="text-right">{Number(s.blocked).toLocaleString()}</Td>
                      <Td className="text-right">{Number(s.errored).toLocaleString()}</Td>
                      <Td className={`text-right ${Number(s.block_rate_pct) >= BLOCK_RATE_SLA_PCT ? 'text-red-400' : 'text-emerald-400'}`}>
                        {Number(s.block_rate_pct).toFixed(2)}%
                      </Td>
                      <Td className="text-right">{Number(s.success_rate_pct).toFixed(1)}%</Td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Chart title="Active jobs (last 30 scans)" subtitle={`SLA target ${ACTIVE_JOB_SLA.toLocaleString()}`}>
            <Sparkline values={activeSeries} target={ACTIVE_JOB_SLA} />
          </Chart>
          <Chart title="New jobs per scan" subtitle="last 30 successful">
            <Bars values={newSeries} labels={seriesLabels} color="rgb(96,165,250)" />
          </Chart>
          <Chart title="Closed jobs per scan" subtitle="last 30 successful">
            <Bars values={closedSeries} labels={seriesLabels} color="rgb(244,114,182)" />
          </Chart>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-xs uppercase tracking-wide text-zinc-400">Recent scans</h2>
            <Link href="/scans" className="text-xs text-sky-300 hover:underline">all scans →</Link>
          </div>
          <div className="border border-zinc-800 rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500 text-left bg-zinc-900/60">
                <tr>
                  <Th>started</Th>
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
                {recentScans.length === 0 ? (
                  <Empty cols={9}>no scans yet</Empty>
                ) : (
                  recentScans.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                      <Td><span className="text-zinc-400">{fmtTs(s.started_at, { withSeconds: true })}</span> <span className="text-zinc-600 text-xs">({relativeAgo(s.started_at)})</span></Td>
                      <Td><StatusDot status={s.status} /> <span className="text-zinc-400 ml-1">{s.status}</span></Td>
                      <Td className="text-right">{s.duration_s ?? '—'}{s.duration_s != null && 's'}</Td>
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
        </section>

        <footer className="text-xs text-zinc-600 pt-4">
          Source: <code>f_source_health</code>, <code>v_recent_scans</code>, <code>scans</code>, <code>jobs</code>.
        </footer>
      </main>
    </>
  );
}

function Chart({ title, subtitle, children }) {
  return (
    <div className="border border-zinc-800 rounded p-3">
      <div className="text-xs uppercase tracking-wide text-zinc-400">{title}</div>
      {subtitle && <div className="text-xs text-zinc-600 mb-2">{subtitle}</div>}
      {children}
    </div>
  );
}

function isoMinus(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}
