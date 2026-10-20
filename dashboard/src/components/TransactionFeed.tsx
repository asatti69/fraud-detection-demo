import { money } from '../format.ts';
import type { Outcome, ScoredEvent } from '../types.ts';

const ROWS = 5;

export const RESULT: Record<Outcome, { icon: string; text: string }> = {
  TP: { icon: '✓', text: 'Fraud caught' },
  FP: { icon: '!', text: 'False alarm' },
  FN: { icon: '▲', text: 'Fraud missed' },
  TN: { icon: '', text: 'Correct pass' },
};

export function rowClass(e: ScoredEvent): string {
  return [e.flagged && 'row-alert', e.outcome === 'FN' && 'row-missed'].filter(Boolean).join(' ');
}

export function ResultCell({ event }: { event: ScoredEvent }) {
  const r = RESULT[event.outcome];
  return (
    <td>
      {r.icon && <span className={`result-icon result-${event.outcome}`} aria-hidden="true">{r.icon}</span>}
      {r.text}
      {event.scripted && <span className="tag">Demo case</span>}
    </td>
  );
}

/** Newest transactions first; alerts highlighted. */
export function TransactionFeed({ events }: { events: ScoredEvent[] }) {
  const rows = events.slice(-ROWS).reverse();
  return (
    <div className="feed">
      <h3>Latest transactions</h3>
      <table className="compact">
        <thead>
          <tr>
            <th scope="col" className="num">Amount</th>
            <th scope="col" className="num">Score</th>
            <th scope="col">Decision</th>
            <th scope="col">Actually</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.seq} className={rowClass(e)}>
              <td className="num">{money(e.amount)}</td>
              <td className="num">{e.score.toFixed(2)}</td>
              <td>{e.flagged ? <span className="badge-alert">⚑ Alert</span> : 'Pass'}</td>
              <td>{e.label === 1 ? 'Fraud' : 'Legitimate'}</td>
              <ResultCell event={e} />
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="empty">Waiting for transactions…</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
