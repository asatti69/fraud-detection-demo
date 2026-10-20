import { money } from '../format.ts';
import type { ScoredEvent } from '../types.ts';
import { ResultCell, rowClass } from './TransactionFeed.tsx';

/** The last few alerts from the demo stream; they stay until newer alerts replace them. */
export function RecentAlerts({ alerts }: { alerts: ScoredEvent[] }) {
  const rows = [...alerts].reverse();
  return (
    <div className="feed">
      <div className="chart-head">
        <h3>Recent alerts</h3>
        <span className="muted">From the demo stream</span>
      </div>
      <table className="compact">
        <thead>
          <tr>
            <th scope="col" className="num">Amount</th>
            <th scope="col" className="num">Score</th>
            <th scope="col">Result</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.seq} className={rowClass(e)}>
              <td className="num">{money(e.amount)}</td>
              <td className="num">{e.score.toFixed(2)}</td>
              <ResultCell event={e} />
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={3} className="empty">No alerts yet</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
