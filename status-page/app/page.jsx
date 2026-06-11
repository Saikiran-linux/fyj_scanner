import Link from 'next/link';
import { pgSelect, pgCount, pgRpc } from '../lib/supabase';
import { Sla, Sparkline, Bars, StatusDot, Th, Td, Empty, RangePills, fmtTs, relativeAgo } from '../components/ui';
import AutoRefresh from '../components/AutoRefresh';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ACTIVE_JOB_SLA = 50_000;
const BLOCK_RATE_SLA_PCT = 1.0;
const SCAN_FRESHNESS_SLA_HOURS = 6;

// Mirrors .github/workflows/scan.yml cron `17 0,6,12,18 * * *` UTC.
// Keep in sync if the schedule changes there.
const SCAN_CRON_HOURS_UTC = [0, 6, 12, 18];
const SCAN_CRON_MINUTE_UTC = 17;

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
  let newJobsByScanSource = [];
  let jobsTotalsBySource = [];
  let error = null;

  try {
    [sourceHealth, recentScans, lastScan, activeJobs, activeJobsToday, jobsLast7d, newJobsByScanSource, jobsTotalsBySource] = await Promise.all([
      pgRpc('f_source_health', { p_window: interval }),
      pgSelect('v_recent_scans', { select: '*', limit: '30' }),
      pgSelect('scans', { select: 'ended_at', status: 'eq.ok', order: 'ended_at.desc', limit: '1' }),
      pgCount('jobs', { closed_at: 'is.null' }),
      pgCount('jobs', { first_seen_at: `gte.${isoMinus(24 * 3600)}` }),
      // Sparkline new-jobs series reads from v_recent_scans (first_seen_at-window
      // count), NOT scans.new_jobs — the raw counter over-counts reopened
      // postings and would spike the chart by 10-30k on some scans.
      pgSelect('v_recent_scans', {
        select: 'started_at,new_jobs,closed_jobs,active_jobs_after',
        status: 'eq.ok',
        order: 'started_at.desc',
        limit: '30',
      }),
      pgRpc('f_new_jobs_by_scan_source', { p_window: interval }),
      pgSelect('v_jobs_totals_by_source', { select: '*' }),
    ]);
  } catch (e) {
    error = e.message;
  }

  // Pivot the per-(scan,ats) rows into one row per scan with an ats→count map.
  // Sources are derived from the rows themselves so adding a 6th provider
  // doesn't require touching the dashboard.
  const sourcesInData = new Set();
  for (const r of newJobsByScanSource) sourcesInData.add(r.ats);
  for (const r of jobsTotalsBySource) sourcesInData.add(r.source);
  const sourceCols = [...sourcesInData].sort();

  const scanPivot = new Map();
  for (const r of newJobsByScanSource) {
    let row = scanPivot.get(r.scan_id);
    if (!row) {
      row = { scan_id: r.scan_id, started_at: r.started_at, byAts: {}, total: 0 };
      scanPivot.set(r.scan_id, row);
    }
    row.byAts[r.ats] = Number(r.new_jobs) || 0;
    row.total += Number(r.new_jobs) || 0;
  }
  const newJobsPivoted = [...scanPivot.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));

  // Range-windowed totals per source (matches the table content above).
  const rangeWindowKey = range === '24h' ? 'new_24h' : range === '30d' ? 'new_30d' : 'new_7d';
  const rangeTotalsByAts = Object.fromEntries(
    jobsTotalsBySource.map((r) => [r.source, Number(r[rangeWindowKey]) || 0])
  );
  const rangeGrandTotal = Object.values(rangeTotalsByAts).reduce((a, b) => a + b, 0);

  const lastScanIso = lastScan?.[0]?.ended_at ?? null;
  const lastScanAgoH = lastScanIso ? (Date.now() - new Date(lastScanIso).getTime()) / 3_600_000 : null;
  const worstBlockRate = Math.max(0, ...sourceHealth.map((s) => Number(s.block_rate_pct) || 0));

  const nextScanIso = nextScheduledScan().toISOString();
  const nextScanInMin = Math.max(0, Math.round((new Date(nextScanIso).getTime() - Date.now()) / 60_000));

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
      <AutoRefresh seconds={30} />
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

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
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
          <Sla
            label="Next scan"
            target="every 6h"
            value={formatCountdown(nextScanInMin)}
            ok
            note={`${fmtTs(nextScanIso, { withSeconds: true })} UTC`}
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
          <Chart href="/charts/active-jobs" title="Active jobs (last 30 scans)" subtitle={`SLA target ${ACTIVE_JOB_SLA.toLocaleString()} · click to expand`}>
            <Sparkline values={activeSeries} target={ACTIVE_JOB_SLA} />
          </Chart>
          <Chart href="/charts/new-jobs" title="New jobs per scan" subtitle="last 30 successful · click to expand">
            <Bars values={newSeries} labels={seriesLabels} color="rgb(96,165,250)" />
          </Chart>
          <Chart href="/charts/closed-jobs" title="Closed jobs per scan" subtitle="last 30 successful · click to expand">
            <Bars values={closedSeries} labels={seriesLabels} color="rgb(244,114,182)" />
          </Chart>
        </section>

        <section>
          <div className="flex items-baseline justify-between mb-2">
            <h2 className="text-xs uppercase tracking-wide text-zinc-400">New jobs by source · last {range}</h2>
            <span className="text-xs text-zinc-600">per scan · footer = {range} totals · also showing lifetime / active</span>
          </div>
          <div className="border border-zinc-800 rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500 text-left bg-zinc-900/60">
                <tr>
                  <Th>started</Th>
                  {sourceCols.map((s) => (
                    <Th key={s} className="text-right">{s}</Th>
                  ))}
                  <Th className="text-right">total</Th>
                </tr>
              </thead>
              <tbody>
                {newJobsPivoted.length === 0 ? (
                  <Empty cols={sourceCols.length + 2}>no new jobs in this window</Empty>
                ) : (
                  newJobsPivoted.map((row) => (
                    <tr key={row.scan_id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                      <Td>
                        <span className="text-zinc-400">{fmtTs(row.started_at, { withSeconds: true })}</span>{' '}
                        <span className="text-zinc-600 text-xs">({relativeAgo(row.started_at)})</span>
                      </Td>
                      {sourceCols.map((s) => {
                        const v = row.byAts[s] || 0;
                        return (
                          <Td key={s} className={`text-right ${v ? 'text-emerald-400' : 'text-zinc-600'}`}>
                            {v.toLocaleString()}
                          </Td>
                        );
                      })}
                      <Td className="text-right font-semibold">{row.total.toLocaleString()}</Td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot className="border-t-2 border-zinc-700 bg-zinc-900/40 text-zinc-300">
                <tr>
                  <Td><span className="text-xs uppercase tracking-wide text-zinc-500">{range} totals</span></Td>
                  {sourceCols.map((s) => (
                    <Td key={s} className="text-right">{(rangeTotalsByAts[s] || 0).toLocaleString()}</Td>
                  ))}
                  <Td className="text-right font-semibold">{rangeGrandTotal.toLocaleString()}</Td>
                </tr>
                <tr className="text-zinc-500">
                  <Td><span className="text-xs uppercase tracking-wide">lifetime · active</span></Td>
                  {sourceCols.map((s) => {
                    const t = jobsTotalsBySource.find((r) => r.source === s);
                    const total = Number(t?.total_jobs ?? 0);
                    const active = Number(t?.active_jobs ?? 0);
                    return (
                      <Td key={s} className="text-right text-xs">
                        {total.toLocaleString()} · <span className="text-emerald-500">{active.toLocaleString()}</span>
                      </Td>
                    );
                  })}
                  <Td className="text-right text-xs font-semibold">
                    {jobsTotalsBySource.reduce((a, r) => a + Number(r.total_jobs || 0), 0).toLocaleString()}
                    {' · '}
                    <span className="text-emerald-500">
                      {jobsTotalsBySource.reduce((a, r) => a + Number(r.active_jobs || 0), 0).toLocaleString()}
                    </span>
                  </Td>
                </tr>
              </tfoot>
            </table>
          </div>
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
                  <Th className="text-right">reopened</Th>
                  <Th className="text-right">closed</Th>
                  <Th className="text-right">active after</Th>
                  <Th></Th>
                </tr>
              </thead>
              <tbody>
                {recentScans.length === 0 ? (
                  <Empty cols={10}>no scans yet</Empty>
                ) : (
                  recentScans.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                      <Td><span className="text-zinc-400">{fmtTs(s.started_at, { withSeconds: true })}</span> <span className="text-zinc-600 text-xs">({relativeAgo(s.started_at)})</span></Td>
                      <Td><StatusDot status={s.status} /> <span className="text-zinc-400 ml-1">{s.status}</span></Td>
                      <Td className="text-right">{s.duration_s ?? '—'}{s.duration_s != null && 's'}</Td>
                      <Td className="text-right">{Number(s.companies_probed ?? 0).toLocaleString()}</Td>
                      <Td className="text-right">{s.companies_ok}/{s.companies_error}</Td>
                      <Td className="text-right text-emerald-400">{Number(s.new_jobs ?? 0).toLocaleString()}</Td>
                      {/* reopened: closed→active again this cycle. Explains why active
                          can rise when closed > new (active Δ = new + reopened − closed). */}
                      <Td className="text-right text-amber-400">{s.reopened == null ? '—' : Number(s.reopened).toLocaleString()}</Td>
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
          Source: <code>f_source_health</code>, <code>f_new_jobs_by_scan_source</code>, <code>v_jobs_totals_by_source</code>, <code>v_recent_scans</code>, <code>scans</code>, <code>jobs</code>.
        </footer>
      </main>
    </>
  );
}

function Chart({ title, subtitle, children, href }) {
  const inner = (
    <>
      <div className="text-xs uppercase tracking-wide text-zinc-400">{title}</div>
      {subtitle && <div className="text-xs text-zinc-600 mb-2">{subtitle}</div>}
      {children}
    </>
  );
  if (href) {
    return (
      <Link
        href={href}
        className="block border border-zinc-800 rounded p-3 hover:border-zinc-700 hover:bg-zinc-900/40 transition-colors cursor-pointer"
      >
        {inner}
      </Link>
    );
  }
  return <div className="border border-zinc-800 rounded p-3">{inner}</div>;
}

function isoMinus(seconds) {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

function nextScheduledScan(now = new Date()) {
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const h of SCAN_CRON_HOURS_UTC) {
      const d = new Date(Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + dayOffset,
        h,
        SCAN_CRON_MINUTE_UTC,
      ));
      if (d.getTime() > now.getTime()) return d;
    }
  }
  // Unreachable: 4 fires/day across 2 days always yields one in the future.
  return now;
}

function formatCountdown(min) {
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}
