'use client';

/**
 * Pure-SVG interactive chart. No charting library — handles only what we
 * need:
 *   - line or bars
 *   - hover crosshair + tooltip with exact value
 *   - X/Y axis labels and gridlines
 *   - optional dashed target line
 *
 * Kept as a Client Component because hover state is client-only. Renders
 * SSR-friendly with no hover state on first paint, so the page is usable
 * without JS — just less interactive.
 */

import { useState, useMemo } from 'react';

const PADDING = { top: 24, right: 24, bottom: 36, left: 56 };

export default function InteractiveChart({
  points,            // [{ ts: ISO string, value: number, label?: string }]
  kind = 'line',     // 'line' | 'bars'
  target = null,     // optional dashed line value
  color = 'rgb(52,211,153)',
  yLabel = '',
  height = 360,
}) {
  const [hoverIdx, setHoverIdx] = useState(null);

  const { width, scaleX, scaleY, ticksY, dateTicks } = useMemo(() => {
    // viewBox width — we keep it fixed so coordinates work; the SVG
    // scales responsively via CSS. 1000 makes the math tidy.
    const w = 1000;
    const innerW = w - PADDING.left - PADDING.right;
    const innerH = height - PADDING.top - PADDING.bottom;

    const values = points.map((p) => Number(p.value) || 0);
    const minV = Math.min(0, ...values, target ?? Infinity);
    const maxV = Math.max(...values, target ?? -Infinity, minV + 1);
    const range = maxV - minV || 1;

    // Round Y ticks to a nice scale.
    const ticks = niceTicks(minV, maxV, 5);

    const sx = (i) =>
      PADDING.left + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
    const sy = (v) => PADDING.top + innerH - ((v - ticks[0]) / (ticks[ticks.length - 1] - ticks[0])) * innerH;

    // Show at most 6 x-axis date labels.
    const step = Math.max(1, Math.ceil(points.length / 6));
    const dt = points.map((p, i) => (i % step === 0 || i === points.length - 1 ? fmtDate(p.ts) : null));

    return { width: w, scaleX: sx, scaleY: sy, ticksY: ticks, dateTicks: dt };
  }, [points, height, target]);

  if (points.length === 0) {
    return <div className="text-zinc-500 text-sm border border-zinc-800 rounded p-6">no data</div>;
  }

  const hoverP = hoverIdx != null ? points[hoverIdx] : null;

  function onMove(e) {
    const svg = e.currentTarget;
    const rect = svg.getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const xVb = (xPx / rect.width) * width;
    const innerW = width - PADDING.left - PADDING.right;
    const rel = (xVb - PADDING.left) / innerW;
    const idx = Math.round(rel * (points.length - 1));
    setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
  }

  // For bars we want a small gap between bars; for line we connect points.
  const innerW = width - PADDING.left - PADDING.right;
  const barW = (innerW / points.length) * 0.7;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full select-none"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverIdx(null)}
        style={{ height: `${height}px` }}
      >
        {/* Y-axis gridlines + labels */}
        {ticksY.map((t, i) => (
          <g key={i}>
            <line
              x1={PADDING.left} x2={width - PADDING.right}
              y1={scaleY(t)} y2={scaleY(t)}
              stroke="rgb(39,39,42)"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8} y={scaleY(t) + 4}
              fill="rgb(113,113,122)" fontSize={11} textAnchor="end"
            >
              {fmtN(t)}
            </text>
          </g>
        ))}

        {/* Y-axis label */}
        {yLabel && (
          <text x={12} y={height / 2} fill="rgb(113,113,122)" fontSize={11}
            textAnchor="middle" transform={`rotate(-90 12 ${height / 2})`}>
            {yLabel}
          </text>
        )}

        {/* Target line */}
        {target != null && (
          <>
            <line
              x1={PADDING.left} x2={width - PADDING.right}
              y1={scaleY(target)} y2={scaleY(target)}
              stroke="rgb(82,82,91)" strokeDasharray="6 4" strokeWidth={1}
            />
            <text
              x={width - PADDING.right - 4} y={scaleY(target) - 4}
              fill="rgb(113,113,122)" fontSize={10} textAnchor="end"
            >
              target {fmtN(target)}
            </text>
          </>
        )}

        {/* X-axis labels */}
        {dateTicks.map((d, i) =>
          d ? (
            <text key={i} x={scaleX(i)} y={height - 12}
              fill="rgb(113,113,122)" fontSize={11} textAnchor="middle">{d}</text>
          ) : null,
        )}

        {/* Series */}
        {kind === 'line' ? (
          <>
            <polyline
              fill="none"
              stroke={color}
              strokeWidth={2.5}
              points={points.map((p, i) => `${scaleX(i)},${scaleY(p.value)}`).join(' ')}
            />
            {points.map((p, i) => (
              <circle key={i} cx={scaleX(i)} cy={scaleY(p.value)} r={3} fill={color} />
            ))}
          </>
        ) : (
          points.map((p, i) => {
            const y = scaleY(Math.max(0, Number(p.value) || 0));
            const baseY = scaleY(0);
            return (
              <rect
                key={i}
                x={scaleX(i) - barW / 2}
                y={Math.min(y, baseY)}
                width={barW}
                height={Math.abs(baseY - y)}
                fill={color}
                opacity={p.value ? 0.85 : 0.2}
              />
            );
          })
        )}

        {/* Hover crosshair + highlight */}
        {hoverP && (
          <g>
            <line
              x1={scaleX(hoverIdx)} x2={scaleX(hoverIdx)}
              y1={PADDING.top} y2={height - PADDING.bottom}
              stroke="rgb(161,161,170)" strokeWidth={1} strokeDasharray="3 3"
            />
            {kind === 'line' && (
              <circle cx={scaleX(hoverIdx)} cy={scaleY(hoverP.value)} r={5}
                fill={color} stroke="#fff" strokeWidth={1.5} />
            )}
          </g>
        )}
      </svg>

      {/* Tooltip — positioned over the SVG */}
      {hoverP && (
        <div
          className="absolute pointer-events-none bg-zinc-900 border border-zinc-700 rounded px-3 py-2 text-xs shadow-lg"
          style={{
            left: `calc(${(scaleX(hoverIdx) / width) * 100}% + 8px)`,
            top: 8,
            transform: scaleX(hoverIdx) / width > 0.8 ? 'translateX(-110%)' : undefined,
          }}
        >
          <div className="text-zinc-400">{fmtTs(hoverP.ts)}</div>
          <div className="text-zinc-100 text-base font-semibold">{fmtN(hoverP.value)}</div>
          {hoverP.label && <div className="text-zinc-500">{hoverP.label}</div>}
        </div>
      )}
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────

function niceTicks(min, max, count) {
  // Nice round numbers using the algorithm from Heckbert (Graphics Gems).
  const range = niceNum(max - min || 1, false);
  const step = niceNum(range / (count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step / 2; v += step) ticks.push(v);
  return ticks;
}
function niceNum(x, round) {
  const exp = Math.floor(Math.log10(x));
  const f = x / Math.pow(10, exp);
  let nf;
  if (round) {
    nf = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  } else {
    nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  }
  return nf * Math.pow(10, exp);
}
function fmtN(n) {
  if (n == null) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return (n / 1_000).toFixed(abs >= 10_000 ? 0 : 1) + 'k';
  return Math.round(n).toLocaleString();
}
function fmtDate(iso) {
  if (!iso) return '';
  return String(iso).slice(5, 10); // MM-DD
}
function fmtTs(iso) {
  if (!iso) return '';
  return String(iso).replace('T', ' ').slice(0, 16) + ' UTC';
}
