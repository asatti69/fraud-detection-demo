import { useState } from 'react';
import type { MouseEvent } from 'react';
import { pct } from '../format.ts';
import type { TradeoffPoint } from '../metrics.ts';

const W = 600;
const H = 330;
const M = { top: 34, right: 128, bottom: 58, left: 60 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const X_MIN = 1e-4;
const X_MAX = 1e-1;
const X_TICKS = [1e-4, 1e-3, 1e-2, 1e-1];
const Y_TICKS = [0, 0.25, 0.5, 0.75, 1];

const xScale = (rate: number) => {
  const v = Math.min(X_MAX, Math.max(X_MIN, rate));
  return M.left + ((Math.log10(v) - Math.log10(X_MIN)) / (Math.log10(X_MAX) - Math.log10(X_MIN))) * PLOT_W;
};
const yScale = (share: number) => M.top + (1 - share) * PLOT_H;

const SERIES = [
  { key: 'casesCaught', label: 'Fraud cases', className: 'series-1' },
  { key: 'dollarsCaught', label: 'Fraud dollars', className: 'series-2' },
] as const;

/**
 * Share of fraud cases and fraud dollars caught vs. share of transactions flagged, across thresholds.
 * `selected` is the sensitivity slider's setting; the default (validation-chosen) threshold stays marked.
 */
export function TradeoffChart({ points, selected }: { points: TradeoffPoint[]; selected: TradeoffPoint }) {
  const [hover, setHover] = useState<TradeoffPoint | null>(null);
  const current = points.find((p) => p.current)!;
  const isWhatIf = !selected.current;
  const last = points.at(-1)!;

  const onMove = (e: MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    setHover(points.reduce((best, p) => (Math.abs(xScale(p.alertRate) - px) < Math.abs(xScale(best.alertRate) - px) ? p : best)));
  };

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <h3>Trade-off: catching more fraud means more alerts</h3>
        <ul className="legend" aria-label="Legend">
          {SERIES.map((s) => (
            <li key={s.key}><svg width="22" height="16" aria-hidden="true"><line x1="1" x2="21" y1="8" y2="8" className={`line ${s.className}`} /></svg>{s.label} caught</li>
          ))}
        </ul>
      </figcaption>
      <div className="chart-frame">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Share of fraud cases and fraud dollars caught at different alert rates, test data">
          {Y_TICKS.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={M.left + PLOT_W} y1={yScale(t)} y2={yScale(t)} className="gridline" />
              <text x={M.left - 10} y={yScale(t)} className="tick" textAnchor="end" dominantBaseline="middle">{pct(t)}</text>
            </g>
          ))}
          {X_TICKS.map((t) => (
            <text key={t} x={xScale(t)} y={M.top + PLOT_H + 22} className="tick" textAnchor="middle">{pct(t)}</text>
          ))}
          <text x={M.left + PLOT_W / 2} y={H - 8} className="axis-title" textAnchor="middle">Transactions flagged (log scale)</text>

          {isWhatIf && (
            <line x1={xScale(current.alertRate)} x2={xScale(current.alertRate)} y1={M.top} y2={M.top + PLOT_H} className="default-line" />
          )}
          <line x1={xScale(selected.alertRate)} x2={xScale(selected.alertRate)} y1={M.top - 6} y2={M.top + PLOT_H} className="current-line" />
          <text x={xScale(selected.alertRate)} y={M.top - 14} className="mark-label" textAnchor={xScale(selected.alertRate) > M.left + PLOT_W - 40 ? 'end' : 'middle'}>
            {isWhatIf ? 'What-if' : 'Default threshold'}
          </text>

          {SERIES.map((s) => (
            <g key={s.key}>
              <polyline points={points.map((p) => `${xScale(p.alertRate)},${yScale(p[s.key])}`).join(' ')} className={`line ${s.className}`} />
              {points.map((p) => (
                <circle key={p.alertRate} cx={xScale(p.alertRate)} cy={yScale(p[s.key])} r={p === selected ? 7 : 4} className={`dot ${s.className}`} />
              ))}
              <text x={xScale(last.alertRate) + 12} y={yScale(last[s.key])} className="end-label" dominantBaseline="middle">
                {s.label} {pct(last[s.key])}
              </text>
            </g>
          ))}

          {hover && <line x1={xScale(hover.alertRate)} x2={xScale(hover.alertRate)} y1={M.top} y2={M.top + PLOT_H} className="crosshair" />}
          <rect x={M.left} y={M.top} width={PLOT_W} height={PLOT_H} className="hit-area" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
        </svg>
        {hover && (
          <div className="tooltip" style={{ left: `${(xScale(hover.alertRate) / W) * 100}%`, top: `${(M.top / H) * 100}%` }}>
            <strong>{pct(hover.alertRate)} flagged{hover.current ? ' (default)' : ''}</strong>
            <span>Fraud cases caught: {pct(hover.casesCaught)}</span>
            <span>Fraud dollars caught: {pct(hover.dollarsCaught)}</span>
          </div>
        )}
      </div>
      <p className="muted chart-note">
        Each point is an alert threshold chosen on validation data and measured on the held-out test data.
      </p>
    </figure>
  );
}
