/**
 * Pure presentational components shared across pages. All Server Components
 * (no React hooks) so they're free to render under Suspense without bumping
 * the client bundle.
 */
import Link from 'next/link';

export function Sla({ label, target, value, ok, note }) {
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

export function Sparkline({ values, target, width = 800, height = 80, color = 'rgb(52,211,153)' }) {
  if (!values || values.length === 0) {
    return <div className="text-zinc-500 text-sm">no data</div>;
  }
  const min = Math.min(...values, target ?? Infinity);
  const max = Math.max(...values, target ?? -Infinity);
  const range = max - min || 1;
  const step = width / Math.max(values.length - 1, 1);
  const y = (v) => height - ((v - min) / range) * (height - 8) - 4;
  const points = values.map((v, i) => `${i * step},${y(v)}`).join(' ');
  const targetY = target != null ? y(target) : null;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none">
      {targetY != null && (
        <line x1="0" x2={width} y1={targetY} y2={targetY}
          stroke="rgb(82,82,91)" strokeDasharray="4 4" strokeWidth="1" />
      )}
      <polyline fill="none" stroke={color} strokeWidth="2" points={points} />
      {values.map((v, i) => (
        <circle key={i} cx={i * step} cy={y(v)} r={2.5} fill={color} />
      ))}
      <text x="4" y={height - 4} fill="rgb(113,113,122)" fontSize="11">{Math.round(min).toLocaleString()}</text>
      <text x={width - 4} y="14" fill="rgb(113,113,122)" fontSize="11" textAnchor="end">{Math.round(max).toLocaleString()}</text>
      {target != null && (
        <text x={width - 4} y={targetY - 4} fill="rgb(113,113,122)" fontSize="10" textAnchor="end">
          SLA {target.toLocaleString()}
        </text>
      )}
    </svg>
  );
}

/**
 * Vertical bars. Useful for new/closed-jobs per scan or per-day counts.
 */
export function Bars({ values, labels, width = 800, height = 80, color = 'rgb(96,165,250)' }) {
  if (!values || values.length === 0) {
    return <div className="text-zinc-500 text-sm">no data</div>;
  }
  const max = Math.max(...values, 1);
  const w = width / values.length;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-20" preserveAspectRatio="none">
      {values.map((v, i) => {
        const h = (v / max) * (height - 12);
        return (
          <g key={i}>
            <rect x={i * w + 2} y={height - h - 4} width={w - 4} height={h} fill={color} opacity={v ? 0.85 : 0.2} />
            {labels?.[i] != null && i % Math.ceil(values.length / 6) === 0 && (
              <text x={i * w + w / 2} y={height - 0.5} fill="rgb(113,113,122)" fontSize="9" textAnchor="middle">{labels[i]}</text>
            )}
          </g>
        );
      })}
      <text x={width - 4} y="10" fill="rgb(113,113,122)" fontSize="10" textAnchor="end">peak {max.toLocaleString()}</text>
    </svg>
  );
}

export function StatusDot({ status }) {
  const color = status === 'ok' ? 'bg-emerald-400' : status === 'failed' ? 'bg-red-400' : 'bg-zinc-500';
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} title={status} />;
}

export function Badge({ children, tone = 'zinc' }) {
  const tones = {
    zinc: 'bg-zinc-800 text-zinc-300',
    green: 'bg-emerald-900/50 text-emerald-300',
    red: 'bg-red-900/50 text-red-300',
    yellow: 'bg-amber-900/50 text-amber-300',
    blue: 'bg-sky-900/50 text-sky-300',
  };
  return <span className={`inline-block text-xs px-1.5 py-0.5 rounded ${tones[tone] || tones.zinc}`}>{children}</span>;
}

export function Th({ children, className = '' }) {
  return <th className={`px-3 py-2 font-normal ${className}`}>{children}</th>;
}
export function Td({ children, className = '' }) {
  return <td className={`px-3 py-1.5 ${className}`}>{children}</td>;
}

export function Empty({ children = 'no data', cols = 1 }) {
  return (
    <tr><td colSpan={cols} className="px-3 py-4 text-zinc-500 text-center text-sm">{children}</td></tr>
  );
}

/**
 * Pagination with prev/next + page count. Preserves all existing query
 * params and only swaps `page`.
 */
export function Pagination({ basePath, page, pageSize, total, params = {} }) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const from = total === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, total);

  const makeHref = (p) => {
    const sp = new URLSearchParams({ ...params, page: String(p) });
    // Remove blanks so URLs stay tidy.
    for (const [k, v] of [...sp.entries()]) if (!v) sp.delete(k);
    return `${basePath}?${sp.toString()}`;
  };

  return (
    <div className="flex items-center justify-between text-sm text-zinc-400 mt-3">
      <span>
        {total.toLocaleString()} total · showing {from.toLocaleString()}–{to.toLocaleString()}
      </span>
      <div className="flex items-center gap-1">
        <PageLink href={makeHref(1)} disabled={safePage === 1}>«</PageLink>
        <PageLink href={makeHref(safePage - 1)} disabled={safePage === 1}>‹ prev</PageLink>
        <span className="px-2">page {safePage} / {totalPages}</span>
        <PageLink href={makeHref(safePage + 1)} disabled={safePage === totalPages}>next ›</PageLink>
        <PageLink href={makeHref(totalPages)} disabled={safePage === totalPages}>»</PageLink>
      </div>
    </div>
  );
}

function PageLink({ href, disabled, children }) {
  if (disabled) {
    return <span className="px-2 py-1 text-zinc-700 cursor-not-allowed">{children}</span>;
  }
  return <Link href={href} className="px-2 py-1 rounded hover:bg-zinc-800 text-zinc-300">{children}</Link>;
}

/**
 * Simple in-URL range pills. Pure links — no client JS needed.
 */
export function RangePills({ basePath, current, params = {} }) {
  const opts = [
    { value: '24h', label: '24h' },
    { value: '7d', label: '7d' },
    { value: '30d', label: '30d' },
  ];
  return (
    <div className="inline-flex border border-zinc-800 rounded overflow-hidden text-xs">
      {opts.map((o) => {
        const active = current === o.value;
        const sp = new URLSearchParams({ ...params, range: o.value });
        for (const [k, v] of [...sp.entries()]) if (!v) sp.delete(k);
        return (
          <Link
            key={o.value}
            href={`${basePath}?${sp.toString()}`}
            className={`px-3 py-1 ${active ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'}`}
          >
            {o.label}
          </Link>
        );
      })}
    </div>
  );
}

/**
 * Format an ISO timestamp into a compact UTC "YYYY-MM-DD HH:mm" without
 * pulling in date-fns. Returns '—' on null/undefined.
 */
export function fmtTs(iso, opts = { withSeconds: false }) {
  if (!iso) return '—';
  const s = String(iso).replace('T', ' ');
  return s.slice(0, opts.withSeconds ? 19 : 16);
}

export function relativeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  if (s < 60) return `${Math.round(s)}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
}
