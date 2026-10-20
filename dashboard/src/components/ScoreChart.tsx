import { useState } from 'react';
import { money } from '../format.ts';
import type { ScoredEvent } from '../types.ts';

const W = 900;
const H = 400;
const M = { top: 20, right: 128, bottom: 34, left: 64 };
const PLOT_W = W - M.left - M.right;
const PLOT_H = H - M.top - M.bottom;
const WINDOW = 90; // ~30 seconds at 3 transactions/second
const Y_MIN = 0.1;
const Y_MAX = 100;
const Y_TICKS = [0.1, 1, 10, 100];

const OUTCOME_TEXT = { TP: 'Fraud caught', FP: 'False alarm', FN: 'Fraud missed', TN: 'Correct pass' } as const;

function yScale(score: number): number {
  const v = Math.min(Y_MAX, Math.max(Y_MIN, score));
  const t = (Math.log10(v) - Math.log10(Y_MIN)) / (Math.log10(Y_MAX) - Math.log10(Y_MIN));
  return M.top + (1 - t) * PLOT_H;
}

function diamond(cx: number, cy: number, r: number): string {
  return `M${cx},${cy - r} L${cx + r},${cy} L${cx},${cy + r} L${cx - r},${cy} Z`;
}

/**
 * Live scores for the most recent transactions, on a log scale, with the alert threshold.
 * `whatIfThreshold` (from the sensitivity slider) is drawn as a second line; it is display-only,
 * so dot colors keep showing the API's live decisions at `threshold`.
 */
export function ScoreChart({ events, threshold, whatIfThreshold }: { events: ScoredEvent[]; threshold: number | null; whatIfThreshold: number | null }) {
  const [hovered, setHovered] = useState<ScoredEvent | null>(null);
  const visible = events.slice(-WINDOW);
  const lastSeq = visible.at(-1)?.seq ?? WINDOW;
  const firstSeq = lastSeq - WINDOW + 1;
  const x = (seq: number) => M.left + ((seq - firstSeq) / (WINDOW - 1)) * PLOT_W;
  const showWhatIf = whatIfThreshold !== null && threshold !== null && whatIfThreshold !== threshold;
  // Keep the two right-hand labels from overlapping when the thresholds are close.
  const liveLabelY = threshold !== null ? yScale(threshold) : 0;
  let whatIfLabelY = showWhatIf ? yScale(whatIfThreshold) : 0;
  if (showWhatIf && Math.abs(whatIfLabelY - liveLabelY) < 18) whatIfLabelY = liveLabelY + (whatIfLabelY >= liveLabelY ? 18 : -18);

  return (
    <figure className="chart">
      <figcaption className="chart-head">
        <h3>Live fraud scores</h3>
        <ul className="legend" aria-label="Legend">
          <li><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="5" className="mark-pass" /></svg>Passed</li>
          <li><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6" className="mark-alert" /></svg>Alerted</li>
          <li><svg width="18" height="18" aria-hidden="true"><path d={diamond(9, 9, 7)} className="mark-key" /></svg>Actually fraud</li>
          <li><svg width="22" height="16" aria-hidden="true"><line x1="1" x2="21" y1="8" y2="8" className="threshold-line" /></svg>{showWhatIf ? 'Live' : 'Alert threshold'}</li>
          {showWhatIf && (
            <li><svg width="22" height="16" aria-hidden="true"><line x1="1" x2="21" y1="8" y2="8" className="whatif-line" /></svg>What-if</li>
          )}
        </ul>
      </figcaption>
      <div className="chart-frame">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Fraud score of each recent transaction compared with the alert threshold">
          {Y_TICKS.map((t) => (
            <g key={t}>
              <line x1={M.left} x2={W - M.right} y1={yScale(t)} y2={yScale(t)} className="gridline" />
              <text x={M.left - 10} y={yScale(t)} className="tick" textAnchor="end" dominantBaseline="middle">{t}</text>
            </g>
          ))}
          <text transform={`translate(18 ${M.top + PLOT_H / 2}) rotate(-90)`} className="axis-title" textAnchor="middle">
            Fraud score (log scale)
          </text>
          <text x={M.left} y={H - 8} className="axis-title">older</text>
          <text x={W - M.right} y={H - 8} className="axis-title" textAnchor="end">newest →</text>

          {threshold !== null && (
            <g>
              <line x1={M.left} x2={W - M.right} y1={yScale(threshold)} y2={yScale(threshold)} className="threshold-line" />
              <text x={W - M.right + 10} y={liveLabelY} className="threshold-label" dominantBaseline="middle">
                {showWhatIf ? 'Live' : 'Threshold'} {threshold.toFixed(2)}
              </text>
            </g>
          )}
          {showWhatIf && (
            <g>
              <line x1={M.left} x2={W - M.right} y1={yScale(whatIfThreshold)} y2={yScale(whatIfThreshold)} className="whatif-line" />
              <text x={W - M.right + 10} y={whatIfLabelY} className="whatif-label" dominantBaseline="middle">
                What-if {whatIfThreshold.toFixed(2)}
              </text>
            </g>
          )}

          {visible.map((e) => {
            const cx = x(e.seq);
            const cy = yScale(e.score);
            const cls = e.flagged ? 'mark-alert' : 'mark-pass';
            return (
              <g key={e.seq} onMouseEnter={() => setHovered(e)} onMouseLeave={() => setHovered(null)}>
                {e.label === 1 ? <path d={diamond(cx, cy, e.flagged ? 10 : 8)} className={cls} /> : <circle cx={cx} cy={cy} r={e.flagged ? 7 : 4.5} className={cls} />}
                {e.scripted && (
                  <text x={cx} y={cy - 18} className="mark-label" textAnchor="middle">Demo case</text>
                )}
                <circle cx={cx} cy={cy} r={14} className="hit-area" />
              </g>
            );
          })}
          {visible.length === 0 && (
            <text x={W / 2} y={H / 2} className="empty" textAnchor="middle">Waiting for transactions…</text>
          )}
        </svg>
        {hovered && (
          <div
            className="tooltip"
            style={{ left: `${(x(hovered.seq) / W) * 100}%`, top: `${(yScale(hovered.score) / H) * 100}%` }}
          >
            <strong>#{hovered.seq} · {money(hovered.amount)}</strong>
            <span>Score {hovered.score.toFixed(2)}</span>
            <span>{OUTCOME_TEXT[hovered.outcome]}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
