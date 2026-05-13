import { pgSelect, pgCount } from '../lib/supabase';

// SSR every request; the page also includes an HTML meta-refresh below so
// browsers re-fetch every 30s without JavaScript.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const ACTIVE_JOB_SLA = 50_000;
const BLOCK_RATE_SLA_PCT = 1.0;
const SCAN_FRESHNESS_SLA_HOURS = 6;

export default async function Page() {
  let sourceHealth = [];
  let recentScans = [];
  let lastScan = [];
  let activeJobs = 0;
  let error = null;

  try {
    [sourceHealth, recentScans, lastScan, activeJobs] = await Promise.all([
      pgSelect('v_source_health_24h', { select: '*' }),
      pgSelect('v_recent_scans', { select: '*', limit: '14' }),
      pgSelect('scans', {
        select: 'ended_at',
        status: 'eq.ok',
        order: 'ended_at.desc',
        limit: '1',
      }),
      pgCount('jobs', { closed_at: 'is.null' }),
    ]);
  } catch (e) {
    error = e.message;
  }

  const now = Date.now();
  const lastScanIso = lastScan?.[0]?.ended_at ?? null;
  const lastScanAgoH = lastScanIso ? (now - new Date(lastScanIso).getTime()) / 3_600_000 : null;
  const worstBlockRate = Math.max(0, ...sourceHealth.map((s) => Number(s.block_rate_pct) || 0));

  const sla1Ok = worstBlockRate < BLOCK_RATE_SLA_PCT;
  const sla2Ok = activeJobs >= ACTIVE_JOB_SLA;
  const sla3Ok = lastScanAgoH !== null && lastScanAgoH < SCAN_FRESHNESS_SLA_HOURS;

  const renderedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

  // Sparkline: oldest → newest, so reverse the desc-ordered scans.
  const sparkValues = [...recentScans].reverse().map((s) => Number(s.active_jobs_after) || 0);

  return (
    <>
      <meta httpEquiv="refresh" content="30" />
      <main className="max-w-6xl mx-auto p-6 space-y-6">
        <header className="flex justify-between items-baseline border-b border-zinc-800 pb-3">
          <h1 className="text-2xl font-semibold">fyj_scanner</h1>
          <div className="text-xs text-zinc-500">
            rendered {renderedAt} · auto-refresh 30s
          </div>
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
            note="worst source, last 24h"
          />
          <Sla
            label="Active jobs"
            target={`≥ ${ACTIVE_JOB_SLA.toLocaleString()}`}
            value={activeJobs.toLocaleString()}
            ok={sla2Ok}
            note="rows with closed_at is null"
          />
          <Sla
            label="Last scan"
            target={`< ${SCAN_FRESHNESS_SLA_HOURS}h ago`}
            value={lastScanAgoH === null ? '—' : `${lastScanAgoH.toFixed(1)}h`}
            ok={sla3Ok}
            note={lastScanIso ? lastScanIso.replace('T', ' ').slice(0, 19) + ' UTC' : 'no successful scans yet'}
          />
        </section>

        <section>
          <h2 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
            Per-source health · last 24h
          </h2>
          <div className="border border-zinc-800 rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500 text-left bg-zinc-900/60">
                <tr>
                  <Th>source</Th>
                  <Th>probes</Th>
                  <Th>ok</Th>
                  <Th>blocked</Th>
                  <Th>errored</Th>
                  <Th>block %</Th>
                  <Th>success %</Th>
                  <Th>p50</Th>
                  <Th>p95</Th>
                </tr>
              </thead>
              <tbody>
                {sourceHealth.length === 0 && (
                  <tr><td colSpan={9} className="px-3 py-4 text-zinc-500">no probes in last 24h</td></tr>
                )}
                {sourceHealth.map((s) => (
                  <tr key={s.source} className="border-t border-zinc-800">
                    <Td>{s.source}</Td>
                    <Td>{s.probes}</Td>
                    <Td>{s.ok}</Td>
                    <Td>{s.blocked}</Td>
                    <Td>{s.errored}</Td>
                    <Td className={Number(s.block_rate_pct) >= BLOCK_RATE_SLA_PCT ? 'text-red-400' : 'text-emerald-400'}>
                      {s.block_rate_pct}%
                    </Td>
                    <Td>{s.success_rate_pct}%</Td>
                    <Td>{s.p50_latency_ms ?? '—'}{s.p50_latency_ms != null && 'ms'}</Td>
                    <Td>{s.p95_latency_ms ?? '—'}{s.p95_latency_ms != null && 'ms'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <h2 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
            Active jobs · last {sparkValues.length} successful scans
          </h2>
          <div className="border border-zinc-800 rounded p-4">
            <Sparkline values={sparkValues} target={ACTIVE_JOB_SLA} />
          </div>
        </section>

        <section>
          <h2 className="text-xs uppercase tracking-wide text-zinc-400 mb-2">
            Recent scans
          </h2>
          <div className="border border-zinc-800 rounded overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-zinc-500 text-left bg-zinc-900/60">
                <tr>
                  <Th>started (UTC)</Th>
                  <Th>status</Th>
                  <Th>dur</Th>
                  <Th>probed</Th>
                  <Th>ok / err</Th>
                  <Th>new</Th>
                  <Th>closed</Th>
                  <Th>active after</Th>
                </tr>
              </thead>
              <tbody>
                {recentScans.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-4 text-zinc-500">no scans yet</td></tr>
                )}
                {recentScans.map((s) => (
                  <tr key={s.id} className="border-t border-zinc-800">
                    <Td>{s.started_at?.replace('T', ' ').slice(0, 19)}</Td>
                    <Td className={s.status === 'ok' ? 'text-emerald-400' : s.status === 'failed' ? 'text-red-400' : 'text-zinc-400'}>
                      {s.status}
                    </Td>
                    <Td>{s.duration_s ?? '—'}{s.duration_s != null && 's'}</Td>
                    <Td>{s.companies_probed}</Td>
                    <Td>{s.companies_ok}/{s.companies_error}</Td>
                    <Td>{s.new_jobs}</Td>
                    <Td>{s.closed_jobs}</Td>
                    <Td>{s.active_jobs_after?.toLocaleString() ?? '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <footer className="text-xs text-zinc-600 pt-4">
          Source: <code>v_source_health_24h</code>, <code>v_recent_scans</code>, <code>scans</code>, <code>jobs</code>.
          Refresh by reloading.
        </footer>
      </main>
    </>
  );
}

function Sla({ label, target, value, ok, note }) {
  return (
    <div className="border border-zinc-800 rounded p-3">
      <div className="flex items-center gap-2">
        <span className={`inline-block w-2 h-2 rounded-full ${ok ? 'bg-emerald-400' : 'bg-red-400'}`}></span>
        <span className="text-zinc-400 text-xs uppercase tracking-wide">{label}</span>
      </div>
      <div className="text-3xl mt-1 font-semibold">{value}</div>
      <div className="text-xs text-zinc-500 mt-1">target {target}</div>
      <div className="text-xs text-zinc-600 mt-2 truncate" title={note}>{note}</div>
    </div>
  );
}

function Sparkline({ values, target, width = 800, height = 80 }) {
  if (values.length === 0) {
    return <div className="text-zinc-500 text-sm">no data</div>;
  }
  const lows = [Math.min(...values, target ?? Infinity)];
  const highs = [Math.max(...values, target ?? -Infinity)];
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const range = max - min || 1;
  const step = width / Math.max(values.length - 1, 1);
  const y = (v) => height - ((v - min) / range) * (height - 8) - 4;
  const points = values.map((v, i) => `${i * step},${y(v)}`).join(' ');
  const targetY = target != null ? y(target) : null;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none">
      {targetY != null && (
        <line
          x1="0" x2={width} y1={targetY} y2={targetY}
          stroke="rgb(82,82,91)" strokeDasharray="4 4" strokeWidth="1"
        />
      )}
      <polyline fill="none" stroke="rgb(52,211,153)" strokeWidth="2" points={points} />
      {values.map((v, i) => (
        <circle key={i} cx={i * step} cy={y(v)} r={2.5} fill="rgb(52,211,153)" />
      ))}
      <text x="4" y={height - 4} fill="rgb(113,113,122)" fontSize="11">{min.toLocaleString()}</text>
      <text x={width - 4} y="14" fill="rgb(113,113,122)" fontSize="11" textAnchor="end">{max.toLocaleString()}</text>
      {target != null && (
        <text x={width - 4} y={targetY - 4} fill="rgb(113,113,122)" fontSize="10" textAnchor="end">
          SLA {target.toLocaleString()}
        </text>
      )}
    </svg>
  );
}

function Th({ children }) {
  return <th className="px-3 py-2 font-normal">{children}</th>;
}

function Td({ children, className = '' }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}
